// Shared workflow → ordered execution plan loader (DynamoDB-only).
//
// The orchestrator needs the ordered list of stage instances for a pinned
// workflow + scope so it can sequence run-stage calls. That ordering comes from
// `buildExecutionPlan`, which needs the workflow composition + block METADATA
// (stages/artifacts) — NOT the markdown bodies (those live in S3 and are loaded
// by the runtime container at stage time). So this loader reads only the blocks
// table, keeping the orchestrator off S3 and out of the agentcore package.
//
// Ownership shadowing matches the rest of the app: a `default` (user) block/
// workflow shadows the `SYSTEM` baseline of the same id.

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { blockPk, catalogGsi1Pk, LATEST, versionSk } from './blocks.js';
import { workflowPk, workflowVersionPrefix } from './workflows.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from './tenant.js';
import { buildExecutionPlan, workflowScopes } from './v2-execution-plan.js';

const keyById = (items) => {
  const byId = {};
  for (const b of items) byId[b.id ?? b.blockId] = b;
  return byId;
};

// Drain every 1MB Query page. A truncated read here is silently WRONG: a
// dropped placement row narrows the plan (stages skipped without error), and a
// dropped library block fails resolution for a stage that exists.
const queryAll = async (ddb, input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

// List every block of a type for a tenant via the catalog GSI.
const listBlocks = async (ddb, tableName, tenant, type) =>
  queryAll(ddb, {
    TableName: tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': catalogGsi1Pk(tenant, type) },
  });

// Merge SYSTEM + default catalogs for a type; default shadows SYSTEM by id.
const listMergedBlocks = async (ddb, tableName, type) => {
  const [system, user] = await Promise.all([
    listBlocks(ddb, tableName, SYSTEM_TENANT, type),
    listBlocks(ddb, tableName, DEFAULT_TENANT, type),
  ]);
  const byId = new Map();
  for (const b of system) byId.set(b.id ?? b.blockId, b);
  for (const b of user) byId.set(b.id ?? b.blockId, b);
  return [...byId.values()];
};

const blockPin = (block) => ({
  tenantId: block.tenantId,
  version: Number(block.version),
});

const pinsForBlocks = (blocks) =>
  Object.fromEntries(
    blocks
      .filter(
        (block) =>
          block?.blockId &&
          block?.tenantId &&
          Number.isInteger(Number(block.version)) &&
          Number(block.version) > 0,
      )
      .map((block) => [block.blockId, blockPin(block)]),
  );

const loadPinnedBlocks = async (ddb, tableName, type, pins) => {
  const entries = Object.entries(pins ?? {});
  const blocks = await Promise.all(
    entries.map(async ([blockId, pin]) => {
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: blockPk(pin.tenantId, type, blockId),
            sk: versionSk(Number(pin.version)),
          },
        }),
      );
      return result.Item ?? null;
    }),
  );
  const missing = entries.filter((_, index) => blocks[index] == null).map(([blockId]) => blockId);
  if (missing.length) {
    throw new Error(`Pinned ${type} block versions are unavailable: ${missing.join(', ')}`);
  }
  return blocks;
};

const loadLibraryType = (ddb, tableName, type, methodologyPins) =>
  methodologyPins?.[type]
    ? loadPinnedBlocks(ddb, tableName, type, methodologyPins[type])
    : listMergedBlocks(ddb, tableName, type);

const loadPlacedStages = async (ddb, tableName, placements, stagePins = null) => {
  const legacyPlacements = placements.filter(
    (placement) => !placement.stageTenant && !stagePins?.[placement.stageId],
  );
  const legacyStages = legacyPlacements.length
    ? await listMergedBlocks(ddb, tableName, 'STAGE')
    : [];
  const legacyById = new Map(legacyStages.map((stage) => [stage.id ?? stage.blockId, stage]));
  const stages = await Promise.all(
    placements.map(async (placement) => {
      const pin = stagePins?.[placement.stageId];
      if (!placement.stageTenant && pin) {
        const result = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: blockPk(pin.tenantId, 'STAGE', placement.stageId),
              sk: versionSk(Number(pin.version)),
            },
          }),
        );
        return result.Item ?? null;
      }
      if (!placement.stageTenant) return legacyById.get(placement.stageId) ?? null;
      const tenant = placement.stageTenant;
      const sk =
        placement.pinnedVersion == null ? LATEST : versionSk(Number(placement.pinnedVersion));
      const result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: blockPk(tenant, 'STAGE', placement.stageId), sk },
        }),
      );
      return result.Item ?? null;
    }),
  );
  return stages.filter(Boolean);
};

// Load the pinned workflow's version snapshot rows (default shadows SYSTEM).
const loadWorkflowItems = async (ddb, tableName, workflowId, workflowVersion) => {
  for (const tenant of [DEFAULT_TENANT, SYSTEM_TENANT]) {
    const items = await queryAll(ddb, {
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :v)',
      ExpressionAttributeValues: {
        ':pk': workflowPk(tenant, workflowId),
        ':v': workflowVersionPrefix(workflowVersion),
      },
    });
    if (items.length) return items;
  }
  return [];
};

