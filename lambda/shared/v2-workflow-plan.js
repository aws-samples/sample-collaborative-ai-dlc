'use strict';

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

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { catalogGsi1Pk } = require('./blocks.js');
const { workflowPk, workflowVersionPrefix } = require('./workflows.js');
const { DEFAULT_TENANT, SYSTEM_TENANT } = require('./tenant.js');
const { buildExecutionPlan, workflowScopes } = require('./v2-execution-plan.js');

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
  for (const it of items) {
    const sk = liveSk(it.sk);
    if (sk.startsWith('PLACEMENT#')) {
      placements.push({
        stageId: it.stageId,
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
    placements,
    ruleRefs,
    scopeRefs,
    phases,
  };
};

// Build the ordered execution plan for a pinned workflow + scope. Returns the
// same `{ valid, errors, plan }` shape as buildExecutionPlan; `plan.stages` is
// the ordered stage list the orchestrator sequences.
const loadExecutionPlan = async ({ ddb, tableName, workflowId, workflowVersion, scope }) => {
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
  const [stages, agents, sensors, rules, artifacts] = await Promise.all([
    listMergedBlocks(ddb, tableName, 'STAGE'),
    listMergedBlocks(ddb, tableName, 'AGENT'),
    listMergedBlocks(ddb, tableName, 'SENSOR'),
    listMergedBlocks(ddb, tableName, 'RULE'),
    listMergedBlocks(ddb, tableName, 'ARTIFACT'),
  ]);
  const library = {
    stagesById: keyById(stages),
    agentsById: keyById(agents),
    sensorsById: keyById(sensors),
    rulesById: keyById(rules),
    artifactsById: keyById(artifacts),
  };
  return buildExecutionPlan({ workflow, scope, library });
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

module.exports = {
  loadExecutionPlan,
  loadWorkflowScopes,
  assembleWorkflow,
  __test: { listMergedBlocks },
};
