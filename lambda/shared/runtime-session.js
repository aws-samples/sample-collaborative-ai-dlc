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
//            never swallowed and never thrown: it is queued on the shared
//            session-cleanup store so a poller retries it until the volume is
//            gone or confirmed absent. Callers therefore do not need to keep
//            their own state alive to make the release retryable.
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

const sdkTarget = (target) => ({
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

export const stopSessions = async ({ client, target, sessionIds = [] }) => {
  const results = [];
  for (const sessionId of new Set(sessionIds)) {
    results.push({ sessionId, ...(await stopSession({ client, target, sessionId })) });
  }
  return results;
};

// Release one session's persistent workspace. Returns one of:
//   { released: true }                     delete succeeded
//   { released: true, absent: true }       session already gone
//   { released: false, skipped: true }     nothing to release (no provider)
//   { released: false, queued: true }      delete failed; queued for retry
//   { released: false, queued: false }     delete failed AND the queue write
//                                          failed — logged at error level, the
//                                          volume may leak until an operator acts
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
  try {
    await client.send(new DeleteCapacityProviderSessionCommand({ capacityProviderId, sessionId }));
    return { released: true };
  } catch (error) {
    if (SESSION_ABSENT_ERRORS.has(error?.name)) {
      return { released: true, absent: true };
    }
    const reason = error?.message ?? String(error);
    logger.warn('release-runtime-session failed — queued for retry', { sessionId, source, reason });
    if (!cleanupStore) return { released: false, queued: false, reason };
    try {
      await cleanupStore.enqueue({ sessionId, capacityProviderArn, source, reason, context });
      return { released: false, queued: true, reason };
    } catch (persistError) {
      logger.error('release-runtime-session: failed to queue cleanup work', persistError, {
        sessionId,
        capacityProviderArn,
      });
      return { released: false, queued: false, reason };
    }
  }
};

// Stop, then release, every session in the set. This is what "the intent is
// gone" means for its workspaces. Never throws.
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
  for (const sessionId of ids) {
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
  }
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
    // No cleanupStore here on purpose: a retry that fails must bump the
    // existing record, not overwrite it with attempts = 0.
    const outcome = await releaseSession({
      client,
      capacityProviderArn: record.capacityProviderArn,
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
  SESSION_ABSENT_ERRORS,
  capacityProviderIdFromArn,
  stopSession,
  stopSessions,
  releaseSession,
  releaseSessions,
  retryQueuedReleases,
};
