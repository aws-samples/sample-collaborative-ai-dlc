// Intent deletion cascade — shared by the intents lambda (single-intent DELETE)
// and the projects lambda (project delete, which cascades into every child
// intent). Purges, in a deliberate retry-safe order, everything an intent owns:
//
//   Yjs realtime docs  →  Neptune subgraph (two-pass, intent_id-guarded)  →
//   the entire EXEC#<id> DynamoDB partition (META, STAGE#, EVENT#, HUMAN#,
//   METRIC#, OUTPUT#, SENSOR#, STEER#, UNITPLAN, UNIT#) LAST.
//
// DynamoDB META goes last so that until it succeeds the intent still lists and
// the whole delete can simply be re-run. Metrics are METRIC# rows inside that
// partition, so they are removed with it — there is no separate metric store
// and no S3 in the intent data path.
//
// The cross-intent guards (`.has('intent_id', intentId)`) mirror the fix in
// commit c8ef5ec: an artifact/section vertex a SIBLING intent owns (same
// agent-chosen id) is never dropped for this intent.

import gremlin from 'gremlin';
import { Logger } from '@aws-lambda-powertools/logger';
import { SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { revokeYjsScope } from './yjs-revocation.js';
import { resolveRuntimeTarget } from './runtime-target.js';
import { releaseSessions } from './runtime-session.js';
import {
  composeSessionIdFor,
  discussionSessionIdFor,
  intentSessionIdFor,
  laneSessionIdFor,
  quorumEditSessionIdFor,
} from './runtime-session-ids.js';

const logger = new Logger({ persistentKeys: { component: 'intent-deletion' } });
const __ = gremlin.process.statics;
const s3 = new S3Client({});

const purgeAttachmentPrefix = async (bucket, prefix) => {
  if (!bucket) return;
  let KeyMarker;
  let VersionIdMarker;
  do {
    const versions = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }),
    );
    const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(
      (version) => ({ Key: version.Key, VersionId: version.VersionId }),
    );
    if (objects.length) {
      const deleted = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
      );
      if (deleted.Errors?.length) {
        throw new Error(
          `S3 rejected ${deleted.Errors.length} attachment object deletion(s) under ${prefix}`,
        );
      }
    }
    KeyMarker = versions.NextKeyMarker;
    VersionIdMarker = versions.NextVersionIdMarker;
    if (!versions.IsTruncated) break;
  } while (KeyMarker);
};

// Session-id conventions live in shared/runtime-session-ids.js, the module the
// producers (orchestrator, intents, discussions) derive them from.
const runtimeSessionIdFor = intentSessionIdFor;

// A caller-recognizable error for a live run refused without `force`. The
// intents lambda maps this to a 409; the projects lambda passes force:true so it
// never fires there.
class IntentRunningError extends Error {
  constructor(intentId) {
    super(`Intent ${intentId} is RUNNING, cannot delete`);
    this.name = 'IntentRunningError';
    this.code = 'INTENT_RUNNING';
    this.intentId = intentId;
  }
}

// Every session an intent may have opened on the Instances compute type,
// rebuilt from records that are written BEFORE the session they name is first
// invoked, so each session has a cleanup owner from its start:
//
//   main      always (deterministic per intent)
//   lanes     UNIT# rows: the orchestrator stamps each lane's sessionId when
//             the lane starts, and the rows survive plan rewinds — historical
//             and orphaned lanes are still covered. A row without a stamped id
//             falls back to its persisted sectionIndex + slug, and lane STAGE#
//             rows (sectionIndex + unitSlug) contribute the same derivation.
//   compose   COMPOSE# rows (created before the compose dispatch)
//   Quorum    one per intent, reused by every edit; present once a QEDIT# row
//   edit      exists (created before the orchestrator hand-off)
//   discuss   one per Discussion vertex of the intent (created before any
//             assist on it) — passed in by the caller, see
//             collectDiscussionIds
//
// The result is a superset — callers tolerate deleting or stopping a session
// that never existed. Intent-bound sessions are retained until this point (a
// reused id cannot be restarted once deleted on Instances), never released
// earlier.
const collectIntentSessionIds = (intentId, records = {}, { discussionIds = [] } = {}) => {
  const ids = new Set([runtimeSessionIdFor(intentId)]);
  for (const unit of records.units ?? []) {
    if (typeof unit.sessionId === 'string' && unit.sessionId.length > 0) {
      ids.add(unit.sessionId);
    } else if (Number.isInteger(unit.sectionIndex) && unit.slug) {
      ids.add(laneSessionIdFor(intentId, unit.sectionIndex, unit.slug));
    }
  }
  for (const stage of records.stages ?? []) {
    if (Number.isInteger(stage.sectionIndex) && stage.unitSlug) {
      ids.add(laneSessionIdFor(intentId, stage.sectionIndex, stage.unitSlug));
    }
  }
  for (const compose of records.composes ?? []) {
    if (compose.composeId) ids.add(composeSessionIdFor(compose.composeId));
  }
  if ((records.quorumEdits ?? []).length > 0) ids.add(quorumEditSessionIdFor(intentId));
  for (const discussionId of discussionIds) {
    if (discussionId) ids.add(discussionSessionIdFor(intentId, discussionId));
  }
  return [...ids];
};

