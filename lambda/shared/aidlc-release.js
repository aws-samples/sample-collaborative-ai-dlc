// Immutable staged storage for one imported AI-DLC release. The compatibility
// modules decide whether an allowlisted upstream commit is
// importable; this module turns an importable commit into a byte-stable bundle
// and publishes it under its own immutable prefix.
//
// Why a separate store: the SYSTEM seed rewrites BLOCK#SYSTEM#*/WF#SYSTEM# rows
// and V#1 snapshots in place, so an existing intent pinned to (SYSTEM, V#1)
// silently resolves to different content after a reseed. A release must instead
// be addressable forever by the exact source SHA it was imported from, which
// means: no mutation of anything the running platform reads, no timestamps in
// the manifest, and a single publication marker written last.
//
// Nothing here selects, activates, or executes a release. Runtime loaders use
// the published closure.

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  OFFICIAL_AIDLC_REPOSITORY,
  analyzeAidlcCompatibility,
  blockTypeForPath,
  fidelityGapsFromCatalog,
  normalizeAidlcFrontmatter,
  profileFor,
} from './aidlc-compatibility.js';
import { parseRepositorySlug } from './aidlc-custom-source.js';
import { buildFromFiles } from './block-mappers.js';
import { buildBodyRef, buildScriptRef, sha256 } from './blocks.js';
import { isCommitSha } from './aidlc-ref.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  bodyToString,
  bodyToStringWithin,
  buildMethodologyCatalog,
  isNotFound,
  isPreconditionFailed,
} from './methodology-catalog.js';
import { canonicalJson } from './workflow-checkpoint.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  FIRST_FINGERPRINTED_IMPORTER_REVISION,
  currentMapperFingerprint,
  pinnedMapperFingerprint,
} from './aidlc-release-importer.js';

const AIDLC_RELEASE_SCHEMA_VERSION = 1;

const RELEASE_IO_CONCURRENCY = 8;
// A manifest is JSON fully buffered into the heap before anything about it can be
// validated. A real manifest is tens of KB; the cap stops a corrupted or hostile
// object from exhausting the Lambda's memory.
const RELEASE_MANIFEST_MAX_BYTES = 20 * 1024 * 1024;
const RELEASE_OBJECT_MAX_BYTES = 5 * 1024 * 1024;
const RELEASE_OBJECTS_MAX_BYTES = 50 * 1024 * 1024;
const RELEASE_EVIDENCE_IO_CONCURRENCY = 4;
const SHA256_RE = /^[0-9a-f]{64}$/;

class AidlcReleaseError extends Error {
  constructor(code, message, { cause, diagnostics = null, keys = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AidlcReleaseError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.keys = keys;
  }
}

const assertSha = (sha) => {
  if (!isCommitSha(sha)) {
    throw new AidlcReleaseError(
      'release_sha_invalid',
      `aidlc-release: source ref must be a full commit SHA, got "${String(sha)}"`,
    );
  }
  return String(sha).toLowerCase();
};

const assertImporterRevision = (revision) => {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new AidlcReleaseError(
      'release_importer_revision_invalid',
      `aidlc-release: importerRevision must be a positive integer, got "${String(revision)}"`,
    );
  }
  return revision;
};

/**
 * All release bytes live under one versioned prefix keyed by the exact source
 * SHA and the importer revision that produced them.
 *
 * A custom fork gets its own `custom/<owner>/<name>/` segment. That is a hard
 * separation, not a convention: the official layout puts the SHA directly under
 * `v1/`, so no custom repository — whatever it is named — can ever produce a key
 * that an official release would also produce, and an official reader can never
 * be handed custom bytes.
 */
const releaseKeyPrefix = ({
  sha,
  importerRevision = AIDLC_RELEASE_IMPORTER_REVISION,
  custom = false,
  sourceRepository = null,
}) => {
  const root = `aidlc-releases/v${AIDLC_RELEASE_SCHEMA_VERSION}`;
  const tail = `${assertSha(sha)}/i${assertImporterRevision(importerRevision)}`;
  if (!custom) return `${root}/${tail}`;
  const { owner, repo } = parseRepositorySlug(sourceRepository);
  if (`${owner}/${repo}` === OFFICIAL_AIDLC_REPOSITORY) {
    throw new AidlcReleaseError(
      'release_source_invalid',
      `aidlc-release: ${OFFICIAL_AIDLC_REPOSITORY} cannot be stored under the custom prefix`,
    );
  }
  return `${root}/custom/${owner}/${repo}/${tail}`;
};

