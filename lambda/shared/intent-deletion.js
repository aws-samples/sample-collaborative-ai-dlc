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
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';

const __ = gremlin.process.statics;

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
  agentcoreRuntimeArn,
  intentId,
  { sectionIndexes = [], unitSlugs = [] } = {},
) => {
  if (!agentcore || !agentcoreRuntimeArn) return;
  const ids = [runtimeSessionIdFor(intentId)];
  for (const idx of sectionIndexes) {
    for (const slug of unitSlugs) ids.push(laneSessionIdFor(intentId, idx, slug));
  }
  for (const id of ids) {
    try {
      await agentcore.send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn: agentcoreRuntimeArn,
          runtimeSessionId: id,
        }),
      );
    } catch (err) {
      console.log(`stop-runtime-session best-effort miss (${id}): ${err?.message ?? err}`);
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
        console.error('Gate supersede failed:', err.message);
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
        .catch((err) => console.error('Cancel callback send failed:', err.message));
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
//   agentcoreRuntimeArn  – runtime ARN for session stop (optional)
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
  agentcoreRuntimeArn = null,
  actor = 'a project member',
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
  await stopRuntimeSessions(agentcore, agentcoreRuntimeArn, intentId);

  // Yjs docs — best-effort: they are unreachable once the intent is gone (doc
  // ids are derived from the intent id), so a failed delete here only leaves
  // harmless orphans and must not block the real deletion.
  if (yjsTable && ddb) {
    await Promise.all(
      yjsDocIds.map(async (documentId) => {
        try {
          await ddb.send(new DeleteCommand({ TableName: yjsTable, Key: { documentId } }));
        } catch (err) {
          console.error(`Yjs doc delete failed (${documentId}):`, err.message);
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
  // CONTAINS → Artifact | Question | Steering | UnitOfWork (intent_id-guarded),
  // the discussion threads and their messages, and the Intent itself.
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
  deleteIntentCascade,
  retireParkedRun,
  stopRuntimeSessions,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
export default {
  deleteIntentCascade,
  retireParkedRun,
  stopRuntimeSessions,
  runtimeSessionIdFor,
  laneSessionIdFor,
  IntentRunningError,
};
