// run-stage-start — the async stage invocation (docs/v2-parallel.md WP1).
//
// The synchronous run-stage path holds the AgentCore HTTP request (and the
// orchestrator's durable step) open for the stage's whole duration, which
// collides with AgentCore's hard 15-minute synchronous request timeout and the
// orchestrator Lambda's 900s function timeout. This command accepts the same
// payload as run-stage PLUS a `stageCallbackId`, kicks the stage off as a
// BACKGROUND job in the container, and returns in milliseconds. The
// orchestrator suspends on the durable callback at zero compute; the job
// completes it (SendDurableExecutionCallbackSuccess) when the stage exits.
//
// Reliability contract:
//   - the accept response only says "job started" — the stage verdict always
//     travels through the callback (a worker's own success claim is never the
//     verdict; sensors inside run-stage remain the authority);
//   - EVERY termination of the job sends a callback: success, run-stage's
//     ok:false failures, and uncaught throws (normalized to state FAILED /
//     reason stage_job_crashed) — the orchestrator never deadlocks on a crash;
//   - heartbeats fire while the job runs so the orchestrator's
//     heartbeatTimeout distinguishes "long stage" from "dead container";
//   - a duplicate start for the same stage attempt is rejected
//     (job_already_running) — one CLI run per workspace per attempt;
//   - the busy tracker is held for the job's lifetime so /ping reports
//     HealthyBusy and AgentCore keeps the session (microVM + mount) alive.
//
// Traceability: the callbackId rides the payload into run-stage, which stamps
// it on the STAGE row (stageCallbackId) — who is waiting on what is always
// recoverable from the row, and a stuck callback can be completed manually.

// Key one in-flight stage attempt. resumeFrom distinguishes park/resume legs —
// a resume may legitimately start while bookkeeping for the parked leg of the
// same stage is still clearing. unitSlug distinguishes lanes: the same stage
// runs once per unit under fan-out (docs/v2-parallel.md WP4), and two lanes'
// instances of one stage are different jobs, never duplicates.
const jobKey = (p) =>
  `${p.executionId}:${p.stageId}:${p.unitSlug ?? '-'}:${p.resumeFrom ?? 'fresh'}`;

// Normalize the run-stage return contract for the orchestrator's single decode
// path: run-stage's failures are `{ok:false, reason, detail}` WITHOUT a state
// field — the callback result always carries one.
export const normalizeStageResult = (result) => {
  if (result && typeof result === 'object') {
    if (result.state) return result;
    return { ...result, state: result.ok === false ? 'FAILED' : 'SUCCEEDED' };
  }
  return { ok: false, state: 'FAILED', reason: 'stage_no_result', detail: String(result) };
};