// The key arguments implied by an already-built manifest, so every writer and
// reader derives the same prefix from the same recorded provenance.
const releaseKeyArgs = (manifest) => ({
  sha: manifest.sourceSha,
  importerRevision: manifest.importerRevision,
  custom: manifest.custom === true,
  sourceRepository: manifest.sourceRepository ?? null,
});

const releaseManifestKey = (args) => `${releaseKeyPrefix(args)}/manifest.json`;
const releaseCatalogKey = (args) => `${releaseKeyPrefix(args)}/catalog.json`;

/**
 * Runtime files are content-addressed (not pinned per commit) so two releases
 * sharing an unchanged engine file share one immutable object.
 */
const runtimeObjectKey = (hash) => {
  if (!SHA256_RE.test(String(hash ?? ''))) {
    throw new AidlcReleaseError(
      'release_object_hash_invalid',
      `aidlc-release: runtime object hash must be a sha256 hex digest, got "${String(hash)}"`,
    );
  }
  return `aidlc-releases/v${AIDLC_RELEASE_SCHEMA_VERSION}/runtime/sha256/${hash}`;
};

const runtimeContentType = (path) => (/\.(?:ts|js)$/.test(path) ? 'text/plain' : 'text/markdown');

const sortByKey = (items) => items.toSorted((left, right) => left.key.localeCompare(right.key));

/**
 * Deduplicates content-addressed entries by key. Identical keys must carry
 * identical bytes; anything else means the addressing scheme was violated, so
 * we fail closed rather than publish ambiguous content.
 */
const collectReleaseObjects = (entries) => {
  const byKey = new Map();
  for (const entry of entries) {
    const body = entry.body;
    if (typeof body !== 'string') {
      throw new AidlcReleaseError(
        'release_object_invalid',
        `aidlc-release: object ${entry.key} has no string body`,
        { keys: [entry.key] },
      );
    }
    const hash = sha256(body);
    const existing = byKey.get(entry.key);
    if (existing) {
      if (existing.sha256 !== hash) {
        throw new AidlcReleaseError(
          'release_object_conflict',
          `aidlc-release: object ${entry.key} would carry two different contents`,
          { keys: [entry.key] },
        );
      }
      continue;
    }
    byKey.set(entry.key, {
      key: entry.key,
      body,
      sha256: hash,
      bytes: Buffer.byteLength(body),
      contentType: entry.contentType,
      role: entry.role,
      ...(entry.path ? { path: entry.path } : {}),
    });
  }
  return sortByKey([...byKey.values()]);
};

const normalizeReleaseFiles = ({ profile, files }) => {
  const normalized = new Map();
  for (const [path, content] of [...files].toSorted(([left], [right]) =>
    String(left).localeCompare(String(right)),
  )) {
    if (!blockTypeForPath(path)) {
      normalized.set(path, content);
      continue;
    }
    const result = normalizeAidlcFrontmatter({ profileId: profile.id, profile, path, content });
    if (result.error) {
      throw new AidlcReleaseError(
        'release_import_rejected',
        `aidlc-release: frontmatter normalization failed for ${path}`,
        { diagnostics: [result.error] },
      );
    }
    normalized.set(path, result.content);
  }
  return normalized;
};

/**
 * Fails closed when the running mappers no longer reproduce the fingerprint
 * pinned for the revision about to be written: a mapper edit without a revision
 * bump must never publish under an existing revision's prefix.
 */
const assertMapperFingerprintPinned = (importerRevision) => {
  const actual = currentMapperFingerprint();
  const pinned = pinnedMapperFingerprint(importerRevision);
  if (actual !== pinned) {
    throw new AidlcReleaseError(
      'release_importer_fingerprint_drift',
      `aidlc-release: the block mappers changed without an importer revision bump (revision ${importerRevision} pins ${String(pinned)}, the running mappers produce ${actual})`,
      { diagnostics: [{ importerRevision, pinned, actual }] },
    );
  }
  return actual;
};