// Reduce the version snapshot rows into the workflow composition shape
// buildExecutionPlan consumes (placements + ruleRefs + scopeRefs + phases).
const assembleWorkflow = (items, { workflowId, workflowVersion }) => {
  const liveSk = (sk) => sk.replace(workflowVersionPrefix(workflowVersion), '');
  const placements = [];
  const ruleRefs = [];
  const scopeRefs = [];
  const phases = [];
  let sourceRef = null;
  for (const it of items) {
    const sk = liveSk(it.sk);
    if (sk === 'META') {
      sourceRef = it.sourceRef ?? null;
    } else if (sk.startsWith('PLACEMENT#')) {
      placements.push({
        stageId: it.stageId,
        stageTenant: it.stageTenant ?? null,
        pinnedVersion: it.pinnedVersion ?? null,
        order: it.order ?? 0,
        phasePath: it.phasePath ?? null,
        scopeMembership: it.scopeMembership ?? {},
      });
    } else if (sk.startsWith('RULEREF#')) {
      ruleRefs.push({ layer: it.layer, ruleId: it.ruleId });
    } else if (sk.startsWith('SCOPEREF#')) {
      scopeRefs.push({ scopeId: it.scopeId });
    } else if (sk.startsWith('PHASE#')) {
      phases.push({ phaseId: it.phaseId, path: it.path ?? null });
    }
  }
  return {
    workflowId,
    workflowVersion: Number(workflowVersion),
    sourceRef,
    placements,
    ruleRefs,
    scopeRefs,
    phases,
  };
};

// Build the ordered execution plan for a pinned workflow + scope. Returns the
// same `{ valid, errors, plan }` shape as buildExecutionPlan; `plan.stages` is
// the ordered stage list the orchestrator sequences. `skipStageIds` is the
// per-intent skip overlay snapshotted on the execution META row (see
// shared/stage-skip.js) — every recompute of the same intent MUST pass the
// same overlay or the plan drifts between the create check, the orchestrator
// walk, the rewind slice, and the container's stage resolution. The same
// invariant holds for `composedGrid` (the per-intent EXECUTE/SKIP grid pinned
// on META): grid consumers must all pass the identical grid. `strict`
// promotes starved required inputs to errors (recompose dry runs).
const loadExecutionPlan = async ({
  ddb,
  tableName,
  workflowId,
  workflowVersion,
  scope,
  skipStageIds = null,
  composedGrid = null,
  strict = false,
  methodologyPins = null,
}) => {
  const items = await loadWorkflowItems(ddb, tableName, workflowId, workflowVersion);
  if (!items.length) {
    return {
      valid: false,
      errors: [{ code: 'workflow_not_found', workflowId, workflowVersion }],
      plan: null,
    };
  }
  const workflow = assembleWorkflow(items, { workflowId, workflowVersion });
  // AGENT blocks are loaded here too: buildExecutionPlan resolves each stage's
  // leadAgent / supportAgents / reviewer against agentsById, so omitting them
  // makes EVERY agent-bearing stage fail `unresolved_agent` and rejects the plan
  // before any stage runs (the bodies still load lazily in the runtime container).
  const [stages, agents, sensors, rules, artifacts, knowledge] = await Promise.all([
    loadPlacedStages(ddb, tableName, workflow.placements, methodologyPins?.STAGE),
    loadLibraryType(ddb, tableName, 'AGENT', methodologyPins),
    loadLibraryType(ddb, tableName, 'SENSOR', methodologyPins),
    loadLibraryType(ddb, tableName, 'RULE', methodologyPins),
    loadLibraryType(ddb, tableName, 'ARTIFACT', methodologyPins),
    loadLibraryType(ddb, tableName, 'KNOWLEDGE', methodologyPins),
  ]);
  const library = {
    stagesById: keyById(stages),
    agentsById: keyById(agents),
    sensorsById: keyById(sensors),
    rulesById: keyById(rules),
    artifactsById: keyById(artifacts),
  };
  const result = buildExecutionPlan({
    workflow,
    scope,
    library,
    skipStageIds,
    composedGrid,
    strict,
  });
  return {
    ...result,
    methodologySourceRefs: [
      ...new Set(
        [workflow, ...stages, ...agents, ...sensors, ...rules, ...artifacts, ...knowledge]
          .map((item) => item?.sourceRef)
          .filter(Boolean),
      ),
    ].toSorted(),
    methodologyPins: methodologyPins ?? {
      STAGE: pinsForBlocks(stages),
      AGENT: pinsForBlocks(agents),
      SENSOR: pinsForBlocks(sensors),
      RULE: pinsForBlocks(rules),
      ARTIFACT: pinsForBlocks(artifacts),
      KNOWLEDGE: pinsForBlocks(knowledge),
    },
  };
};

// List the scopes a pinned workflow offers (the vocabulary the intent scope
// picker must choose from). Returns [] when the workflow snapshot is missing.
// Used by the intents API to validate a scope at intent-create time without
// loading the full block library that buildExecutionPlan needs.
const loadWorkflowScopes = async ({ ddb, tableName, workflowId, workflowVersion }) => {
  const items = await loadWorkflowItems(ddb, tableName, workflowId, workflowVersion);
  if (!items.length) return [];
  const workflow = assembleWorkflow(items, { workflowId, workflowVersion });
  return [...workflowScopes(workflow)];
};

const __test = { listMergedBlocks, loadPlacedStages, loadPinnedBlocks, pinsForBlocks };
export { loadExecutionPlan, loadWorkflowScopes, assembleWorkflow, listMergedBlocks, __test };
export default {
  loadExecutionPlan,
  loadWorkflowScopes,
  assembleWorkflow,
  listMergedBlocks,
  __test,
};
