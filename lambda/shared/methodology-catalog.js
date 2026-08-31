import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildFromFiles } from './block-mappers.js';
import { BLOCK_TYPES, buildBodyRef, buildScriptRef } from './blocks.js';
import { buildExecutionPlan } from './v2-execution-plan.js';
import { fetchCoreFiles } from './repo-fetch.js';
import { isCommitSha } from './aidlc-ref.js';
import { SYSTEM_TENANT } from './tenant.js';
import { canonicalJson } from './workflow-checkpoint.js';

const METHODOLOGY_CATALOG_SCHEMA_VERSION = 1;
const methodologyCatalogKey = (ref) =>
  `aidlc-catalogs/v${METHODOLOGY_CATALOG_SCHEMA_VERSION}/${ref}.json`;

const keyById = (items) => Object.fromEntries(items.map((item) => [item.id, item]));

const blockPin = (block) => ({
  tenantId: block.tenantId,
  version: Number(block.version),
});

const pinsForBlocks = (blocks) =>
  Object.fromEntries(blocks.map((block) => [block.id, blockPin(block)]));

const catalogBlock = ({ block, ref, sensorScripts }) => {
  const { body, script: _script, ...metadata } = block;
  const script = block.type === 'SENSOR' ? (sensorScripts.get(block.id)?.content ?? null) : null;
  return {
    ...metadata,
    tenantId: SYSTEM_TENANT,
    blockId: block.id,
    version: 1,
    sourceRef: ref,
    ...(body ? { bodyRef: buildBodyRef(body) } : {}),
    ...(script ? { scriptRef: buildScriptRef(script) } : {}),
  };
};

const catalogWorkflow = (workflow, ref) => ({
  ...workflow,
  workflowVersion: 1,
  sourceRef: ref,
  placements: (workflow.placements ?? []).map((placement) => ({
    ...placement,
    stageTenant: placement.stageTenant ?? SYSTEM_TENANT,
    pinnedVersion: placement.pinnedVersion ?? 1,
  })),
  ruleRefs: (workflow.ruleRefs ?? []).map((ruleRef) => ({
    ...ruleRef,
    ruleTenant: ruleRef.ruleTenant ?? SYSTEM_TENANT,
  })),
  scopeRefs: (workflow.scopeRefs ?? []).map((scopeRef) => ({
    ...scopeRef,
    scopeTenant: scopeRef.scopeTenant ?? SYSTEM_TENANT,
  })),
});

/**
 * Captures the structured SYSTEM methodology for one immutable upstream commit.
 * Markdown bodies and scripts remain in their content-addressed S3 objects.
 */
const buildMethodologyCatalog = ({ ref, blocks, workflow, sensorScripts = new Map() }) => {
  if (!isCommitSha(ref)) throw new Error('methodology-catalog: ref must be a commit SHA');
  const grouped = Object.fromEntries(BLOCK_TYPES.map((type) => [type, []]));
  for (const block of blocks) {
    if (!grouped[block.type]) grouped[block.type] = [];
    grouped[block.type].push(catalogBlock({ block, ref, sensorScripts }));
  }
  for (const items of Object.values(grouped)) {
    items.sort((left, right) => left.id.localeCompare(right.id));
  }
  const catalog = {
    schemaVersion: METHODOLOGY_CATALOG_SCHEMA_VERSION,
    ref: ref.toLowerCase(),
    workflow: catalogWorkflow(workflow, ref.toLowerCase()),
    blocks: grouped,
  };
  // Match the exact JSON representation persisted to S3: omit undefined
  // mapper fields so immutable-write comparisons are stable across reads.
  return JSON.parse(JSON.stringify(catalog));
};

const validateMethodologyCatalog = (catalog, expectedRef) => {
  if (
    catalog?.schemaVersion !== METHODOLOGY_CATALOG_SCHEMA_VERSION ||
    catalog?.ref !== expectedRef ||
    !catalog.workflow ||
    !catalog.blocks ||
    !Array.isArray(catalog.blocks.STAGE)
  ) {
    throw new Error(`methodology-catalog: invalid catalog for ${expectedRef}`);
  }
  return catalog;
};

