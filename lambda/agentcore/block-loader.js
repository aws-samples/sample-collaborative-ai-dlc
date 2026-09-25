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
import { blockPk, catalogGsi1Pk, LATEST, sha256, versionSk } from '../shared/blocks.js';
import { workflowPk, workflowVersionPrefix } from '../shared/workflows.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from '../shared/tenant.js';
import {
  loadReleaseClosure,
  ReleaseResolverError,
  resolveMethodologyLibrary,
  resolveRuntimeFile,
} from '../shared/release-resolver.js';

const blocksTable = () => process.env.BLOCKS_TABLE;
const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;

// Repo-relative path of the conductor persona: read from the intent's immutable
// release closure when pinned, from the mutable `aidlc-runtime/<ref>/` otherwise.
const CONDUCTOR_REPO_PATH = 'core/aidlc-common/conductor.md';

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

const releaseClosure = (methodologyRelease) =>
  loadReleaseClosure({ s3, bucket: artifactsBucket(), methodologyRelease });

// Read one content-addressed release object and verify its sha256 before
// returning it. Absent ref ⇒ '' (the block genuinely carries no body/script);
// every other outcome throws a typed ReleaseResolverError.
const loadVerifiedReleaseObject = async ({ ref, methodologyRelease, label }) => {
  const s3Key = ref?.s3Key;
  if (!s3Key) return '';
  const closure = await releaseClosure(methodologyRelease);
  const expected = closure.objectDigests?.get?.(s3Key) ?? ref.sha256 ?? null;
  if (!expected) {
    throw new ReleaseResolverError(
      'release_object_unverifiable',
      `block-loader: release ${closure.releaseId} records no digest for ${label} object ${s3Key}`,
      { details: { s3Key, label } },
    );
  }
  // A catalog ref and the manifest object list disagreeing means the closure is
  // internally inconsistent — refuse before fetching rather than pick a winner.
  if (ref.sha256 && ref.sha256 !== expected) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `block-loader: catalog ${label} digest for ${s3Key} disagrees with the release manifest`,
      { details: { s3Key, label } },
    );
  }
  const content = await getObjectText(s3Key);
  if (sha256(content) !== expected) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `block-loader: ${label} object ${s3Key} does not match its recorded digest in release ${closure.releaseId}`,
      { details: { s3Key, label } },
    );
  }
  return content;
};

// Release-mode library: the intent's published closure is the base and explicit
// user-tenant pins the only overlay. `assertSystemSourceRef` still runs — release
// blocks carry `sourceRef = sourceSha`, so a pin/ref disagreement is still loud,
// it just can no longer be satisfied by a reseeded row.
const loadReleaseLibrary = async ({
  workflowId,
  workflowVersion,
  methodologyPins,
  aidlcRepoRef,
  methodologyRelease,
}) => {
  const closure = await releaseClosure(methodologyRelease);
  const { workflow, library, blocksByType, workflowSource } = await resolveMethodologyLibrary({
    closure,
    ddb,
    tableName: blocksTable(),
    workflowId,
    workflowVersion,
    methodologyPins,
  });
  assertSystemSourceRef({
    aidlcRepoRef,
    workflowTenant: workflowSource === 'release' ? SYSTEM_TENANT : DEFAULT_TENANT,
    workflow: { ...workflow, workflowId: workflow.workflowId ?? workflow.id ?? workflowId },
    blocksByType,
  });
  return {
    workflow,
    // `fromRelease` is the PROVENANCE FLAG buildExecutionPlan gates the authored
    // scope/stage policy on. It is stamped here — the one place that has actually
    // verified a release closure — and never inferred downstream.
    library: { ...library, fromRelease: true },
  };
};

// List one block type straight out of a pinned release closure (the composer
// reads SCOPE blocks for keyword/description grounding). The release-mode
// counterpart of listMergedBlocks, which must never run for a pinned intent.
export const listReleaseBlocks = async (type, methodologyRelease, methodologyPins = null) => {
  const closure = await releaseClosure(methodologyRelease);
  const byId = new Map(
    (closure.blocksByType?.[type] ?? []).map((block) => [block.id ?? block.blockId, block]),
  );
  const overlayPins = Object.fromEntries(
    Object.entries(methodologyPins?.[type] ?? {}).filter(
      ([, pin]) => pin?.tenantId && pin.tenantId !== SYSTEM_TENANT,
    ),
  );
  for (const block of await loadPinnedBlocks(type, overlayPins)) {
    byId.set(block.id ?? block.blockId, block);
  }
  return [...byId.values()];
};