/**
 * Revision-1 manifests predate the fingerprint and must not carry one; later
 * revisions must record a well-formed one, and — for every revision this code
 * knows — exactly the pinned value. A revision newer than this code is accepted
 * on shape alone so a lambda rollback cannot strand closures a newer importer
 * already published; the closureDigest still guards their integrity.
 */
const assertManifestFingerprint = (manifest) => {
  const recorded = manifest.mapperFingerprint;
  if (manifest.importerRevision < FIRST_FINGERPRINTED_IMPORTER_REVISION) {
    if (recorded !== undefined) {
      throw new AidlcReleaseError(
        'release_manifest_invalid',
        `aidlc-release: a revision-${manifest.importerRevision} manifest cannot carry a mapper fingerprint`,
      );
    }
    return;
  }
  if (!SHA256_RE.test(String(recorded ?? ''))) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: a revision-${manifest.importerRevision} manifest must record a sha256 mapperFingerprint`,
    );
  }
  const pinned = pinnedMapperFingerprint(manifest.importerRevision);
  if (pinned && pinned !== recorded) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: manifest mapperFingerprint does not match the fingerprint pinned for importer revision ${manifest.importerRevision}`,
    );
  }
};

const releaseCompatibility = (report) => ({
  inputDigest: report.inputDigest,
  structurallyValid: report.structurallyValid === true,
  readyForCertification: report.readyForCertification === true,
  dependencyClosureComplete: report.dependencyClosureComplete === true,
  sensorCommandsCompatible: report.sensorCommandsCompatible === true,
  scopes: [...(report.scopes ?? [])].toSorted(),
  executionRelevantUnmappedFields: (report.unmappedFields ?? [])
    .filter((field) => field.executionRelevant)
    .map((field) => `${field.blockType}:${field.field}`)
    .toSorted(),
});

/**
 * Turns an allowlisted profile plus its fetched core/** files into the exact
 * bytes a release publication writes. Deterministic by construction: no
 * timestamps, no environment, no ordering dependence on the input Map.
 *
 * `profile` is the additive custom-fork entry point: a fork is never in the
 * official allowlist, so it hands its synthesized profile in directly. The
 * resulting manifest carries `custom: true` and the fork's repository, which is
 * what keeps its bytes on a separate prefix and its closure non-runnable.
 */
