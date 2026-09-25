// Read side of the immutable release store.
//
// The importer publishes one AI-DLC release as an immutable closure (manifest +
// catalog + content-addressed objects). This module turns the `methodologyRelease`
// pin carried on an execution META row back into the runnable methodology
// library, WITHOUT reading a single SYSTEM DynamoDB row.
//
// That exclusion is the whole point. The SYSTEM seed deletes and rewrites
// BLOCK#SYSTEM#*/WF#SYSTEM# V#1 in place, so a pin of (SYSTEM, V#1) silently
// resolves to different content after a reseed. A release pin resolves to the
// exact bytes published for one source SHA, forever.
//
// Every failure here is fail-closed: a missing, tampered, or mismatching
// closure throws. There is deliberately no fallback to the legacy catalog, to
// aidlc-runtime/, or to DynamoDB — a silent downgrade would reintroduce exactly
// the drift the release identity exists to prevent.
//
// Clients are injected (shared/ is a leaf foundation, see .dependency-cruiser.cjs).

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { blockPk, sha256, versionSk } from './blocks.js';
import { bodyToString, bodyToStringWithin, isNotFound } from './methodology-catalog.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from './tenant.js';
import { canonicalJson } from './workflow-checkpoint.js';
import { workflowPk, workflowVersionPrefix } from './workflows.js';
import { AIDLC_RELEASE_IMPORTER_REVISION, readReleaseManifest } from './aidlc-release.js';

const LIBRARY_TYPES = Object.freeze({
  STAGE: 'stagesById',
  AGENT: 'agentsById',
  SENSOR: 'sensorsById',
  RULE: 'rulesById',
  ARTIFACT: 'artifactsById',
  KNOWLEDGE: 'knowledgeById',
  SCOPE: 'scopesById',
});

// Immutable closures are safe to memoize for the life of a warm Lambda. The
// bound keeps a long-lived container from pinning every release ever resolved.
const RELEASE_CLOSURE_CACHE_LIMIT = 8;
const releaseClosureCache = new Map();

// A manifest or catalog body is JSON we fully buffer into the Lambda heap before
// we can validate anything about it. Cap it so a corrupted or hostile object
// cannot OOM the container: a real closure catalog is tens of KB.
const RELEASE_JSON_MAX_BYTES = 20 * 1024 * 1024;

class ReleaseResolverError extends Error {
  constructor(code, message, { cause, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ReleaseResolverError';
    this.code = code;
    this.details = details;
  }
}

// Two releases can share (releaseId, closureDigest) only if they are the same
// bytes, but the importer revision and source SHA are what actually address the
// stored objects. Including these values prevents a closure produced by a newer
// importer revision from being served from a stale cache entry.
const closureCacheKey = ({ releaseId, sourceSha, importerRevision, closureDigest }) =>
  [
    releaseId,
    sourceSha,
    Number(importerRevision ?? AIDLC_RELEASE_IMPORTER_REVISION),
    closureDigest,
  ].join('\u0000');

const readCachedClosure = (cache, key) => {
  const cached = cache?.get(key);
  if (!cached) return null;
  // Re-insert so the eviction order below is true LRU rather than insertion
  // order: a hot closure must not be evicted by eight cold lookups.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
};

const rememberClosure = (cache, key, closure) => {
  cache.set(key, closure);
  while (cache.size > RELEASE_CLOSURE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return closure;
};

const assertJsonBodyWithinCap = (bytes, key) => {
  if (Number(bytes) > RELEASE_JSON_MAX_BYTES) {
    throw new ReleaseResolverError(
      'release_closure_too_large',
      `release-resolver: ${key} is ${bytes} bytes, over the ${RELEASE_JSON_MAX_BYTES}-byte release JSON cap`,
      { details: { key, bytes: Number(bytes), limit: RELEASE_JSON_MAX_BYTES } },
    );
  }
  return bytes;
};

const blockIdOf = (block) => block?.blockId ?? block?.id ?? null;

const keyById = (items) => {
  const byId = {};
  for (const item of items ?? []) {
    const id = blockIdOf(item);
    if (id) byId[id] = item;
  }
  return byId;
};

const positiveVersion = (value) => {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
};

/**
 * The subset of a published manifest an execution META row pins. Everything in
 * it is verified on every load, so a pin can never widen into a different
 * release.
 */
const methodologyReleasePinFromManifest = (manifest) => ({
  releaseId: manifest.releaseId,
  sourceSha: manifest.sourceSha,
  importerRevision: manifest.importerRevision,
  closureDigest: manifest.closureDigest,
  catalogKey: manifest.catalog.key,
  manifestKey: `aidlc-releases/v${manifest.schemaVersion}/${manifest.sourceSha}/i${manifest.importerRevision}/manifest.json`,
});

const assertPinMatchesManifest = ({ pin, manifest }) => {
  const mismatched = [
    ['releaseId', pin.releaseId, manifest.releaseId],
    ['sourceSha', pin.sourceSha, manifest.sourceSha],
    ['importerRevision', Number(pin.importerRevision), Number(manifest.importerRevision)],
    ['closureDigest', pin.closureDigest, manifest.closureDigest],
    ['catalogKey', pin.catalogKey, manifest.catalog.key],
  ].filter(([, pinned, published]) => pinned != null && pinned !== published);
  if (mismatched.length > 0) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `release-resolver: pinned release does not match the published manifest (${mismatched
        .map(([field]) => field)
        .join(', ')})`,
      { details: { fields: mismatched.map(([field]) => field) } },
    );
  }
};

