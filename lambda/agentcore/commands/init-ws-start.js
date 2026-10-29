import { runCredentialJob } from '../credential-session.js';
// init-ws-start — the async workspace initialization (the run-stage-start
// pattern applied to init-ws).
//
// The synchronous init-ws path holds the AgentCore request — and the
// orchestrator's durable step — open for the whole clone. A large repository
// (field incident: a 1.8 GB / 100k-commit GitLab repo) outlives the
// orchestrator Lambda's 900 s function timeout; the durable engine then
// retries init-ws against the half-written checkout. This command accepts the
// same payload as init-ws PLUS a `callbackId`, runs init-ws as a BACKGROUND
// job in the container, and returns in milliseconds. The orchestrator suspends
// on the durable callback at zero compute; the job completes it when init-ws
// returns.
//
// Reliability contract (mirrors run-stage-start):
//   - the accept response only says "job started"; the init verdict always
//     travels through the callback, in init-ws's own {ok, reason, detail}
//     shape — the orchestrator's existing decode applies unchanged;
//   - EVERY termination of the job sends a callback: success, init-ws's
//     ok:false failures, and uncaught throws (init_ws_job_crashed);
//   - the first heartbeat is sent BEFORE the clone starts, so a callback the
//     container cannot reach fails the dispatch synchronously;
//   - heartbeats fire while the clone runs so the orchestrator's
//     heartbeatTimeout separates "large repository" from "dead container";
//   - one init job per execution: the workspace is reserved before the first
//     heartbeat is awaited; a duplicate start for the SAME callback shares the
//     first dispatch's acceptance (durable dispatch retry), a different
//     callback is refused (init_job_already_running) — two clones must never
//     race into the same workspace directory, and a job only releases the
//     reservation it owns;
//   - the busy tracker is held for the job's lifetime so /ping reports
//     HealthyBusy and AgentCore keeps the session (and its mount) alive.

import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({
  persistentKeys: { component: 'agentcore', module: 'init-ws-start' },
});

const jobKey = (p) => `${p.executionId}:init-ws`;

// init-ws returns {ok:false, reason, detail} on every handled failure and
// {ok:true, ...} on success. Anything else is a contract break — surface it as
// a failure rather than letting the orchestrator mark the workspace ready.
export const normalizeInitResult = (result) => {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return { ok: false, reason: 'init_ws_no_result', detail: String(result) };
};

export const createInitWsStart = ({
  initWs,
  sendCallbackSuccess,
  sendCallbackHeartbeat,
  busy = null,
  heartbeatIntervalMs = 60_000,
  activeJobs = new Map(),
  log = logger,
}) => {
  const start = async (payload) => {
    const { callbackId, executionId } = payload ?? {};
    if (!callbackId) return { ok: false, reason: 'missing_callback_id' };
    if (!executionId) return { ok: false, reason: 'missing_execution_id' };

    const key = jobKey(payload);
    const inFlight = activeJobs.get(key);
    if (inFlight) {
      if (inFlight.callbackId !== callbackId) {
        return { ok: false, reason: 'init_job_already_running', detail: key };
      }
      // A duplicate of the same attempt shares the first dispatch's outcome,
      // including one whose initial heartbeat is still pending.
      const first = await inFlight.acceptance;
      return first.ok ? { ok: true, accepted: true, alreadyRunning: true, callbackId } : first;
    }

    // Reserve the workspace before the first await, so an overlapping
    // dispatch sees this attempt instead of starting a second clone.
    const jobState = { startedAt: Date.now(), callbackId, heartbeatTimer: null, acceptance: null };
    activeJobs.set(key, jobState);
    jobState.acceptance = accept(payload, key, jobState);
    return jobState.acceptance;
  };

  const release = (key, jobState) => {
    if (activeJobs.get(key) === jobState) activeJobs.delete(key);
  };

  const accept = async (payload, key, jobState) => {
    const { callbackId, executionId } = payload;
    let initialHeartbeat;
    try {
      initialHeartbeat = await sendCallbackHeartbeat(callbackId);
    } catch (err) {
      initialHeartbeat = { delivered: false, error: err?.message ?? String(err) };
    }
    if (!initialHeartbeat?.delivered) {
      release(key, jobState);
      log.error('init-ws callback heartbeat could not be established', {
        executionId,
        error: initialHeartbeat?.error ?? null,
      });
      return {
        ok: false,
        reason: 'init_ws_callback_heartbeat_failed',
        detail: initialHeartbeat?.error ?? null,
      };
    }

    busy?.enter();
    log.info('init-ws job accepted', { executionId });

    // The job payload is init-ws's own argument bag; the callback id is
    // transport, not an init-ws input.
    const initPayload = { ...payload };
    delete initPayload.callbackId;
    delete initPayload.command;

    const job = runCredentialJob(async () => {
      try {
        const scheduleHeartbeat = () => {
          jobState.heartbeatTimer = setTimeout(async () => {
            let sent;
            try {
              sent = await sendCallbackHeartbeat(callbackId);
            } catch (err) {
              sent = { delivered: false, error: err?.message ?? String(err) };
            }
            if (!sent?.delivered) {
              log.error('init-ws callback heartbeat failed', {
                executionId,
                error: sent?.error ?? null,
              });
            }
            if (activeJobs.get(key) === jobState) scheduleHeartbeat();
          }, heartbeatIntervalMs);
        };
        scheduleHeartbeat();

        let result;
        try {
          result = normalizeInitResult(await initWs(initPayload));
        } catch (err) {
          result = {
            ok: false,
            reason: 'init_ws_job_crashed',
            detail: err?.message ?? String(err),
          };
        }
        // The synchronous path logs failures in dispatchInvocation; a
        // background job bypasses it, so keep the same diagnosable record.
        if (result.ok === false) {
          log.warn('command returned failure', {
            command: 'init-ws-start',
            executionId,
            reason: result.reason,
            detail: result.detail,
          });
        } else {
          log.info('init-ws job completed', {
            executionId,
            durationMs: Date.now() - jobState.startedAt,
          });
        }

        const sent = await sendCallbackSuccess(callbackId, result);
        if (!sent?.delivered) {
          // The orchestrator's callback timeout / heartbeatTimeout is the
          // backstop; log loudly so an operator can complete it manually.
          log.error('init-ws callback could not be delivered', {
            executionId,
            error: sent?.error ?? null,
          });
        }
        return result;
      } finally {
        if (jobState.heartbeatTimer) clearTimeout(jobState.heartbeatTimer);
        release(key, jobState);
        busy?.leave();
      }
    });
    job.catch((err) =>
      log.error('init-ws job promise rejected unexpectedly', {
        executionId,
        error: err?.message ?? String(err),
      }),
    );

    return { ok: true, accepted: true, callbackId, jobKey: key };
  };

  start.activeJobs = activeJobs;
  return start;
};
