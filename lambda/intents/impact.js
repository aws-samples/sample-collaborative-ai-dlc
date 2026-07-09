// Artifact impact — "who consumed / derived from this document?" assembled
// from the three consumption evidences the system already records:
//
//   1. DECLARED — stages whose block frontmatter `consumes` names this
//      artifact type (the compiled execution plan);
//   2. ACTUAL READS — the READ# graph-read ledger (which stage really read
//      this artifact / its type through the MCP tools);
//   3. GRAPH — the transitive downstream closure over CONSUMES /
//      DERIVED_FROM / CITES edges in Neptune (shared/artifact-edit.js).
//
// The union drives the pre-edit drift warning ("consumed by N stages, M
// artifacts derived") and is the same evidence the Quorum edit flow plans
// from. Pure assembly — Neptune/plan/records access is injected by the
// caller (lambda/intents/index.js).

import { fetchDownstreamClosure } from '../shared/artifact-edit.js';

// Stage-level consumption evidence for one artifact.
//
// `plan` is the resolved execution plan (loadExecutionPlan().plan, may be
// null when unresolvable — declared evidence degrades to []). `graphReads`
// are the READ# rows; `stages` the STAGE# rows (to attribute reads to stage
// ids). Only reads that name THIS artifact (args.id / args.artifactId) or its
// type (args.artifactType) count.
export const collectConsumingStages = ({
  plan = null,
  graphReads = [],
  stages = [],
  artifactId,
  artifactType,
}) => {
  const byStageId = new Map();
  const upsert = (stageId, via) => {
    if (!stageId) return;
    const entry = byStageId.get(stageId) ?? { stageId, via: [] };
    if (!entry.via.includes(via)) entry.via.push(via);
    byStageId.set(stageId, entry);
  };

  // 1. Declared consumes from the compiled plan (plan stages carry the
  // normalized `inputArtifacts: [{ artifact, required, … }]` shape).
  for (const stage of plan?.stages ?? []) {
    const inputs = Array.isArray(stage.inputArtifacts)
      ? stage.inputArtifacts
      : Array.isArray(stage.consumes)
        ? stage.consumes
        : [];
    const hit = inputs.some((c) => {
      const ref = typeof c === 'string' ? c : c?.artifact;
      return ref && artifactType && ref === artifactType;
    });
    if (hit) upsert(stage.stageId, 'declared');
  }

  // 2. Actual reads from the READ# ledger, attributed to the stage that made
  // them. A read names the artifact directly (get_artifact { id }) or its
  // type (lookup_artifacts { artifactType }).
  const stageIdByInstance = new Map(
    (stages ?? []).map((s) => [s.stageInstanceId, s.stageId ?? s.stageInstanceId]),
  );
  for (const read of graphReads ?? []) {
    const args = read.args ?? {};
    const namesArtifact =
      (artifactId && (args.id === artifactId || args.artifactId === artifactId)) ||
      (artifactType && args.artifactType === artifactType);
    if (!namesArtifact || !read.stageInstanceId) continue;
    upsert(stageIdByInstance.get(read.stageInstanceId) ?? read.stageInstanceId, 'read');
  }

  return [...byStageId.values()].toSorted((a, b) => a.stageId.localeCompare(b.stageId));
};
// True while the intent's execution could RACE a post-hoc edit: a fresh
// dispatch (CREATED) or a stage actively running (RUNNING) — the agent's own
// update_artifact writes are in flight. WAITING is deliberately NOT active:
// a parked run is the codebase's established safe mutation point (rewind,
// cancel and steering all operate on parked runs — docs/v2-steering.md), and
// v2 runs park on human gates constantly, so blocking WAITING would make
// editing effectively impossible. The edit endpoints announce a mid-run edit
// to the parked conversation via a steering row (kind `artifact-edit`),
// delivered at the next deterministic injection point (gate resume / fresh
// stage start), so the resumed agent re-reads the changed document instead of
// trusting stale in-conversation context.
export const isExecutionActive = (meta) => ['CREATED', 'RUNNING'].includes(meta?.status);

const QEDIT_TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELLED']);

export const activeQuorumEdit = (quorumEdits = []) =>
  (quorumEdits ?? []).find((q) => q?.state && !QEDIT_TERMINAL.has(q.state)) ?? null;

// Why an edit is currently blocked, or null when editing is allowed. One
// vocabulary for the impact GET (UI disables buttons) and the mutation
// endpoints (409 guard) so the two can never drift.
export const editBlockReason = ({ meta, quorumEdits = [] }) => {
  if (isExecutionActive(meta)) return 'execution_active';
  if (activeQuorumEdit(quorumEdits)) return 'quorum_edit_active';
  return null;
};

/**
 * Assemble the full impact DTO for one artifact.
 */
export const buildArtifactImpact = async ({ g, intentId, artifact, plan = null, records = {} }) => {
  const downstream = await fetchDownstreamClosure({
    g,
    intentId,
    artifactId: artifact.id,
  });
  const consumingStages = collectConsumingStages({
    plan,
    graphReads: records.graphReads ?? [],
    stages: records.stages ?? [],
    artifactId: artifact.id,
    artifactType: artifact.artifactType ?? artifact.artifact_type ?? null,
  });
  const blockReason = editBlockReason({
    meta: records.meta,
    quorumEdits: records.quorumEdits ?? [],
  });
  const active = activeQuorumEdit(records.quorumEdits ?? []);
  return {
    artifactId: artifact.id,
    artifactType: artifact.artifactType ?? artifact.artifact_type ?? null,
    consumingStages,
    downstream: downstream.map((d) => ({
      id: d.id,
      title: d.title ?? null,
      artifactType: d.artifactType ?? null,
      depth: d.depth,
      via: d.via,
      stale: Boolean(d.staleSince),
    })),
    executionActive: isExecutionActive(records.meta),
    editBlocked: blockReason != null,
    blockReason,
    activeQuorumEditId: active?.editId ?? null,
  };
};

export default {
  collectConsumingStages,
  isExecutionActive,
  activeQuorumEdit,
  editBlockReason,
  buildArtifactImpact,
};