const buildReleaseBundle = ({
  profileId,
  profile: explicitProfile = null,
  files,
  importerRevision = AIDLC_RELEASE_IMPORTER_REVISION,
}) => {
  const profile = explicitProfile ?? profileFor(profileId);
  if (!profile) {
    throw new AidlcReleaseError(
      'release_profile_unknown',
      `aidlc-release: unknown AI-DLC compatibility profile "${String(profileId)}"`,
    );
  }
  if (!(files instanceof Map)) {
    throw new TypeError('aidlc-release: files must be a Map<repo-relative-path, content>');
  }
  const custom = profile.custom === true;
  const sourceRepository = custom ? profile.sourceRepository : OFFICIAL_AIDLC_REPOSITORY;
  const sourceSha = assertSha(profile.upstreamRef);
  assertImporterRevision(importerRevision);
  // The running mappers can only reproduce THEIR revision. Building any other
  // revision would publish bytes under a prefix whose importer never produced
  // them — the exact drift the revision exists to prevent.
  if (importerRevision !== AIDLC_RELEASE_IMPORTER_REVISION) {
    throw new AidlcReleaseError(
      'release_importer_revision_invalid',
      `aidlc-release: this importer produces revision ${AIDLC_RELEASE_IMPORTER_REVISION}, not ${importerRevision}`,
    );
  }
  const mapperFingerprint = assertMapperFingerprintPinned(importerRevision);
  // Validates the slug and refuses the official repository under the custom
  // prefix before any bytes are shaped.
  const keyArgs = { sha: sourceSha, importerRevision, custom, sourceRepository };
  releaseKeyPrefix(keyArgs);

  // Fail closed: an un-importable or structurally invalid commit never reaches
  // storage, and the caller gets compatibility diagnostics that explain why.
  const report = analyzeAidlcCompatibility({ profileId: profile.id, profile, files });
  if (!report.importable || !report.structurallyValid) {
    throw new AidlcReleaseError(
      'release_import_rejected',
      `aidlc-release: profile ${profile.id} is not importable as a release`,
      { diagnostics: report.diagnostics ?? [] },
    );
  }

  const normalizedFiles = normalizeReleaseFiles({ profile, files });
  const { blocks, workflow, sensorScripts, runtimeFiles } = buildFromFiles(normalizedFiles);
  const catalog = buildMethodologyCatalog({ ref: sourceSha, blocks, workflow, sensorScripts });

  const entries = [];
  for (const block of blocks.toSorted(
    (left, right) =>
      String(left.type).localeCompare(String(right.type)) ||
      String(left.id).localeCompare(String(right.id)),
  )) {
    if (!block.body) continue;
    entries.push({
      key: buildBodyRef(block.body).s3Key,
      body: block.body,
      contentType: 'text/markdown',
      role: 'body',
    });
  }
  for (const script of [...sensorScripts.values()].toSorted((left, right) =>
    String(left.path).localeCompare(String(right.path)),
  )) {
    entries.push({
      key: buildScriptRef(script.content).s3Key,
      body: script.content,
      contentType: 'text/plain',
      role: 'script',
      path: script.path,
    });
  }
  const runtimeEntries = [...runtimeFiles]
    .toSorted(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([path, content]) => ({
      key: runtimeObjectKey(sha256(content)),
      body: content,
      contentType: runtimeContentType(path),
      role: 'runtime',
      path,
    }));
  entries.push(...runtimeEntries);

  const objects = collectReleaseObjects(entries);
  const catalogBody = `${JSON.stringify(catalog, null, 2)}\n`;
  const base = {
    schemaVersion: AIDLC_RELEASE_SCHEMA_VERSION,
    releaseId: profile.releaseId,
    sourceRepository,
    sourceSha,
    profileId: profile.id,
    upstreamVersion: profile.upstreamVersion,
    upstreamChannel: profile.upstreamChannel,
    trustTier: profile.trustTier,
    importerRevision,
    // Absent below the first fingerprinted revision, so a revision-1 manifest —
    // and its closureDigest — stays exactly what an existing importer published.
    ...(importerRevision >= FIRST_FINGERPRINTED_IMPORTER_REVISION ? { mapperFingerprint } : {}),
    frontmatterDialect: profile.frontmatterDialect,
    // Present only for custom imports, so an official manifest — and therefore
    // its closureDigest — is byte-identical to what the importer already published.
    ...(custom ? { custom: true, baseProfileId: profile.baseProfileId ?? null } : {}),
    catalog: {
      key: releaseCatalogKey(keyArgs),
      // Hash the canonical form so the digest is independent of pretty-printing.
      sha256: sha256(canonicalJson(catalog)),
      bytes: Buffer.byteLength(catalogBody),
    },
    objects: objects.map(({ body: _body, contentType: _contentType, ...record }) => record),
    runtimeFiles: runtimeEntries
      .map(({ path, key, body }) => ({ path, sha256: sha256(body), key }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    compatibility: releaseCompatibility(report),
  };
  // One digest over everything else: any drift in the catalog, the object set,
  // or the compatibility evidence changes the release identity.
  const manifest = { ...base, closureDigest: sha256(canonicalJson(base)) };
  return { manifest, catalog, objects };
};

const recomputeClosureDigest = (manifest) => {
  const { closureDigest: _closureDigest, ...base } = manifest;
  return sha256(canonicalJson(base));
};

const validateReleaseManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      'aidlc-release: manifest is not an object',
    );
  }
  if (manifest.schemaVersion !== AIDLC_RELEASE_SCHEMA_VERSION) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: unsupported manifest schema ${String(manifest.schemaVersion)}`,
    );
  }
  if (!isCommitSha(manifest.sourceSha) || manifest.sourceSha !== manifest.sourceSha.toLowerCase()) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: manifest sourceSha "${String(manifest.sourceSha)}" is not a lowercase commit SHA`,
    );
  }
  assertImporterRevision(manifest.importerRevision);
  assertManifestFingerprint(manifest);
  if (manifest.custom !== undefined && manifest.custom !== true) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      'aidlc-release: manifest custom flag may only be absent or literally true',
    );
  }
  // A custom manifest must name a resolvable non-official fork: the repository
  // is what decides its storage prefix, so an unusable value would make the
  // manifest unaddressable.
  if (manifest.custom === true) {
    releaseKeyPrefix(releaseKeyArgs(manifest));
  } else if (manifest.sourceRepository !== OFFICIAL_AIDLC_REPOSITORY) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: a non-custom manifest must record ${OFFICIAL_AIDLC_REPOSITORY} (got "${String(manifest.sourceRepository)}")`,
    );
  }
  if (!Array.isArray(manifest.objects) || !SHA256_RE.test(String(manifest.closureDigest ?? ''))) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      'aidlc-release: manifest objects or closureDigest are malformed',
    );
  }
  let previousKey = '';
  for (const object of manifest.objects) {
    if (!object?.key || !SHA256_RE.test(String(object.sha256 ?? ''))) {
      throw new AidlcReleaseError(
        'release_manifest_invalid',
        `aidlc-release: manifest object entry ${String(object?.key)} is malformed`,
      );
    }
    if (previousKey && object.key.localeCompare(previousKey) <= 0) {
      throw new AidlcReleaseError(
        'release_manifest_invalid',
        `aidlc-release: manifest object keys must be sorted and unique (${object.key})`,
      );
    }
    previousKey = object.key;
  }
  if (recomputeClosureDigest(manifest) !== manifest.closureDigest) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: manifest closureDigest does not match its contents (${manifest.sourceSha})`,
    );
  }
  return manifest;
};