export const createRunStageStart = ({
  runStage,
  sendCallbackSuccess,
  sendCallbackHeartbeat,
  busy = null,
  heartbeatIntervalMs = 60_000,
  activeJobs = new Map(),
  log = (...args) => console.error('[run-stage-start]', ...args),
}) => {
  const start = async (payload) => {
    const { stageCallbackId, executionId, stageId } = payload ?? {};
    if (!stageCallbackId) {
      return { ok: false, reason: 'missing_stage_callback_id' };
    }
    if (!executionId || !stageId) {
      return { ok: false, reason: 'missing_stage_identity' };
    }
    const key = jobKey(payload);
    const inFlight = activeJobs.get(key);
    if (inFlight) {
      if (inFlight.stageCallbackId === stageCallbackId) {
        // Idempotent accept: the dispatch step can be retried by the durable
        // engine after a lost response — the SAME attempt (same callbackId)
        // is already running, so acknowledge rather than fail the stage.
        return { ok: true, accepted: true, alreadyRunning: true, stageId, stageCallbackId };
      }
      // A DIFFERENT attempt for the same stage is genuinely conflicting: one
      // CLI run per workspace per stage attempt. Refuse, don't stack.
      return { ok: false, reason: 'job_already_running', detail: key };
    }

    // Establish callback liveness before launching an expensive agent. The old
    // fire-and-forget interval could accept a job even when no heartbeat ever
    // reached Lambda, leaving useful work to be discarded exactly at the
    // heartbeat deadline. This first beat makes that failure synchronous and
    // visible to the orchestrator.
    let initialHeartbeat;
    try {
      initialHeartbeat = await sendCallbackHeartbeat(stageCallbackId);
    } catch (err) {
      initialHeartbeat = { delivered: false, error: err?.message ?? String(err) };
    }
    if (!initialHeartbeat?.delivered) {
      log(`FAILED to establish stage callback heartbeat for ${key}:`, initialHeartbeat?.error);
      return {
        ok: false,
        reason: 'stage_callback_heartbeat_failed',
        detail: initialHeartbeat?.error ?? null,
      };
    }

    const jobState = {
      startedAt: Date.now(),
      stageCallbackId,
      heartbeatCount: 1,
      lastHeartbeatAt: Date.now(),
      heartbeatTimer: null,
    };
    activeJobs.set(key, jobState);
    busy?.enter();
    log(`stage callback heartbeat established for ${key}`);

    // Agent launching time (cold start): orchestrator dispatch → job accepted
    // HERE. Computed at accept (before any workspace/CLI work) and threaded
    // into run-stage, which records it as an `agentLaunchMs` metric sample
    // once the stage identity (stageInstanceId) exists. Null when the
    // dispatcher sent no anchor (old orchestrator) or clocks skewed negative.
    const launchMs = payload.dispatchedAt ? Date.now() - Date.parse(payload.dispatchedAt) : NaN;
    const jobPayload =
      Number.isFinite(launchMs) && launchMs >= 0
        ? { ...payload, agentLaunchMs: launchMs }
        : payload;

    const job = (async () => {
      let heartbeatTimer = null;
      try {
        const scheduleHeartbeat = () => {
          heartbeatTimer = setTimeout(async () => {
            let sent;
            try {
              sent = await sendCallbackHeartbeat(stageCallbackId);
            } catch (err) {
              sent = { delivered: false, error: err?.message ?? String(err) };
            }
            if (sent?.delivered) {
              jobState.heartbeatCount += 1;
              jobState.lastHeartbeatAt = Date.now();
              if (jobState.heartbeatCount % 5 === 0) {
                log(
                  `stage callback heartbeat delivered for ${key} (${jobState.heartbeatCount} total)`,
                );
              }
            } else {
              log(`FAILED stage callback heartbeat for ${key}:`, sent?.error);
            }
            if (activeJobs.get(key) === jobState) scheduleHeartbeat();
          }, heartbeatIntervalMs);
          // Keep the heartbeat referenced. AgentCore may suspend an invocation
          // after the accept response; an unreferenced timer is not a reliable
          // liveness mechanism for the detached stage job.
          jobState.heartbeatTimer = heartbeatTimer;
        };
        scheduleHeartbeat();

        let result;
        try {
          result = normalizeStageResult(await runStage(jobPayload));
        } catch (err) {
          // run-stage can throw on unwrapped store/S3 failures — the callback
          // must still complete or the orchestrator waits for the heartbeat
          // timeout for nothing.
          log(`stage job crashed (${key}):`, err?.message ?? err);
          result = {
            ok: false,
            state: 'FAILED',
            reason: 'stage_job_crashed',
            detail: err?.message ?? String(err),
          };
        }

        const sent = await sendCallbackSuccess(stageCallbackId, result);
        if (!sent?.delivered) {
          // Nothing more we can do from here — the orchestrator's callback
          // timeout/heartbeatTimeout is the backstop. Log loudly for ops.
          log(`FAILED to deliver stage callback for ${key}:`, sent?.error);
        }
        return result;
      } finally {
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        activeJobs.delete(key);
        busy?.leave();
      }
    })();
    // Surfacing job rejections: the job function never rejects (all paths are
    // caught), but guard anyway so an unexpected bug can't crash the process.
    job.catch((err) => log(`stage job promise rejected unexpectedly (${key}):`, err?.message));

    return {
      ok: true,
      accepted: true,
      stageId,
      stageCallbackId,
      // Exposed for tests and for operators inspecting the accept response.
      jobKey: key,
    };
  };

  // Test/ops seam: observe in-flight jobs.
  start.activeJobs = activeJobs;
  return start;
};