const readClosureCatalog = async ({ s3, bucket, manifest }) => {
  let body = null;
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: manifest.catalog.key }),
    );
    // The declared length is checked BEFORE the stream is drained, so an object
    // that honestly reports its size never starts downloading. The reader then
    // counts the bytes it actually accepts, which is the bound that holds when
    // ContentLength is absent or understated.
    assertJsonBodyWithinCap(result.ContentLength ?? 0, manifest.catalog.key);
    body = await bodyToStringWithin(result.Body, RELEASE_JSON_MAX_BYTES, (bytes) =>
      assertJsonBodyWithinCap(bytes, manifest.catalog.key),
    );
  } catch (error) {
    if (error instanceof ReleaseResolverError) throw error;
    if (!isNotFound(error)) throw error;
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `release-resolver: catalog ${manifest.catalog.key} is missing from a published release`,
      { cause: error },
    );
  }
  let catalog;
  try {
    catalog = JSON.parse(body);
  } catch (error) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `release-resolver: catalog ${manifest.catalog.key} is not valid JSON`,
      { cause: error },
    );
  }
  // Hash the canonical form: the manifest digest is independent of how the
  // catalog bytes were pretty-printed, but any content drift still fails.
  if (sha256(canonicalJson(catalog)) !== manifest.catalog.sha256) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `release-resolver: catalog ${manifest.catalog.key} does not match the manifest digest`,
    );
  }
  return catalog;
};

/**
 * Resolves and verifies the immutable closure a `methodologyRelease` pin names.
 * Throws `release_not_found` when the release was never published and
 * `release_closure_mismatch` on any drift between pin, manifest, and catalog.
 */