// Load everything the runtime needs for one execution: the pinned workflow plus
// the library blocks (stages/agents/sensors/rules/artifacts) it references.
//
// `methodologyRelease` switches the source to the intent's immutable AI-DLC
// release closure (issue #482). Release mode reads no SYSTEM row and no catalog
// GSI at all, and fails closed: a missing or tampered closure throws a typed
// ReleaseResolverError rather than falling back to the reseedable SYSTEM rows.
export const loadLibrary = async ({
  workflowId,
  workflowVersion,
  methodologyPins = null,
  aidlcRepoRef = null,
  methodologyRelease = null,
}) => {
  if (methodologyRelease) {
    return loadReleaseLibrary({
      workflowId,
      workflowVersion,
      methodologyPins,
      aidlcRepoRef,
      methodologyRelease,
    });
  }
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
//
// With `methodologyRelease` the bytes are INTEGRITY-VERIFIED before they reach a
// prompt: a stage body or agent persona is the agent's whole instruction set, so
// serving tampered or truncated bytes is a silent methodology substitution. The
// expected digest comes from the release closure's `objectDigests` (built from
// `manifest.objects`); when that map is unavailable we fall back to the digest
// the CATALOG records on the ref, which is itself verified against the manifest
// digest by `loadReleaseClosure`. With neither we refuse rather than guess.
//
// Callers in release mode must NOT wrap these in `.catch(() => '')`: degrading a
// failed integrity check to an empty body is exactly the drift the release pin
// exists to prevent.
export const loadBlockBody = async (block, { methodologyRelease = null } = {}) =>
  methodologyRelease && (block?.tenantId ?? SYSTEM_TENANT) === SYSTEM_TENANT
    ? loadVerifiedReleaseObject({ ref: block?.bodyRef, methodologyRelease, label: 'body' })
    : getObjectText(block?.bodyRef?.s3Key);

// Fetch a sensor block's executable check script from S3 (its `scriptRef`).
// Returns '' when the block carries no script. The seed content-addresses the
// upstream `core/tools/aidlc-sensor-<id>.ts` here; a `script` sensor's runner
// materializes it to the workspace and spawns it against the checked-out code.
//
// A sensor script is EXECUTED in the workspace, so release mode verifies its
// digest on the same terms as a body — tampered bytes here are arbitrary code
// execution inside the session, not just a wrong verdict.
export const loadBlockScript = async (block, { methodologyRelease = null } = {}) =>
  methodologyRelease && (block?.tenantId ?? SYSTEM_TENANT) === SYSTEM_TENANT
    ? loadVerifiedReleaseObject({ ref: block?.scriptRef, methodologyRelease, label: 'script' })
    : getObjectText(block?.scriptRef?.s3Key);

// Fetch the runtime snapshot manifest for a pinned ref.
export const loadRuntimeManifest = async (ref) => {
  const text = await getObjectText(`aidlc-runtime/${ref}/manifest.json`);
  return text ? JSON.parse(text) : { ref, runtimeFiles: [], sensorScripts: [] };
};

// Fetch the conductor persona (execution-quality doctrine) from the pinned
// runtime snapshot. The stage prompt injects it so the quality guidance can
// never drift from upstream's authored `conductor.md`. '' when the ref/file is
// absent (the annex's distilled quality section still applies).
//
// With `methodologyRelease` the bytes come from the intent's release closure and
// are digest-verified; there is no `aidlc-runtime/` fallback and no empty-string
// degradation, because a silently missing conductor is drift we cannot detect.
export const loadConductor = async (ref, { methodologyRelease = null } = {}) => {
  if (methodologyRelease) {
    const closure = await releaseClosure(methodologyRelease);
    const file = await resolveRuntimeFile({
      s3,
      bucket: artifactsBucket(),
      closure,
      repoPath: CONDUCTOR_REPO_PATH,
    });
    return file.content;
  }
  return ref ? getObjectText(`aidlc-runtime/${ref}/${CONDUCTOR_REPO_PATH}`) : '';
};

export const __test = {
  assembleWorkflow,
  keyById,
  streamToString,
  loadPlacedStages,
  loadPinnedBlocks,
  assertSystemSourceRef,
};
