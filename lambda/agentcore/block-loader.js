// Block loader — reads the pinned workflow + the library blocks it references
// from the blocks table (DynamoDB) and their bodies + the internal runtime
// snapshot from S3. Produces the `library` bag the execution-plan resolver
// consumes, plus the markdown bodies the materializer writes into the workspace.
//
// Ownership shadowing: a `default` (user) block shadows the `SYSTEM` baseline of
// the same id. We read default first, fall back to SYSTEM — matching the API's
// read semantics so the runtime honours user forks.

import { createRequire } from 'node:module';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ddb, s3 } from './clients.js';

const require = createRequire(import.meta.url);
const { catalogGsi1Pk } = require('../shared/blocks.js');
const { workflowPk, workflowVersionPrefix } = require('../shared/workflows.js');
const { DEFAULT_TENANT, SYSTEM_TENANT } = require('../shared/tenant.js');

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

// List every block of a type for a tenant (catalog browse via GSI1).
const listBlocks = async (tenant, type) => {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: blocksTable(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': catalogGsi1Pk(tenant, type) },
    }),
  );
  return Items ?? [];
};

// Merge SYSTEM + default catalogs for a type, default shadowing SYSTEM by id.
const listMergedBlocks = async (type) => {
  const [system, user] = await Promise.all([
    listBlocks(SYSTEM_TENANT, type),
    listBlocks(DEFAULT_TENANT, type),
  ]);
  const byId = new Map();
  for (const b of system) byId.set(b.id ?? b.blockId, b);
  for (const b of user) byId.set(b.id ?? b.blockId, b); // user shadows
  return [...byId.values()];
};

// Load the pinned workflow composition (META + phases + placements + refs) at an
// immutable version, honouring default→SYSTEM shadowing.
const loadWorkflow = async ({ workflowId, workflowVersion }) => {
  const version = Number(workflowVersion);
  for (const tenant of [DEFAULT_TENANT, SYSTEM_TENANT]) {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: blocksTable(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :vp)',
        ExpressionAttributeValues: {
          ':pk': workflowPk(tenant, workflowId),
          ':vp': workflowVersionPrefix(version),
        },
      }),
    );
    if ((Items ?? []).length > 0) return { tenant, items: Items };
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

// Build the `library` bag (id → block) for the plan resolver, from the merged
// catalogs. Blocks are keyed by their id (or blockId).
const keyById = (items) => Object.fromEntries(items.map((b) => [b.id ?? b.blockId, b]));

// Load everything the runtime needs for one execution: the pinned workflow plus
// the library blocks (stages/agents/sensors/rules/artifacts) it references.
export const loadLibrary = async ({ workflowId, workflowVersion }) => {
  const wf = await loadWorkflow({ workflowId, workflowVersion });
  if (!wf) return { workflow: null, library: null };
  const workflow = assembleWorkflow(wf.items, { workflowId, workflowVersion });

  const [stages, agents, sensors, rules, artifacts, knowledge] = await Promise.all([
    listMergedBlocks('STAGE'),
    listMergedBlocks('AGENT'),
    listMergedBlocks('SENSOR'),
    listMergedBlocks('RULE'),
    listMergedBlocks('ARTIFACT'),
    listMergedBlocks('KNOWLEDGE'),
  ]);

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

// Fetch the runtime snapshot manifest for a pinned ref.
export const loadRuntimeManifest = async (ref) => {
  const text = await getObjectText(`aidlc-runtime/${ref}/manifest.json`);
  return text ? JSON.parse(text) : { ref, runtimeFiles: [], sensorScripts: [] };
};

// Fetch a single runtime file's content from the pinned snapshot.
export const loadRuntimeFile = async (ref, repoPath) =>
  getObjectText(`aidlc-runtime/${ref}/${repoPath}`);

export const __test = { assembleWorkflow, keyById, streamToString };