const getObjectText = async ({
  s3,
  bucket,
  key,
  maxBytes = null,
  tooLargeCode = 'release_manifest_too_large',
}) => {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const tooLarge = (bytes) => {
    throw new AidlcReleaseError(
      tooLargeCode,
      `aidlc-release: ${key} is ${bytes} bytes, over the ${maxBytes}-byte cap`,
      { keys: [key] },
    );
  };
  if (maxBytes == null) return bodyToString(result.Body);
  // The DECLARED length short-circuits an honestly-sized object before the stream
  // is drained; the reader then enforces the same cap on the bytes it actually
  // accepts, which is what bounds a response with no or an understated length.
  if (Number(result.ContentLength ?? 0) > maxBytes) tooLarge(result.ContentLength);
  return bodyToStringWithin(result.Body, maxBytes, tooLarge);
};

// Preserve the published manifest bytes while recovering the analyzer's
// promotion evidence from its immutable closure. The catalog holds mapped
// frontmatter values; content-addressed objects hold the source bodies that
// may include unsupported engine commands.
const readReleaseFidelityGaps = async ({ s3, bucket, manifest }) => {
  let catalog;
  try {
    catalog = JSON.parse(
      await getObjectText({
        s3,
        bucket,
        key: manifest.catalog.key,
        maxBytes: RELEASE_MANIFEST_MAX_BYTES,
        tooLargeCode: 'release_catalog_too_large',
      }),
    );
  } catch (error) {
    throw new AidlcReleaseError(
      'release_closure_mismatch',
      `aidlc-release: cannot read catalog ${manifest.catalog.key} to verify release capabilities`,
      { cause: error, keys: [manifest.catalog.key] },
    );
  }
  if (
    sha256(canonicalJson(catalog)) !== manifest.catalog.sha256 ||
    !catalog?.blocks ||
    typeof catalog.blocks !== 'object'
  ) {
    throw new AidlcReleaseError(
      'release_closure_mismatch',
      `aidlc-release: catalog ${manifest.catalog.key} failed capability evidence verification`,
      { keys: [manifest.catalog.key] },
    );
  }

  let totalBytes = 0;
  const bodies = await mapWithConcurrency(
    manifest.objects ?? [],
    RELEASE_EVIDENCE_IO_CONCURRENCY,
    async (object) => {
      if (Number(object.bytes ?? 0) > RELEASE_OBJECT_MAX_BYTES) {
        throw new AidlcReleaseError(
          'release_object_too_large',
          `aidlc-release: object ${object.key} exceeds the ${RELEASE_OBJECT_MAX_BYTES}-byte capability-evidence cap`,
          { keys: [object.key] },
        );
      }
      let body;
      try {
        body = await getObjectText({
          s3,
          bucket,
          key: object.key,
          maxBytes: RELEASE_OBJECT_MAX_BYTES,
          tooLargeCode: 'release_object_too_large',
        });
      } catch (error) {
        if (error instanceof AidlcReleaseError) throw error;
        throw new AidlcReleaseError(
          'release_closure_mismatch',
          `aidlc-release: cannot read object ${object.key} to verify release capabilities`,
          { cause: error, keys: [object.key] },
        );
      }
      totalBytes += Buffer.byteLength(body);
      if (totalBytes > RELEASE_OBJECTS_MAX_BYTES) {
        throw new AidlcReleaseError(
          'release_closure_too_large',
          `aidlc-release: release objects exceed the ${RELEASE_OBJECTS_MAX_BYTES}-byte capability-evidence cap`,
        );
      }
      if (sha256(body) !== object.sha256) {
        throw new AidlcReleaseError(
          'release_closure_mismatch',
          `aidlc-release: object ${object.key} failed capability evidence verification`,
          { keys: [object.key] },
        );
      }
      return body;
    },
  );

  return fidelityGapsFromCatalog({
    catalog,
    bodies,
    runtimeFilePaths: (manifest.runtimeFiles ?? []).map(({ path }) => path),
  });
};

