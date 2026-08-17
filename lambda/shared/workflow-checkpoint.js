import { createHash } from 'node:crypto';

const MAX_WORKFLOW_CHECKPOINT_BYTES = 380 * 1024;

const INFRA_FIELDS = new Set([
  'pk',
  'sk',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'GSI3PK',
  'GSI3SK',
]);

const META_FIELDS = [
  'executionId',
  'intentId',
  'projectId',
  'status',
  'workflowId',
  'workflowVersion',
  'scope',
  'title',
  'prompt',
  'branch',
  'baseBranch',
  'baseBranches',
  'repos',
  'repoProviders',
  'gitProvider',
  'agentCli',
  'customRules',
  'projectType',
  'startedAt',
  'skipStageIds',
  'composedGrid',
  'aidlcRepoRef',
  'methodologyPins',
];
const STAGE_FIELDS = [
  'executionId',
  'stageInstanceId',
  'stageId',
  'phase',
  'state',
  'attempt',
  'unitSlug',
  'sectionIndex',
  'aidlcRepoRef',
  'startedAt',
  'completedAt',
  'updatedAt',
];
const HUMAN_TASK_FIELDS = [
  'executionId',
  'humanTaskId',
  'stageInstanceId',
  'stageId',
  'phase',
  'unitSlug',
  'sectionIndex',
  'kind',
  'status',
  'questions',
  'answer',
  'createdAt',
  'answeredAt',
];
const UNIT_PLAN_FIELDS = [
  'executionId',
  'units',
  'batches',
  'skipMatrix',
  'walkingSkeleton',
  'autonomyMode',
  'sourceArtifactId',
  'producedByStageInstanceId',
  'promotedAt',
  'updatedAt',
];
const UNIT_FIELDS = [
  'executionId',
  'slug',
  'sectionIndex',
  'state',
  'mergedAt',
  'completedAt',
  'updatedAt',
];

const snapshotRecord = (record, fields = null) =>
  record
    ? Object.fromEntries(
        Object.entries(record).filter(
          ([key, value]) =>
            !INFRA_FIELDS.has(key) && value !== undefined && (!fields || fields.includes(key)),
        ),
      )
    : null;

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

// Derive a stable identity from checkpoint contents; publication time and the
// boundary label do not change the identity of an otherwise identical snapshot.
const checkpointIdFor = ({ process, artifactRefs, customRuleRefs }) =>
  `checkpoint-${createHash('sha256')
    .update(canonicalJson({ process, artifactRefs, customRuleRefs }))
    .digest('hex')}`;

// Build the bounded DynamoDB record containing projector state and immutable
// external references. Artifact and custom-rule bodies stay in their stores.
const buildWorkflowCheckpoint = ({
  executionId,
  createdAt,
  sourceStageInstanceId = null,
  records,
  artifactRefs = [],
  customRuleRefs = [],
}) => {
  const process = {
    meta: snapshotRecord(records.meta, META_FIELDS),
    stages: (records.stages ?? []).map((record) => snapshotRecord(record, STAGE_FIELDS)),
    humanTasks: (records.humanTasks ?? []).map((record) =>
      snapshotRecord(record, HUMAN_TASK_FIELDS),
    ),
    unitPlan: snapshotRecord(records.unitPlan, UNIT_PLAN_FIELDS),
    units: (records.units ?? []).map((record) => snapshotRecord(record, UNIT_FIELDS)),
  };
  const checkpoint = {
    type: 'WorkflowCheckpoint',
    executionId,
    checkpointId: checkpointIdFor({ process, artifactRefs, customRuleRefs }),
    createdAt,
    sourceStageInstanceId,
    process,
    artifactRefs,
    customRuleRefs,
  };
  const bytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  if (bytes > MAX_WORKFLOW_CHECKPOINT_BYTES) {
    throw new Error(
      `workflow-checkpoint: ${bytes} bytes exceeds the ${MAX_WORKFLOW_CHECKPOINT_BYTES}-byte limit`,
    );
  }
  return checkpoint;
};

// Recover the process-record shape consumed by native workspace projection.
const checkpointProjection = (checkpoint) => {
  if (!checkpoint?.process?.meta) {
    throw new Error('workflow-checkpoint: checkpoint has no execution metadata');
  }
  return {
    meta: checkpoint.process.meta,
    stages: checkpoint.process.stages ?? [],
    humanTasks: checkpoint.process.humanTasks ?? [],
    unitPlan: checkpoint.process.unitPlan ?? null,
    units: checkpoint.process.units ?? [],
  };
};

export {
  MAX_WORKFLOW_CHECKPOINT_BYTES,
  buildWorkflowCheckpoint,
  canonicalJson,
  checkpointIdFor,
  checkpointProjection,
  snapshotRecord,
};
export default {
  MAX_WORKFLOW_CHECKPOINT_BYTES,
  buildWorkflowCheckpoint,
  canonicalJson,
  checkpointIdFor,
  checkpointProjection,
  snapshotRecord,
};
