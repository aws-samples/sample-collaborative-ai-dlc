// Runtime session lifecycle — the ONE place that knows what "stop" and
// "release" mean for an AgentCore runtime session, on every compute type.
//
//   stop     End the compute (microVM or EC2 instance) but keep the session's
//            persistent workspace. On microVMs the service reaps session
//            storage on its own schedule; on Instances the EBS volume is
//            retained and re-attached when the same session id is invoked
//            again. Best-effort, never throws.
//
//   release  Stop AND drop the persistent workspace. Only meaningful on the
//            Instances compute type (DeleteCapacityProviderSession); a no-op
//            when the target has no capacity provider. A failed delete is
//            handed off to the shared session-cleanup store, which a poller
//            retries until the volume is gone or confirmed absent.
//
// OWNERSHIP CONTRACT. Whoever holds a session id (a revision row, an intent
// partition) owns that session's cleanup. release() returns only once the
// ownership has been DISCHARGED — the session is deleted, confirmed absent, or
// durably queued — and throws SessionReleaseHandoffError otherwise. Callers
// may drop their copy of the identity only after release() returns; on the
// error they must keep it so the release can be retried from their side.
//
// ---------------------------------------------------------------------------
// VOLUME RETENTION POLICY (explicit — see docs/using-the-platform/managed-environments.md)
//
//   Event                                  Operation   Workspace volume
//   -------------------------------------  ----------  --------------------------
//   Stage parked / lane finished           stop        retained (resume re-attaches)
//   Run ends (SUCCEEDED / CANCELLED)       stop        retained (rewind relaunches
//                                                      into the same workspace)
//   Rewind / relaunch                      stop        retained (re-attached by id)
//   Intent permanently deleted             release     deleted with the intent
//   Environment validation session ends    release     deleted (disposable session)
//
// Rationale: a workspace is part of the intent's state for as long as the
// intent exists — a finished run can still be rewound and a parked stage
// resumed, both of which rely on the checkout and conversation state on the
// volume. The volume's lifetime is therefore bound to the intent's lifetime,
// not to any individual run, and the cost of a retained volume is the price of
// keeping that state recoverable. Validation sessions have no such owner and
// are released immediately. An idle-volume TTL is a possible future refinement;
// it would plug in here as a third operation without touching the callers.
// ---------------------------------------------------------------------------

import { mapWithConcurrency } from './concurrency.js';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  DeleteCapacityProviderSessionCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const logger = new Logger({ persistentKeys: { component: 'runtime-session' } });

// DeleteCapacityProviderSession outcomes that mean the session (and its volume)
// is already gone. That is a completed release, not a failure: the id sets the
// callers build are supersets of what actually ran.
export const SESSION_ABSENT_ERRORS = new Set(['ResourceNotFoundException', 'ValidationException']);

// arn:<partition>:bedrock-agentcore:<region>:<account>:capacity-provider/<id>
export const capacityProviderIdFromArn = (arn) => {
  const id = String(arn ?? '')
    .split('/')
    .pop();
  return id || null;
};

// The AgentCore SDK input for a runtime target (drops capacityProviderArn).
export const sdkTarget = (target) => ({
  agentRuntimeArn: target.agentRuntimeArn,
  ...(target.qualifier ? { qualifier: target.qualifier } : {}),
});

// Stop one session. Never throws: an already-stopped or never-started session
// must not block the caller (cancel, rewind, park, delete all tolerate it).
export const stopSession = async ({ client, target, sessionId }) => {
  if (!client || !target?.agentRuntimeArn || !sessionId) return { stopped: false, skipped: true };
  try {
    await client.send(
      new StopRuntimeSessionCommand({ ...sdkTarget(target), runtimeSessionId: sessionId }),
    );
    return { stopped: true };
  } catch (error) {
    logger.warn('stop-runtime-session best-effort miss', {
      sessionId,
      error: error?.message ?? String(error),
    });
    return { stopped: false, error: error?.message ?? String(error) };
  }
};

// Stops run concurrently (up to 8 in flight): a section rewind stops the intent
// session plus every lane session, and each stop is an independent API call.
export const stopSessions = async ({ client, target, sessionIds = [] }) =>
  mapWithConcurrency([...new Set(sessionIds)], 8, async (sessionId) => ({
    sessionId,
    ...(await stopSession({ client, target, sessionId })),
  }));

// Raised when a release could not be discharged: the delete failed AND the
// durable hand-off to the cleanup store failed (or no store was provided).
// The caller is still the only owner of the listed sessions.
export class SessionReleaseHandoffError extends Error {
  constructor(sessionIds, cause) {
    super(
      `Workspace release for ${sessionIds.length} session(s) could not be completed or queued — ` +
        'the caller keeps ownership and must retry',
      { cause },
    );
    this.name = 'SessionReleaseHandoffError';
    this.code = 'SESSION_RELEASE_HANDOFF_FAILED';
    this.sessionIds = sessionIds;
  }
}