const putJsonIfAbsent = async ({ s3, bucket, key, value }) => {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: `${JSON.stringify(value, null, 2)}\n`,
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    );
    return 'written';
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    let existing = null;
    try {
      existing = JSON.parse(await getObjectText({ s3, bucket, key }));
    } catch (readError) {
      // Unreadable or unparseable existing bytes are a conflict, never an
      // implicit overwrite of somebody else's immutable object.
      if (!isNotFound(readError) && !(readError instanceof SyntaxError)) throw readError;
    }
    if (!existing || canonicalJson(existing) !== canonicalJson(value)) {
      throw new AidlcReleaseError(
        'release_conflict',
        `aidlc-release: immutable object ${key} already holds different content`,
        { cause: error, keys: [key] },
      );
    }
    return 'identical';
  }
};

const verifyPublishedBytes = async ({ s3, bucket, manifest, objects }) => {
  const targets = [
    ...objects.map((object) => ({ key: object.key, expected: object.sha256, kind: 'object' })),
    { key: manifest.catalog.key, expected: manifest.catalog.sha256, kind: 'catalog' },
  ];
  const failed = [];
  await mapWithConcurrency(targets, RELEASE_IO_CONCURRENCY, async (target) => {
    let actual = null;
    try {
      const body = await getObjectText({ s3, bucket, key: target.key });
      actual = target.kind === 'catalog' ? sha256(canonicalJson(JSON.parse(body))) : sha256(body);
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
    }
    if (actual !== target.expected) failed.push(target.key);
  });
  if (failed.length > 0) {
    throw new AidlcReleaseError(
      'release_verification_failed',
      `aidlc-release: ${failed.length} published object(s) failed read-back verification`,
      { keys: failed.toSorted() },
    );
  }
};

/**
 * Writes the bundle in dependency order and only then the manifest. The
 * manifest is the publication marker: readers that find it can assume every
 * object and the catalog were already verified present with the exact bytes it
 * records.
 */
