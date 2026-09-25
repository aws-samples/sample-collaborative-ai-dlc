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
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import {
  DeleteCapacityProviderSessionCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';

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

// Session-id conventions — MUST mirror lambda/intents/index.js and
// lambda/agentcore/v2-orchestrator/section.js (laneSessionIdFor).
const runtimeSessionIdFor = (intentId) => `aidlc-intent-${intentId}`.padEnd(33, '0');
const laneSessionIdFor = (intentId, sectionIndex, slug) =>
  `aidlc-intent-${intentId}-s${sectionIndex}-${slug}`.padEnd(33, '0');

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

// Best-effort: stop the intent's live AgentCore session(s) so nothing keeps
// writing into the partition we are about to delete. Never throws — an
// already-stopped/never-started session must not block the delete (same
// tolerance as the orchestrator's stopRuntimeSession).
const stopRuntimeSessions = async (
  agentcore,
  agentcoreRuntimeTarget,
  intentId,
  { sessionIds = [] } = {},
) => {
  const target =
    typeof agentcoreRuntimeTarget === 'string'
      ? { agentRuntimeArn: agentcoreRuntimeTarget }
      : agentcoreRuntimeTarget;
  if (!agentcore || !target?.agentRuntimeArn) return;
  const ids = [...new Set([runtimeSessionIdFor(intentId), ...sessionIds])];
  for (const id of ids) {
    try {
      await agentcore.send(
        new StopRuntimeSessionCommand({
          ...target,
          runtimeSessionId: id,
        }),
      );
    } catch (err) {
      logger.info('stop-runtime-session best-effort miss', {
        sessionId: id,
        error: err?.message ?? String(err),
      });
    }
  }
};

// Every session an intent may have opened on the Instances compute type,
// rebuilt from the PERSISTED records (not the current unit plan). The UNIT#
// rows are the source of truth: the orchestrator stamps each lane's sessionId
// on the row when the lane starts, and the rows survive plan rewinds — so
// historical/orphaned lanes that are no longer in the current plan are still
// covered. A row without a stamped sessionId (a lane that never started, or a
// legacy row) falls back to the deterministic lane id derived from its
// persisted sectionIndex + slug, and lane STAGE# rows (which persist
// sectionIndex + unitSlug) contribute the same derivation as a second net.
// The result is a superset — callers tolerate deleting/stopping a session
// that never existed.
const collectIntentSessionIds = (intentId, records = {}) => {
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
  return [...ids];
};

// Instances sessions keep their EBS volumes across stop/idle/lifetime — only
// an explicit DeleteCapacityProviderSession releases them. A permanently
// deleted intent must not leave its workspace volumes (and their charges)
// behind, so this THROWS on an unexpected error: the cascade deletes META
// last, the intent still lists, and the whole delete is simply re-run. A
// session that never existed is tolerated (ResourceNotFound/Validation) —
// the lane id set is a superset of what actually ran. Park/resume never
// reaches here; it stops sessions and retains volumes by design.
const deleteRuntimeSessions = async (
  agentcore,
  capacityProviderArn,
  intentId,
  { sessionIds = [] } = {},
) => {
  const capacityProviderId = String(capacityProviderArn ?? '')
    .split('/')
    .pop();
  if (!agentcore || !capacityProviderId) return;
  const ids = [...new Set([runtimeSessionIdFor(intentId), ...sessionIds])];
  for (const id of ids) {
    try {
      await agentcore.send(
        new DeleteCapacityProviderSessionCommand({
          capacityProviderId,
          sessionId: id,
        }),
      );
    } catch (err) {
      if (['ResourceNotFoundException', 'ValidationException'].includes(err?.name)) {
        console.log(`delete-capacity-provider-session miss (${id}): ${err?.message ?? err}`);
        continue;
      }
      throw err;
    }
  }
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
//   agentcore            – BedrockAgentCore client (optional; session stop)
//   lambdaClient         – Lambda client (optional; durable callback on retire)
//   intentId             – the intent/execution id (they are equal)
//   meta                 – the execution META row (for status)
//   yjsTable             – Yjs documents table name (optional)
//   agentcoreRuntimeTarget – runtime ARN and endpoint for session stop (optional)
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
  agentcoreRuntimeTarget = null,
  agentcoreRuntimeArn = null,
  actor = 'a project member',
  artifactsBucket = null,
  force = false,
}) => {
  if (meta?.status === 'RUNNING' && !force) {
    throw new IntentRunningError(intentId);
  }

  // Collect the derived Yjs document ids BEFORE their sources are deleted:
  // gate editors (intent-sq-<id>-<humanTaskId>, from HUMAN# rows), stage review
  // feedback docs (intent-review-<id>-<humanTaskId>), discussion threads
  // (intent-discussion-<id>-<discussionId>, from the Neptune Discussion vertices)
  // and the presence doc.
  const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
  await Promise.all([
    purgeAttachmentPrefix(artifactsBucket, `intent-attachments/committed/${intentId}/`),
    purgeAttachmentPrefix(artifactsBucket, `intent-attachments/staging/${intentId}/`),
    purgeAttachmentPrefix(artifactsBucket, `workflow-exports/${intentId}/`),
  ]);
  const discussionIds = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('HAS_DISCUSSION')
    .values('id')
    .toList()
    .catch(() => []);
  const yjsDocIds = [
    `intent-presence-${intentId}`,
    `intent-draft-${intentId}`,
    ...(records.humanTasks ?? []).map((h) => `intent-sq-${intentId}-${h.humanTaskId}`),
    ...(records.humanTasks ?? []).map((h) => `intent-review-${intentId}-${h.humanTaskId}`),
    ...discussionIds.map((d) => `intent-discussion-${intentId}-${d}`),
  ];

  // Retire anything that could still wake up (same mechanics as cancel), then
  // stop any live session so nothing writes into the deleted partition. A
  // DRAFT/SUCCEEDED/CANCELLED run has nothing parked to retire.
  const reason = `deleted by ${actor}`;
  if (!['DRAFT', 'SUCCEEDED', 'CANCELLED'].includes(meta?.status)) {
    await retireParkedRun({ store, lambdaClient, executionId: intentId, reason });
  }
  const sessionIds = collectIntentSessionIds(intentId, records);
  await stopRuntimeSessions(agentcore, agentcoreRuntimeTarget ?? agentcoreRuntimeArn, intentId, {
    sessionIds,
  });
  // Instances runs: delete the sessions so their persistent EBS volumes go
  // with the intent. The session set is rebuilt from the persisted UNIT#/STAGE#
  // rows (see collectIntentSessionIds) — deleting a session that never started
  // is a tolerated miss. deleteRuntimeSessions throws on an unexpected error
  // BEFORE the intent records are deleted below, so a failed session delete
  // keeps the records and the whole cascade stays retryable.
  const capacityProviderArn =
    meta?.environment?.capacityProviderArn ?? meta?.environmentSnapshot?.capacityProviderArn;
  if (capacityProviderArn) {
    await deleteRuntimeSessions(agentcore, capacityProviderArn, intentId, { sessionIds });
  }

  // Yjs docs — best-effort: they are unreachable once the intent is gone (doc
  // ids are derived from the intent id), so a failed delete here only leaves
  // harmless orphans and must not block the real deletion.
  if (yjsTable && ddb) {
    await Promise.all(
      yjsDocIds.map(async (documentId) => {
        try {
          await ddb.send(new DeleteCommand({ TableName: yjsTable, Key: { documentId } }));
        } catch (err) {
          logger.error('Yjs doc delete failed', err, { documentId });
        }
      }),
    );
  }

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
  collectIntentSessionIds,
  deleteIntentCascade,
  deleteRuntimeSessions,
  retireParkedRun,
  stopRuntimeSessions,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
export default {
  collectIntentSessionIds,
  deleteIntentCascade,
  deleteRuntimeSessions,
  retireParkedRun,
  stopRuntimeSessions,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