const bodyToString = async (body) => {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  if (Buffer.isBuffer(body) || body instanceof Uint8Array)
    return Buffer.from(body).toString('utf8');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const isNotFound = (error) =>
  error?.name === 'NoSuchKey' ||
  error?.name === 'NotFound' ||
  error?.$metadata?.httpStatusCode === 404;
const isPreconditionFailed = (error) =>
  error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;

const readMethodologyCatalog = async ({ s3, bucket, ref }) => {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: methodologyCatalogKey(ref),
      }),
    );
    return validateMethodologyCatalog(JSON.parse(await bodyToString(result.Body)), ref);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

const writeMethodologyCatalog = async ({ s3, bucket, catalog }) => {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: methodologyCatalogKey(catalog.ref),
        Body: `${JSON.stringify(catalog, null, 2)}\n`,
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    );
    return catalog;
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    const existing = await readMethodologyCatalog({ s3, bucket, ref: catalog.ref });
    if (!existing || canonicalJson(existing) !== canonicalJson(catalog)) {
      throw new Error(`methodology-catalog: immutable catalog conflict for ${catalog.ref}`, {
        cause: error,
      });
    }
    return existing;
  }
};

/**
 * Loads a commit-pinned catalog, rebuilding and caching it from core/** for
 * intents created before catalog snapshots were introduced.
 */
const loadOrCreateMethodologyCatalog = async ({ s3, bucket, ref }) => {
  if (!isCommitSha(ref)) throw new Error('methodology-catalog: ref must be a commit SHA');
  const normalizedRef = ref.toLowerCase();
  const cached = await readMethodologyCatalog({ s3, bucket, ref: normalizedRef });
  if (cached) return cached;
  const files = await fetchCoreFiles(normalizedRef);
  const { blocks, workflow, sensorScripts } = buildFromFiles(files);
  const catalog = buildMethodologyCatalog({
    ref: normalizedRef,
    blocks,
    workflow,
    sensorScripts,
  });
  return writeMethodologyCatalog({ s3, bucket, catalog });
};

/**
 * Reconstructs the same runnable plan normally assembled from SYSTEM DynamoDB
 * rows, using the immutable catalog for the intent's pinned commit instead.
 */
const executionPlanFromMethodologyCatalog = ({
  catalog,
  workflowId,
  workflowVersion,
  scope,
  skipStageIds = null,
  composedGrid = null,
  strict = false,
}) => {
  if (
    catalog.workflow.id !== workflowId ||
    Number(catalog.workflow.workflowVersion) !== Number(workflowVersion)
  ) {
    return {
      valid: false,
      errors: [{ code: 'workflow_not_found', workflowId, workflowVersion }],
      plan: null,
    };
  }
  const stages = catalog.blocks.STAGE ?? [];
  const agents = catalog.blocks.AGENT ?? [];
  const sensors = catalog.blocks.SENSOR ?? [];
  const rules = catalog.blocks.RULE ?? [];
  const artifacts = catalog.blocks.ARTIFACT ?? [];
  const knowledge = catalog.blocks.KNOWLEDGE ?? [];
  const result = buildExecutionPlan({
    workflow: catalog.workflow,
    scope,
    library: {
      stagesById: keyById(stages),
      agentsById: keyById(agents),
      sensorsById: keyById(sensors),
      rulesById: keyById(rules),
      artifactsById: keyById(artifacts),
    },
    skipStageIds,
    composedGrid,
    strict,
  });
  return {
    ...result,
    methodologySourceRefs: [catalog.ref],
    methodologyPins: {
      STAGE: pinsForBlocks(stages),
      AGENT: pinsForBlocks(agents),
      SENSOR: pinsForBlocks(sensors),
      RULE: pinsForBlocks(rules),
      ARTIFACT: pinsForBlocks(artifacts),
      KNOWLEDGE: pinsForBlocks(knowledge),
    },
  };
};

export {
  METHODOLOGY_CATALOG_SCHEMA_VERSION,
  buildMethodologyCatalog,
  executionPlanFromMethodologyCatalog,
  loadOrCreateMethodologyCatalog,
  methodologyCatalogKey,
  readMethodologyCatalog,
  writeMethodologyCatalog,
};