// The intent's discussion threads, read from the graph before the cascade drops
// them: the threads hanging off the Intent anchor plus any vertex that names
// the intent directly (a thread whose anchor edge is gone).
const collectDiscussionIds = async (g, intentId) => {
  const [anchored, named] = await Promise.all([
    g.V().has('Intent', 'id', intentId).out('HAS_DISCUSSION').values('id').toList(),
    g.V().has('Discussion', 'intent_id', intentId).values('id').toList(),
  ]);
  return [...new Set([...(anchored ?? []), ...(named ?? [])])];
};

// The runtime target for the cascade: the META snapshot (runtime + capacity
// provider) unless the caller passed an explicit override, which older callers
// do either as a target object or as a bare runtime ARN.
const resolveRuntimeTargetForDeletion = (meta, override, legacyArn) => {
  const fromMeta = resolveRuntimeTarget(meta, typeof legacyArn === 'string' ? legacyArn : '');
  if (!override) return fromMeta;
  if (typeof override === 'string') return { ...fromMeta, agentRuntimeArn: override };
  return { ...fromMeta, ...override };
};

// Retire a parked run before deleting: supersede every still-pending gate (CAS —
// answered gates stay as the Q&A record), then wake any suspended callback with
// a cancel sentinel. The woken orchestrator re-reads its gate, sees `superseded`
// and exits WITHOUT touching META, so the retire can never race anything.
// Best-effort per gate.
const retireParkedRun = async ({ store, lambdaClient, executionId, reason }) => {
  const records = await store.getExecutionRecords(executionId, { includeOutputs: false });
  const pending = (records.humanTasks ?? []).filter((h) => h.status === 'pending');
  for (const gate of pending) {
    const superseded = await store
      .supersedeHumanTask({
        executionId,
        humanTaskId: gate.humanTaskId,
        supersededBy: reason,
      })
      .catch((err) => {
        logger.error('Gate supersede failed', err);
        return null;
      });
    if (superseded && gate.callbackId && lambdaClient) {
      await lambdaClient
        .send(
          new SendDurableExecutionCallbackSuccessCommand({
            CallbackId: gate.callbackId,
            Result: Buffer.from(JSON.stringify({ cancelled: true, reason })),
          }),
        )
        .catch((err) => logger.error('Cancel callback send failed', err));
    }
  }
};