const loadReleaseClosure = async ({
  s3,
  bucket,
  methodologyRelease,
  cache = releaseClosureCache,
}) => {
  if (!methodologyRelease?.sourceSha || !methodologyRelease?.closureDigest) {
    throw new ReleaseResolverError(
      'release_pin_invalid',
      'release-resolver: methodologyRelease must carry sourceSha and closureDigest',
    );
  }
  if (!s3 || !bucket) {
    throw new ReleaseResolverError(
      'release_pin_invalid',
      'release-resolver: an S3 client and bucket are required to resolve a release',
    );
  }
  const cacheKey = closureCacheKey(methodologyRelease);
  const cached = readCachedClosure(cache, cacheKey);
  if (cached) return cached;

  const manifest = await readReleaseManifest({
    s3,
    bucket,
    sha: methodologyRelease.sourceSha,
    importerRevision: Number(
      methodologyRelease.importerRevision ?? AIDLC_RELEASE_IMPORTER_REVISION,
    ),
  });
  if (!manifest) {
    throw new ReleaseResolverError(
      'release_not_found',
      `release-resolver: no published release manifest for ${methodologyRelease.sourceSha}`,
      { details: { sourceSha: methodologyRelease.sourceSha } },
    );
  }
  // Defense in depth. The registry already refuses to make a T0/custom release
  // selectable, but selection and execution are separate surfaces: a pin can
  // also arrive from a hand-edited META row, a restored backup, or a future
  // code path. Runnability is re-decided here from the manifest's own
  // provenance, so untrusted methodology can be imported and inspected but
  // never executed until sandboxed execution and IAM isolation exist.
  if (manifest.trustTier === 'T0' || manifest.custom === true) {
    throw new ReleaseResolverError(
      'release_not_runnable',
      `release-resolver: release ${manifest.releaseId} is import-only (trustTier ${String(manifest.trustTier)}) and must never execute`,
      {
        details: {
          releaseId: manifest.releaseId,
          sourceSha: manifest.sourceSha,
          sourceRepository: manifest.sourceRepository ?? null,
          trustTier: manifest.trustTier ?? null,
          custom: manifest.custom === true,
        },
      },
    );
  }
  assertPinMatchesManifest({ pin: methodologyRelease, manifest });

  const catalog = await readClosureCatalog({ s3, bucket, manifest });
  const closure = Object.freeze({
    releaseId: manifest.releaseId,
    sourceSha: manifest.sourceSha,
    importerRevision: manifest.importerRevision,
    closureDigest: manifest.closureDigest,
    catalog,
    blocksByType: catalog.blocks ?? {},
    // Every content-addressed object the manifest claims, keyed by its S3 key.
    // Block bodies and sensor scripts are loaded lazily by the runtime, which
    // has no other way to prove the bytes it fetched are the bytes this release
    // published — so the digest index has to travel with the closure.
    objectDigests: new Map((manifest.objects ?? []).map((object) => [object.key, object.sha256])),
    runtimeFiles: new Map(
      (manifest.runtimeFiles ?? []).map((file) => [
        file.path,
        { sha256: file.sha256, key: file.key },
      ]),
    ),
  });
  return cache ? rememberClosure(cache, cacheKey, closure) : closure;
};

const getUserBlock = async ({ ddb, tableName, tenantId, type, blockId, version }) => {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: blockPk(tenantId, type, blockId), sk: versionSk(version) },
    }),
  );
  if (!result.Item) {
    throw new ReleaseResolverError(
      'user_block_missing',
      `release-resolver: user ${type} block ${blockId} V#${version} (${tenantId}) is unavailable`,
      { details: { type, blockId, tenantId, version } },
    );
  }
  return result.Item;
};

/**
 * User-tenant overlays are the only DynamoDB reads release mode performs. Each
 * one must name an explicit immutable version: a `V#latest` read would let a
 * later user edit change what an already-created intent runs.
 */
const loadUserOverlay = async ({ ddb, tableName, methodologyPins }) => {
  const requests = [];
  for (const [type, pins] of Object.entries(methodologyPins ?? {})) {
    if (!LIBRARY_TYPES[type]) continue;
    for (const [blockId, pin] of Object.entries(pins ?? {})) {
      if (!pin || pin.tenantId === SYSTEM_TENANT) continue;
      const version = positiveVersion(pin.version);
      if (!version) {
        throw new ReleaseResolverError(
          'unpinned_user_block',
          `release-resolver: ${type} block ${blockId} (${pin.tenantId}) has no immutable pinned version`,
          { details: { type, blockId, tenantId: pin.tenantId } },
        );
      }
      requests.push({ type, blockId, tenantId: pin.tenantId, version });
    }
  }
  const blocks = await Promise.all(
    requests.map((request) => getUserBlock({ ddb, tableName, ...request })),
  );
  const byType = {};
  for (const [index, request] of requests.entries()) {
    byType[request.type] ??= {};
    byType[request.type][request.blockId] = blocks[index];
  }
  return byType;
};

