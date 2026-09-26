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
import {
  loadReleaseClosure,
  resolveMethodologyLibrary,
  resolveReleaseWorkflow,
} from './release-resolver.js';

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
//
// `methodologyRelease` switches the library source to the intent's immutable
// AI-DLC release closure in S3 (issue #482, requires `s3` + `bucket`). Release
// mode reads no SYSTEM DynamoDB row at all and fails closed: a missing or
// tampered closure becomes `{ valid: false }` with the resolver's error code,
// never a silent fall back to the reseedable SYSTEM rows.
/**
 * The pin set a RELEASE-mode plan persists. Every block that came from the
 * closure carries `tenantId: SYSTEM` and `version: 1` by construction, so
 * pinning it would be worse than useless: those coordinates are precisely the
 * ones a SYSTEM reseed rewrites in place, and the pin would point at whatever
 * the reseed left behind instead of at the release's immutable bytes. The
 * release pin on the META row already names the exact closure.
 *
 * Only user-tenant overlay pins are real, so a type with none is omitted rather
 * than recorded as an empty map (an empty map reads as "pin nothing of this
 * type", which would starve the library if the set were ever replayed).
 */
const userTenantPins = (blocks) => {
  const pins = pinsForBlocks(blocks.filter((block) => block?.tenantId !== SYSTEM_TENANT));
  return Object.keys(pins).length > 0 ? pins : null;
};

const pinsFromLibrary = (library) =>
  Object.fromEntries(
    Object.entries({
      STAGE: library.stagesById,
      AGENT: library.agentsById,
      SENSOR: library.sensorsById,
      RULE: library.rulesById,
      ARTIFACT: library.artifactsById,
      KNOWLEDGE: library.knowledgeById,
    })
      .map(([type, byId]) => [type, userTenantPins(Object.values(byId ?? {}))])
      .filter(([, pins]) => pins !== null),
  );

const loadReleaseExecutionPlan = async ({
  ddb,
  tableName,
  s3,
  bucket,
  methodologyRelease,
  workflowId,
  workflowVersion,
  scope,
  skipStageIds,
  composedGrid,
  strict,
  methodologyPins,
}) => {
  let resolved;
  try {
    const closure = await loadReleaseClosure({ s3, bucket, methodologyRelease });
    resolved = await resolveMethodologyLibrary({
      closure,
      ddb,
      tableName,
      workflowId,
      workflowVersion,
      methodologyPins,
    });
  } catch (error) {
    // Same permanent-vs-transient split as loadWorkflowScopes: only a genuine
    // resolution failure becomes an invalid plan (a typed 4xx for the caller).
    // A transient fault must surface as 5xx, not as "this scope is not runnable".
    if (!isReleaseResolutionError(error)) throw error;
    return {
      valid: false,
      errors: [
        {
          code: error?.code ?? 'release_resolution_failed',
          message: error?.message ?? String(error),
          workflowId,
          workflowVersion,
        },
      ],
      plan: null,
    };
  }
  const result = buildExecutionPlan({
    workflow: resolved.workflow,
    scope,
    library: resolved.library,
    skipStageIds,
    composedGrid,
    strict,
  });
  return {
    ...result,
    workflowVersion: resolved.workflow.workflowVersion,
    methodologySourceRefs: resolved.methodologySourceRefs,
    methodologyPins: methodologyPins ?? pinsFromLibrary(resolved.library),
  };
};

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
  methodologyRelease = null,
  s3 = null,
  bucket = null,
}) => {
  if (methodologyRelease) {
    return loadReleaseExecutionPlan({
      ddb,
      tableName,
      s3,
      bucket,
      methodologyRelease,
      workflowId,
      workflowVersion,
      scope,
      skipStageIds,
      composedGrid,
      strict,
      methodologyPins,
    });
  }
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
  const [stages, agents, sensors, rules, artifacts, knowledge, scopes] = await Promise.all([
    loadPlacedStages(ddb, tableName, workflow.placements, methodologyPins?.STAGE),
    loadLibraryType(ddb, tableName, 'AGENT', methodologyPins),
    loadLibraryType(ddb, tableName, 'SENSOR', methodologyPins),
    loadLibraryType(ddb, tableName, 'RULE', methodologyPins),
    loadLibraryType(ddb, tableName, 'ARTIFACT', methodologyPins),
    loadLibraryType(ddb, tableName, 'KNOWLEDGE', methodologyPins),
    // SCOPE blocks carry the per-scope execution policy release catalogs may
    // author. They are NOT added to methodologyPins or
    // methodologySourceRefs: pinning them would change the shape of an already
    // persisted pin set, so the policy is read from the resolved catalog only.
    listMergedBlocks(ddb, tableName, 'SCOPE'),
  ]);
  const library = {
    stagesById: keyById(stages),
    agentsById: keyById(agents),
    sensorsById: keyById(sensors),
    rulesById: keyById(rules),
    artifactsById: keyById(artifacts),
    scopesById: keyById(scopes),
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
// A release that genuinely does not resolve (missing, tampered, import-only,
// mismatched pin) is a permanent, caller-visible condition: the scope vocabulary
// is empty and every scope choice is rejected. A transient S3 or DynamoDB fault
// is NOT — swallowing it would present an empty vocabulary on a retryable blip
// and reject a perfectly valid scope, so it propagates and becomes a 5xx.
const RELEASE_RESOLUTION_ERROR_CODES = new Set([
  'release_pin_invalid',
  'release_not_found',
  'release_not_runnable',
  'release_closure_mismatch',
  'release_closure_too_large',
  'workflow_not_found',
  'unpinned_user_block',
  'user_block_missing',
]);

// `loadReleaseClosure` reads the manifest through `aidlc-release.js`, which raises
// `AidlcReleaseError` rather than `ReleaseResolverError`. Every one of those codes
// describes CONTENT the platform refuses (malformed, oversized, wrong-provenance,
// or unpublished bytes) — none is retryable — so they classify permanent too.
// Omitting them turned a structurally invalid manifest into a 5xx that a caller
// would retry forever instead of a typed "this release is not usable".
const RELEASE_MANIFEST_ERROR_CODES = new Set([
  'release_manifest_invalid',
  'release_manifest_too_large',
  'release_not_published',
  'release_verification_failed',
  'release_conflict',
  'release_sha_invalid',
  'release_importer_revision_invalid',
  'release_source_invalid',
  'release_object_invalid',
  'release_object_hash_invalid',
  'release_object_conflict',
  'release_profile_unknown',
  'release_import_rejected',
]);

const isReleaseResolutionError = (error) =>
  (error?.name === 'ReleaseResolverError' && RELEASE_RESOLUTION_ERROR_CODES.has(error.code)) ||
  (error?.name === 'AidlcReleaseError' && RELEASE_MANIFEST_ERROR_CODES.has(error.code));

const loadWorkflowScopes = async ({
  ddb,
  tableName,
  workflowId,
  workflowVersion,
  methodologyRelease = null,
  s3 = null,
  bucket = null,
}) => {
  if (methodologyRelease) {
    try {
      const closure = await loadReleaseClosure({ s3, bucket, methodologyRelease });
      const { workflow } = await resolveReleaseWorkflow({
        closure,
        ddb,
        tableName,
        workflowId,
        workflowVersion,
      });
      return [...workflowScopes(workflow)];
    } catch (error) {
      if (!isReleaseResolutionError(error)) throw error;
      // An unresolvable release offers no scopes, so every scope choice is
      // rejected by the caller — the same fail-closed outcome as a missing
      // workflow snapshot, without leaking the reseedable SYSTEM vocabulary.
      return [];
    }
  }
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