const publishReleaseBundle = async ({ s3, bucket, bundle, verify = true }) => {
  const { manifest, catalog, objects } = bundle;
  validateReleaseManifest(manifest);
  const manifestKey = releaseManifestKey(releaseKeyArgs(manifest));

  // Content objects first. A 412 means the identical content-addressed bytes
  // are already stored, which is the normal case across releases.
  await mapWithConcurrency(objects, RELEASE_IO_CONCURRENCY, async (object) => {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: object.key,
          Body: object.body,
          ContentType: object.contentType,
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  });

  await putJsonIfAbsent({ s3, bucket, key: manifest.catalog.key, value: catalog });

  if (verify) {
    await verifyPublishedBytes({ s3, bucket, manifest, objects });
  }

  const marker = await putJsonIfAbsent({ s3, bucket, key: manifestKey, value: manifest });
  return {
    status: marker === 'written' ? 'published' : 'already-published',
    releaseId: manifest.releaseId,
    manifestKey,
    closureDigest: manifest.closureDigest,
    objectCount: objects.length,
  };
};

/**
 * A manifest is addressed by (sourceSha, importerRevision[, repository]), so the
 * bytes found at that key MUST describe exactly that provenance. Anything else
 * means the object was written under the wrong prefix — or swapped — and the
 * caller would otherwise trust a different release than the one it asked for.
 */
const assertManifestProvenance = ({
  manifest,
  sha,
  importerRevision,
  custom,
  sourceRepository,
}) => {
  const expectedSha = String(sha ?? '').toLowerCase();
  const mismatched = [];
  if (manifest.sourceSha !== expectedSha) mismatched.push('sourceSha');
  if (Number(manifest.importerRevision) !== Number(importerRevision)) {
    mismatched.push('importerRevision');
  }
  if (custom) {
    const { owner, repo } = parseRepositorySlug(sourceRepository);
    if (manifest.sourceRepository !== `${owner}/${repo}`) mismatched.push('sourceRepository');
  }
  if (mismatched.length > 0) {
    throw new AidlcReleaseError(
      'release_manifest_invalid',
      `aidlc-release: the manifest stored for ${expectedSha}/i${importerRevision} describes a different release (${mismatched.join(', ')})`,
      {
        diagnostics: [
          {
            fields: mismatched,
            requested: {
              sourceSha: expectedSha,
              importerRevision: Number(importerRevision),
              sourceRepository: custom ? (sourceRepository ?? null) : OFFICIAL_AIDLC_REPOSITORY,
            },
            manifest: {
              sourceSha: manifest.sourceSha ?? null,
              importerRevision: manifest.importerRevision ?? null,
              sourceRepository: manifest.sourceRepository ?? null,
            },
          },
        ],
      },
    );
  }
  return manifest;
};

const readReleaseManifest = async ({
  s3,
  bucket,
  sha,
  importerRevision = AIDLC_RELEASE_IMPORTER_REVISION,
  custom = false,
  sourceRepository = null,
}) => {
  const key = releaseManifestKey({ sha, importerRevision, custom, sourceRepository });
  let manifest;
  try {
    manifest = validateReleaseManifest(
      JSON.parse(await getObjectText({ s3, bucket, key, maxBytes: RELEASE_MANIFEST_MAX_BYTES })),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return assertManifestProvenance({
    manifest,
    sha,
    importerRevision,
    custom,
    sourceRepository,
  });
};

export {
  AIDLC_RELEASE_IMPORTER_REVISION,
  AIDLC_RELEASE_SCHEMA_VERSION,
  AidlcReleaseError,
  buildReleaseBundle,
  collectReleaseObjects,
  publishReleaseBundle,
  readReleaseManifest,
  readReleaseFidelityGaps,
  releaseCatalogKey,
  releaseKeyArgs,
  releaseKeyPrefix,
  releaseManifestKey,
  runtimeObjectKey,
  validateReleaseManifest,
};

export default {
  AIDLC_RELEASE_IMPORTER_REVISION,
  AIDLC_RELEASE_SCHEMA_VERSION,
  AidlcReleaseError,
  buildReleaseBundle,
  collectReleaseObjects,
  publishReleaseBundle,
  readReleaseManifest,
  readReleaseFidelityGaps,
  releaseCatalogKey,
  releaseKeyArgs,
  releaseKeyPrefix,
  releaseManifestKey,
  runtimeObjectKey,
  validateReleaseManifest,
};