const loadUserForkWorkflow = async ({
  ddb,
  tableName,
  workflowId,
  workflowVersion,
  tenant = DEFAULT_TENANT,
}) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    // SYSTEM workflow rows are never queried in release mode: the release
    // catalog IS the SYSTEM workflow for this intent.
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :v)',
        ExpressionAttributeValues: {
          ':pk': workflowPk(tenant, workflowId),
          ':v': workflowVersionPrefix(workflowVersion),
        },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

const assembleForkWorkflow = (items, { workflowId, workflowVersion }) => {
  const liveSk = (sk) => sk.replace(workflowVersionPrefix(workflowVersion), '');
  const workflow = {
    id: workflowId,
    workflowId,
    workflowVersion: Number(workflowVersion),
    sourceRef: null,
    placements: [],
    ruleRefs: [],
    scopeRefs: [],
    phases: [],
  };
  for (const item of items) {
    const sk = liveSk(item.sk);
    if (sk === 'META') {
      workflow.sourceRef = item.sourceRef ?? null;
    } else if (sk.startsWith('PLACEMENT#')) {
      workflow.placements.push({
        stageId: item.stageId,
        stageTenant: item.stageTenant ?? null,
        pinnedVersion: item.pinnedVersion ?? null,
        order: item.order ?? 0,
        phasePath: item.phasePath ?? null,
        scopeMembership: item.scopeMembership ?? {},
      });
    } else if (sk.startsWith('RULEREF#')) {
      workflow.ruleRefs.push({ layer: item.layer, ruleId: item.ruleId });
    } else if (sk.startsWith('SCOPEREF#')) {
      workflow.scopeRefs.push({ scopeId: item.scopeId });
    } else if (sk.startsWith('PHASE#')) {
      workflow.phases.push({ phaseId: item.phaseId, path: item.path ?? null });
    }
  }
  return workflow;
};

/**
 * The release catalog carries exactly one workflow. A user fork of the same id
 * keeps its own immutable WF#default#<id> V#<n> snapshot, which release mode
 * reads for the workflow composition only — the block library still comes from
 * the release plus explicit user pins.
 */
const resolveReleaseWorkflow = async ({
  closure,
  ddb,
  tableName,
  workflowId,
  workflowVersion,
  tenant = DEFAULT_TENANT,
}) => {
  const catalogWorkflow = closure.catalog?.workflow ?? null;
  if (
    catalogWorkflow?.id === workflowId &&
    Number(workflowVersion) === Number(catalogWorkflow.workflowVersion)
  ) {
    return { workflow: catalogWorkflow, workflowSource: 'release' };
  }
  const items = await loadUserForkWorkflow({
    ddb,
    tableName,
    workflowId,
    workflowVersion,
    tenant,
  });
  if (items.length === 0) {
    // The release closure is authoritative when the requested workflow has no
    // user-fork snapshot, even if the mutable project points at a newer version.
    if (catalogWorkflow?.id === workflowId) {
      return { workflow: catalogWorkflow, workflowSource: 'release' };
    }
    throw new ReleaseResolverError(
      'workflow_not_found',
      `release-resolver: workflow ${workflowId} V#${workflowVersion} is not in release ${closure.releaseId} and has no user-fork snapshot`,
      { details: { workflowId, workflowVersion } },
    );
  }
  return {
    workflow: assembleForkWorkflow(items, { workflowId, workflowVersion }),
    workflowSource: 'ddb-user-fork',
  };
};

/**
 * Release mode resolves placed stages without ever reading V#latest: a
 * user-tenant placement must carry an explicit `pinnedVersion` or a user pin,
 * and SYSTEM placements resolve from the release catalog.
 */
const resolvePlacedStages = async ({ ddb, tableName, workflow, baseStagesById, overlayStages }) => {
  const requests = [];
  for (const placement of workflow.placements ?? []) {
    const tenantId = placement.stageTenant ?? SYSTEM_TENANT;
    if (tenantId === SYSTEM_TENANT) continue;
    if (overlayStages?.[placement.stageId]) continue;
    const version = positiveVersion(placement.pinnedVersion);
    if (!version) {
      throw new ReleaseResolverError(
        'unpinned_user_block',
        `release-resolver: placement for STAGE ${placement.stageId} (${tenantId}) has no pinned version`,
        { details: { type: 'STAGE', blockId: placement.stageId, tenantId } },
      );
    }
    requests.push({ type: 'STAGE', blockId: placement.stageId, tenantId, version });
  }
  const blocks = await Promise.all(
    requests.map((request) => getUserBlock({ ddb, tableName, ...request })),
  );
  const stagesById = { ...baseStagesById, ...overlayStages };
  for (const [index, request] of requests.entries()) {
    stagesById[request.blockId] = blocks[index];
  }
  return stagesById;
};

