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
// same stage is still clearing.
const jobKey = (p) => `${p.executionId}:${p.stageId}:${p.resumeFrom ?? 'fresh'}`;

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

    activeJobs.set(key, { startedAt: Date.now(), stageCallbackId });
    busy?.enter();

    const job = (async () => {
      let heartbeatTimer = null;
      try {
        heartbeatTimer = setInterval(() => {
          sendCallbackHeartbeat(stageCallbackId).catch(() => {});
        }, heartbeatIntervalMs);
        // Node may keep the process alive for the interval otherwise; the
        // container's HTTP server owns process lifetime, not this job.
        heartbeatTimer.unref?.();

        let result;
        try {
          result = normalizeStageResult(await runStage(payload));
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
        if (heartbeatTimer) clearInterval(heartbeatTimer);
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