// Delete one intent's entire footprint. Dependencies are injected so both
// lambdas (with their own clients) can reuse this. Returns nothing; throws only
// on a real failure (Neptune/DynamoDB error, or IntentRunningError when a live
// run is refused without force) so the caller can surface a retryable error.
//
// Params:
//   g                    – gremlin traversal (already partition-scoped)
//   store                – v2 process store
//   ddb                  – DynamoDBDocument client (Yjs deletes)
//   agentcore            – BedrockAgentCore client (optional; session stop/release)
//   lambdaClient         – Lambda client (optional; durable callback on retire)
//   intentId             – the intent/execution id (they are equal)
//   meta                 – the execution META row (status + environment snapshot,
//                          which carries the runtime target and, on Instances,
//                          the capacity provider that owns the workspaces)
//   yjsTable             – Yjs documents table name (optional)
//   agentcoreRuntimeTarget – explicit runtime target override (optional; the
//                          snapshot on META is the default source)
//   sessionCleanupStore  – shared/session-cleanup-store (optional); a workspace
//                          release that fails is queued there for the
//                          environments poller to retry
//   actor                – human-readable actor for the retire reason
//   force                – when true, a RUNNING run is retired+stopped and
//                          deleted anyway (project delete); when false a RUNNING
//                          run throws IntentRunningError (single intent delete).
const deleteIntentCascade = async ({
  g,
  store,
  ddb,
  agentcore = null,
  lambdaClient = null,
  intentId,
  meta,
  yjsTable = null,
  cleanupDeadline,
  agentcoreRuntimeTarget = null,
  agentcoreRuntimeArn = null,
  sessionCleanupStore = null,
  actor = 'a project member',
  artifactsBucket = null,
  force = false,
}) => {
  if (meta?.status === 'RUNNING' && !force) {
    throw new IntentRunningError(intentId);
  }

  await revokeYjsScope({
    ddb,
    table: yjsTable,
    type: 'intent',
    id: intentId,
    bucket: artifactsBucket,
    deadline: cleanupDeadline,
  });
  await Promise.all([
    purgeAttachmentPrefix(artifactsBucket, `intent-attachments/committed/${intentId}/`),
    purgeAttachmentPrefix(artifactsBucket, `intent-attachments/staging/${intentId}/`),
    purgeAttachmentPrefix(artifactsBucket, `workflow-exports/${intentId}/`),
  ]);

  // Retire anything that could still wake up (same mechanics as cancel), then
  // stop every session so nothing writes into the deleted partition. A
  // DRAFT/SUCCEEDED/CANCELLED run has nothing parked to retire.
  const reason = `deleted by ${actor}`;
  if (!['DRAFT', 'SUCCEEDED', 'CANCELLED'].includes(meta?.status)) {
    await retireParkedRun({ store, lambdaClient, executionId: intentId, reason });
  }
  // Permanent deletion is the ONE moment an intent's workspaces are released
  // (see the retention policy in shared/runtime-session.js): the session set is
  // rebuilt from the persisted UNIT#/STAGE# rows and every session is stopped
  // and — on the Instances compute type — deleted so its EBS volume goes with
  // the intent. Releasing a session that never started is a tolerated miss; a
  // release that fails is handed off to the shared cleanup store and retried by
  // the environments poller. This partition is the sessions' owner until then:
  // if a hand-off itself fails, releaseSessions throws HERE — before the
  // records are deleted below — so the identities survive and the delete can be
  // re-run.
  const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
  const target = resolveRuntimeTargetForDeletion(meta, agentcoreRuntimeTarget, agentcoreRuntimeArn);
  await releaseSessions({
    client: agentcore,
    target,
    sessionIds: collectIntentSessionIds(intentId, records, {
      discussionIds: await collectDiscussionIds(g, intentId),
    }),
    cleanupStore: sessionCleanupStore,
    source: 'intent-deletion',
    context: { intentId, projectId: meta?.projectId ?? null },
  });

  // Neptune cascade, in TWO passes because drop() consumes eagerly — a
  // grandchild reached THROUGH a vertex that the same traversal also drops can
  // become unreachable mid-drop (its edge is already gone).
  //
  // Pass 1 — immutable artifact versions plus the derived layer. Versions are
  // reached through their stable head and must be removed before that head;
  // sections/items are similarly reached through the artifact.
  await g
    .V()
    .has('Intent', 'id', intentId)
    .out('HAS_CHECKPOINT_VERSION')
    .hasLabel('ArtifactVersion')
    .has('intent_id', intentId)
    .drop()
    .next();

  await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .has('intent_id', intentId)
    .hasLabel('Artifact')
    .out('HAS_VERSION')
    .hasLabel('ArtifactVersion')
    .has('intent_id', intentId)
    .drop()
    .next();

  await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .has('intent_id', intentId)
    .hasLabel('Artifact')
    .out('HAS_SECTION', 'HAS_ITEM')
    .has('intent_id', intentId)
    .drop()
    .next();

  // Pass 2 — the anchor + its direct children (one union, the proven pattern):
  // CONTAINS → Artifact | Question | Steering | UnitOfWork | CodeFile
  // (intent_id-guarded), the discussion threads and their messages, and the
  // Intent itself.
  // Project-scoped TeamKnowledge / LearningRule vertices are cross-intent by
  // design and stay. Edges drop with their vertices. A DRAFT intent has no
  // anchor — matches nothing.
  await g
    .V()
    .has('Intent', 'id', intentId)
    .union(
      __.out('CONTAINS').has('intent_id', intentId),
      __.out('HAS_DISCUSSION').union(__.out('HAS_MESSAGE'), __.identity()),
      __.identity(),
    )
    .drop()
    .next();

  // DynamoDB partition last — META goes with it, so until this succeeds the
  // intent still lists and the whole delete can simply be re-run.
  await store.deleteExecution(intentId);
};

export {
  collectDiscussionIds,
  collectIntentSessionIds,
  deleteIntentCascade,
  retireParkedRun,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
export default {
  collectIntentSessionIds,
  deleteIntentCascade,
  retireParkedRun,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
