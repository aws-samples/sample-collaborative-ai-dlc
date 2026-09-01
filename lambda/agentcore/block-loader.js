// Block loader — reads the pinned workflow + the library blocks it references
// from the blocks table (DynamoDB) and their bodies + the internal runtime
// snapshot from S3. Produces the `library` bag the execution-plan resolver
// consumes, plus the markdown bodies the materializer writes into the workspace.
//
// Ownership shadowing: a `default` (user) block shadows the `SYSTEM` baseline of
// the same id. We read default first, fall back to SYSTEM — matching the API's
// read semantics so the runtime honours user forks.

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ddb, s3 } from './clients.js';
import { blockPk, catalogGsi1Pk, LATEST, versionSk } from '../shared/blocks.js';
import { workflowPk, workflowVersionPrefix } from '../shared/workflows.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from '../shared/tenant.js';

const blocksTable = () => process.env.BLOCKS_TABLE;
const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;

const streamToString = async (body) => {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

// Read an S3 text object; returns '' when the ref is absent.
const getObjectText = async (s3Key) => {
  if (!s3Key) return '';
  const res = await s3.send(new GetObjectCommand({ Bucket: artifactsBucket(), Key: s3Key }));
  return streamToString(res.Body);
};

// Drain every 1MB Query page. A truncated read here is silently WRONG: a
// dropped placement row narrows the plan (stages skipped without error), and a
// dropped library block fails resolution for a stage that exists.
const queryAll = async (input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

// List every block of a type for a tenant (catalog browse via GSI1).
const listBlocks = async (tenant, type) =>
  queryAll({
    TableName: blocksTable(),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': catalogGsi1Pk(tenant, type) },
  });

// Merge SYSTEM + default catalogs for a type, default shadowing SYSTEM by id.
// Exported for callers needing block types outside loadLibrary's bag (the
// composer reads SCOPE blocks for keyword/description grounding).
export const listMergedBlocks = async (type) => {
  const [system, user] = await Promise.all([
    listBlocks(SYSTEM_TENANT, type),
    listBlocks(DEFAULT_TENANT, type),
  ]);
  const byId = new Map();
  for (const b of system) byId.set(b.id ?? b.blockId, b);
  for (const b of user) byId.set(b.id ?? b.blockId, b); // user shadows
  return [...byId.values()];
};

const loadPinnedBlocks = async (type, pins) => {
  const entries = Object.entries(pins ?? {});
  const blocks = await Promise.all(
    entries.map(async ([blockId, pin]) => {
      const result = await ddb.send(
        new GetCommand({
          TableName: blocksTable(),
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

const loadLibraryType = (type, methodologyPins) =>
  methodologyPins?.[type] ? loadPinnedBlocks(type, methodologyPins[type]) : listMergedBlocks(type);

const assertSystemSourceRef = ({ aidlcRepoRef, workflowTenant, workflow, blocksByType }) => {
  if (!aidlcRepoRef) return;

  const mismatches = [];
  const recordMismatch = (label, sourceRef) => {
    if (sourceRef !== aidlcRepoRef) {
      mismatches.push(`${label} has sourceRef ${sourceRef ?? '<missing>'}`);
    }
  };

  if (workflowTenant === SYSTEM_TENANT) {
    recordMismatch(
      `workflow ${workflow.workflowId}@${workflow.workflowVersion}`,
      workflow.sourceRef,
    );
  }
  for (const [type, blocks] of Object.entries(blocksByType)) {
    for (const block of blocks) {
      if (block.tenantId !== SYSTEM_TENANT) continue;
      recordMismatch(
        `${type} ${block.id ?? block.blockId}@${block.version ?? '<unknown>'}`,
        block.sourceRef,
      );
    }
  }

  if (mismatches.length) {
    throw new Error(
      `Pinned methodology snapshot does not match AI-DLC repository ref ${aidlcRepoRef}: ${mismatches.join('; ')}`,
    );
  }
};

const loadPlacedStages = async (placements, stagePins = null) => {
  const legacyPlacements = placements.filter(
    (placement) => !placement.stageTenant && !stagePins?.[placement.stageId],
  );
  const legacyStages = legacyPlacements.length ? await listMergedBlocks('STAGE') : [];
  const legacyById = new Map(legacyStages.map((stage) => [stage.id ?? stage.blockId, stage]));
  const stages = await Promise.all(
    placements.map(async (placement) => {
      const pin = stagePins?.[placement.stageId];
      if (!placement.stageTenant && pin) {
        const result = await ddb.send(
          new GetCommand({
            TableName: blocksTable(),
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
          TableName: blocksTable(),
          Key: { pk: blockPk(tenant, 'STAGE', placement.stageId), sk },
        }),
      );
      return result.Item ?? null;
    }),
  );
  return stages.filter(Boolean);
};

// Load the pinned workflow composition (META + phases + placements + refs) at an
// immutable version, honouring default→SYSTEM shadowing.
const loadWorkflow = async ({ workflowId, workflowVersion }) => {
  const version = Number(workflowVersion);
  for (const tenant of [DEFAULT_TENANT, SYSTEM_TENANT]) {
    const items = await queryAll({
      TableName: blocksTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :vp)',
      ExpressionAttributeValues: {
        ':pk': workflowPk(tenant, workflowId),
        ':vp': workflowVersionPrefix(version),
      },
    });
    if (items.length > 0) return { tenant, items };
  }
  return null;
};

// Reassemble a workflow composition document from its row set (the version
// snapshot rows: META, PHASE#…, PLACEMENT#…, RULEREF#…, SCOPEREF#…).
const assembleWorkflow = (items, { workflowId, workflowVersion }) => {
  // Version rows are keyed `V#<n>#<liveSk>`; strip the version prefix to read the
  // live sub-key (META / PHASE# / PLACEMENT# / RULEREF# / SCOPEREF#).
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

// Build the `library` bag (id → block) for the plan resolver, from the merged
// catalogs. Blocks are keyed by their id (or blockId).
const keyById = (items) => Object.fromEntries(items.map((b) => [b.id ?? b.blockId, b]));

// Load everything the runtime needs for one execution: the pinned workflow plus
// the library blocks (stages/agents/sensors/rules/artifacts) it references.
export const loadLibrary = async ({
  workflowId,
  workflowVersion,
  methodologyPins = null,
  aidlcRepoRef = null,
}) => {
  const wf = await loadWorkflow({ workflowId, workflowVersion });
  if (!wf) return { workflow: null, library: null };
  const workflow = assembleWorkflow(wf.items, { workflowId, workflowVersion });

  const [stages, agents, sensors, rules, artifacts, knowledge] = await Promise.all([
    loadPlacedStages(workflow.placements, methodologyPins?.STAGE),
    loadLibraryType('AGENT', methodologyPins),
    loadLibraryType('SENSOR', methodologyPins),
    loadLibraryType('RULE', methodologyPins),
    loadLibraryType('ARTIFACT', methodologyPins),
    loadLibraryType('KNOWLEDGE', methodologyPins),
  ]);

  assertSystemSourceRef({
    aidlcRepoRef,
    workflowTenant: wf.tenant,
    workflow,
    blocksByType: {
      STAGE: stages,
      AGENT: agents,
      SENSOR: sensors,
      RULE: rules,
      ARTIFACT: artifacts,
      KNOWLEDGE: knowledge,
    },
  });

  const library = {
    stagesById: keyById(stages),
    agentsById: keyById(agents),
    sensorsById: keyById(sensors),
    rulesById: keyById(rules),
    artifactsById: keyById(artifacts),
    // The methodology knowledge tier (the team tier accrues in Neptune at
    // runtime, fetched separately by run-stage). run-stage's loadAgentKnowledge
    // filters these by agentRef/'shared'.
    knowledgeById: keyById(knowledge),
  };
  return { workflow, library };
};

// Fetch the markdown body for a block (its instructions/prose) from S3.
export const loadBlockBody = async (block) => getObjectText(block?.bodyRef?.s3Key);

// Fetch a sensor block's executable check script from S3 (its `scriptRef`).
// Returns '' when the block carries no script. The seed content-addresses the
// upstream `core/tools/aidlc-sensor-<id>.ts` here; a `script` sensor's runner
// materializes it to the workspace and spawns it against the checked-out code.
export const loadBlockScript = async (block) => getObjectText(block?.scriptRef?.s3Key);

// Fetch the runtime snapshot manifest for a pinned ref.
export const loadRuntimeManifest = async (ref) => {
  const text = await getObjectText(`aidlc-runtime/${ref}/manifest.json`);
  return text ? JSON.parse(text) : { ref, runtimeFiles: [], sensorScripts: [] };
};

// Fetch a single runtime file's content from the pinned snapshot.
export const loadRuntimeFile = async (ref, repoPath) =>
  getObjectText(`aidlc-runtime/${ref}/${repoPath}`);

// Fetch the conductor persona (execution-quality doctrine) from the pinned
// runtime snapshot. The stage prompt injects it so the quality guidance can
// never drift from upstream's authored `conductor.md`. '' when the ref/file is
// absent (the annex's distilled quality section still applies).
export const loadConductor = async (ref) =>
  ref ? getObjectText(`aidlc-runtime/${ref}/core/aidlc-common/conductor.md`) : '';

export const __test = {
  assembleWorkflow,
  keyById,
  streamToString,
  loadPlacedStages,
  loadPinnedBlocks,
  assertSystemSourceRef,
};