/**
 * Builds the methodology library a plan is assembled from: the release catalog
 * as the base, explicit user-tenant pins as the only overlay.
 */
const resolveMethodologyLibrary = async ({
  closure,
  ddb,
  tableName,
  workflowId,
  workflowVersion,
  methodologyPins = null,
  tenant = DEFAULT_TENANT,
}) => {
  const { workflow, workflowSource } = await resolveReleaseWorkflow({
    closure,
    ddb,
    tableName,
    workflowId,
    workflowVersion,
    tenant,
  });
  const overlay = await loadUserOverlay({ ddb, tableName, methodologyPins });
  const blocksByType = {};
  const library = {};
  for (const [type, libraryKey] of Object.entries(LIBRARY_TYPES)) {
    const merged = { ...keyById(closure.blocksByType?.[type]), ...overlay[type] };
    library[libraryKey] = merged;
    blocksByType[type] = Object.values(merged);
  }
  library.stagesById = await resolvePlacedStages({
    ddb,
    tableName,
    workflow,
    baseStagesById: keyById(closure.blocksByType?.STAGE),
    overlayStages: overlay.STAGE,
  });
  blocksByType.STAGE = Object.values(library.stagesById);
  // Provenance flag buildExecutionPlan gates release-authored scope policy on.
  library.fromRelease = true;
  // The closure's runtime engine files, by path: a capability whose presence
  // test is a runtime file (Plan Approval) is answered from this list, so the
  // plan resolves the same capabilities the analyzer classified at import.
  library.runtimeFilePaths = [...(closure.runtimeFiles?.keys() ?? [])].toSorted();
  return {
    workflow,
    library,
    blocksByType,
    methodologySourceRefs: [closure.sourceSha],
    workflowSource,
  };
};

/**
 * Reads one runtime engine file from the release closure. Content-addressed and
 * digest-verified; there is no fallback to the mutable `aidlc-runtime/` prefix.
 */
const resolveRuntimeFile = async ({ s3, bucket, closure, repoPath }) => {
  const entry = closure?.runtimeFiles?.get(repoPath);
  if (!entry) {
    throw new ReleaseResolverError(
      'runtime_file_missing',
      `release-resolver: ${repoPath} is not part of release ${closure?.releaseId}`,
      { details: { repoPath } },
    );
  }
  let content;
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: entry.key }));
    content = await bodyToString(result.Body);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    throw new ReleaseResolverError(
      'runtime_file_missing',
      `release-resolver: runtime object ${entry.key} for ${repoPath} is missing`,
      { cause: error, details: { repoPath, key: entry.key } },
    );
  }
  if (sha256(content) !== entry.sha256) {
    throw new ReleaseResolverError(
      'release_closure_mismatch',
      `release-resolver: runtime object ${entry.key} for ${repoPath} does not match its recorded digest`,
      { details: { repoPath, key: entry.key } },
    );
  }
  return { path: repoPath, key: entry.key, sha256: entry.sha256, content };
};

const __test = {
  releaseClosureCache,
  RELEASE_CLOSURE_CACHE_LIMIT,
  RELEASE_JSON_MAX_BYTES,
  closureCacheKey,
};

export {
  __test,
  loadReleaseClosure,
  methodologyReleasePinFromManifest,
  ReleaseResolverError,
  resolveMethodologyLibrary,
  resolveReleaseWorkflow,
  resolveRuntimeFile,
};

export default {
  loadReleaseClosure,
  methodologyReleasePinFromManifest,
  ReleaseResolverError,
  resolveMethodologyLibrary,
  resolveReleaseWorkflow,
  resolveRuntimeFile,
};