// One DeleteCapacityProviderSession attempt. Never throws; an already-gone
// session is a completed release.
const attemptDelete = async ({ client, capacityProviderId, sessionId }) => {
  try {
    await client.send(new DeleteCapacityProviderSessionCommand({ capacityProviderId, sessionId }));
    return { released: true };
  } catch (error) {
    if (SESSION_ABSENT_ERRORS.has(error?.name)) return { released: true, absent: true };
    return { released: false, reason: error?.message ?? String(error) };
  }
};

// Release one session's persistent workspace. Returns one of:
//   { released: true }                     delete succeeded
//   { released: true, absent: true }       session already gone
//   { released: false, skipped: true }     nothing to release (no provider)
//   { released: false, queued: true }      delete failed; the cleanup store
//                                          now owns the retry
// and throws SessionReleaseHandoffError when neither the delete nor the
// hand-off succeeded — see the ownership contract at the top of this file.
export const releaseSession = async ({
  client,
  capacityProviderArn,
  sessionId,
  cleanupStore = null,
  source = null,
  context = {},
}) => {
  const capacityProviderId = capacityProviderIdFromArn(capacityProviderArn);
  if (!client || !capacityProviderId || !sessionId) return { released: false, skipped: true };
  const outcome = await attemptDelete({ client, capacityProviderId, sessionId });
  if (outcome.released) return outcome;
  const { reason } = outcome;
  if (!cleanupStore) throw new SessionReleaseHandoffError([sessionId], new Error(reason));
  try {
    await cleanupStore.enqueue({ sessionId, capacityProviderArn, source, reason, context });
  } catch (persistError) {
    logger.error('release-runtime-session: delete and cleanup hand-off both failed', persistError, {
      sessionId,
      capacityProviderArn,
      source,
      reason,
    });
    throw new SessionReleaseHandoffError([sessionId], persistError);
  }
  logger.warn('release-runtime-session failed — queued for retry', { sessionId, source, reason });
  return { released: false, queued: true, reason };
};

// Stop, then release, every session in the set. This is what "the intent is
// gone" means for its workspaces. Every session is attempted; if any could not
// be discharged, one SessionReleaseHandoffError lists them all (the others are
// already deleted or queued, and repeating them is idempotent).
export const releaseSessions = async ({
  client,
  target,
  sessionIds = [],
  cleanupStore = null,
  source = null,
  context = {},
}) => {
  const ids = [...new Set(sessionIds)];
  await stopSessions({ client, target, sessionIds: ids });
  if (!target?.capacityProviderArn) return ids.map((sessionId) => ({ sessionId, skipped: true }));
  const results = [];
  const undischarged = [];
  let lastError = null;
  for (const sessionId of ids) {
    try {
      results.push({
        sessionId,
        ...(await releaseSession({
          client,
          capacityProviderArn: target.capacityProviderArn,
          sessionId,
          cleanupStore,
          source,
          context,
        })),
      });
    } catch (error) {
      if (!(error instanceof SessionReleaseHandoffError)) throw error;
      undischarged.push(sessionId);
      lastError = error.cause ?? error;
    }
  }
  if (undischarged.length) throw new SessionReleaseHandoffError(undischarged, lastError);
  return results;
};

// Retry every queued release. The record is removed only after the delete
// succeeds or the session is confirmed absent; any other failure keeps it and
// bumps the attempt counter for observability. Unactionable records (no
// provider identity) are dropped. Never throws.
export const retryQueuedReleases = async ({ client, cleanupStore }) => {
  const pending = await cleanupStore.listPending();
  const results = [];
  for (const record of pending) {
    const { sessionId } = record;
    if (!capacityProviderIdFromArn(record.capacityProviderArn)) {
      await cleanupStore.remove(sessionId);
      results.push({ sessionId, dropped: true });
      continue;
    }
    // A bare delete attempt: the record already owns the retry, so a failure
    // bumps it instead of re-queueing (which would reset attempts to 0).
    const outcome = await attemptDelete({
      client,
      capacityProviderId: capacityProviderIdFromArn(record.capacityProviderArn),
      sessionId,
    });
    if (outcome.released) {
      await cleanupStore.remove(sessionId);
      results.push({ sessionId, cleaned: true, ...(outcome.absent ? { absent: true } : {}) });
      continue;
    }
    logger.warn('Session release retry failed — kept for the next poll', {
      sessionId,
      attempts: (record.attempts ?? 0) + 1,
      error: outcome.reason,
    });
    await cleanupStore.recordAttempt(sessionId, outcome.reason).catch(() => {});
    results.push({ sessionId, cleaned: false });
  }
  return results;
};

export default {
  SessionReleaseHandoffError,
  SESSION_ABSENT_ERRORS,
  capacityProviderIdFromArn,
  stopSession,
  stopSessions,
  releaseSession,
  releaseSessions,
  retryQueuedReleases,
};
