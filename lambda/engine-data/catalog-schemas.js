// Input schemas and key grammar for the catalog operations engine-data serves.
//
// The catalog is global read-only content (methodology releases and the
// SYSTEM/default block catalog), so these operations carry no ownership ids.
// What confines them is what they can name: block tenants are exactly SYSTEM
// and default, and every S3 key the loader reads — supplied by the caller or
// recovered from a manifest, catalog or block row — must match CATALOG_KEY
// grammar under the configured bucket. Objects are strict: unknown keys are
// refused, not dropped.
import { z } from 'zod';
import { isGithubOwner, isGithubRepo } from '../shared/aidlc-custom-source.js';
import { OFFICIAL_AIDLC_REPOSITORY } from '../shared/aidlc-compatibility-profiles.js';
import { CONDUCTOR_REPO_PATH } from '../shared/engine-catalog.js';
import { DEFAULT_TENANT, SYSTEM_TENANT } from '../shared/tenant.js';

const ID_MAX = 512;
const PINS_PER_TYPE_MAX = 2000;
const SCRIPT_MAX = 1024 * 1024;
// A sensor id as its release script path embeds it (`core/tools/aidlc-sensor-<id>.ts`):
// one path segment, so the entry cannot be placed outside the release's tools/.
const SENSOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CATALOG_TENANTS = Object.freeze([SYSTEM_TENANT, DEFAULT_TENANT]);
export const CATALOG_BLOCK_TYPES = Object.freeze([
  'STAGE',
  'AGENT',
  'SENSOR',
  'RULE',
  'ARTIFACT',
  'KNOWLEDGE',
  'SCOPE',
]);

const HEX64 = /^[0-9a-f]{64}$/;
const BLOCK_OBJECT_KEY = /^blocks\/(?:bodies|scripts)\/sha256\/[0-9a-f]{64}$/;
// Official releases sit directly under `v1/<sha>/`. A promoted fork's closure
// sits under `v1/custom/<owner>/<repo>/<sha>/` (aidlc-release releaseKeyPrefix);
// its owner and repo segments must be a GitHub slug other than the official one.
const RELEASE_JSON_KEY =
  /^aidlc-releases\/v1\/[0-9a-f]{40}\/i[1-9][0-9]{0,8}\/(?:manifest|catalog)\.json$/;
const CUSTOM_RELEASE_JSON_KEY =
  /^aidlc-releases\/v1\/custom\/([^/]+)\/([^/]+)\/[0-9a-f]{40}\/i[1-9][0-9]{0,8}\/(?:manifest|catalog)\.json$/;
const RUNTIME_OBJECT_KEY = /^aidlc-releases\/v1\/runtime\/sha256\/[0-9a-f]{64}$/;
const LEGACY_RUNTIME_PREFIX = 'aidlc-runtime/';
const LEGACY_CONDUCTOR_SUFFIX = `/${CONDUCTOR_REPO_PATH}`;
const hasControlChar = (value) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

// A Git ref as the legacy runtime snapshot path embeds it: slash-separated
// segments are allowed (feature/x), empty and dot segments, backslashes and
// control characters are not. Keys are matched literally, never URL-decoded.
export const isCatalogRef = (ref) =>
  typeof ref === 'string' &&
  ref.length > 0 &&
  ref.length <= ID_MAX &&
  !ref.includes('\\') &&
  !hasControlChar(ref) &&
  ref.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

// A fork repository as a pin names it and as its key prefix embeds it.
export const isForkRepository = (repository) => {
  if (typeof repository !== 'string') return false;
  const parts = repository.split('/');
  return (
    parts.length === 2 &&
    isGithubOwner(parts[0]) &&
    isGithubRepo(parts[1]) &&
    repository !== OFFICIAL_AIDLC_REPOSITORY
  );
};

const isReleaseJsonKey = (key) => {
  if (typeof key !== 'string') return false;
  if (RELEASE_JSON_KEY.test(key)) return true;
  const custom = CUSTOM_RELEASE_JSON_KEY.exec(key);
  return Boolean(custom) && isForkRepository(`${custom[1]}/${custom[2]}`);
};

const isLegacyConductorKey = (key) =>
  key.startsWith(LEGACY_RUNTIME_PREFIX) &&
  key.endsWith(LEGACY_CONDUCTOR_SUFFIX) &&
  isCatalogRef(key.slice(LEGACY_RUNTIME_PREFIX.length, -LEGACY_CONDUCTOR_SUFFIX.length));

export const isCatalogKey = (key) =>
  typeof key === 'string' &&
  (BLOCK_OBJECT_KEY.test(key) ||
    isReleaseJsonKey(key) ||
    RUNTIME_OBJECT_KEY.test(key) ||
    isLegacyConductorKey(key));

const id = z.string().min(1).max(ID_MAX);
const version = z.number().int().positive();
const tenant = z.enum(CATALOG_TENANTS);
const blockType = z.enum(CATALOG_BLOCK_TYPES);
const hex64 = z.string().regex(HEX64);
const releaseJsonKey = z.string().refine(isReleaseJsonKey, 'release_key');

const releasePin = z
  .object({
    releaseId: id.nullish(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
    importerRevision: version.nullish(),
    closureDigest: hex64,
    catalogKey: releaseJsonKey.nullish(),
    manifestKey: releaseJsonKey.nullish(),
    // Present only on a fork's pin (release-registry releasePinFromRecord).
    // Whether the fork may run is the resolver's registry check, not this one.
    custom: z.literal(true).optional(),
    sourceRepository: z.string().refine(isForkRepository, 'fork_repository').nullish(),
  })
  .strict()
  .refine(
    (value) => (value.custom === true) === (value.sourceRepository != null),
    'fork_pin_shape',
  );

const blockPin = z.object({ tenantId: tenant, version }).strict();
const typePins = z
  .record(id, blockPin)
  .refine((pins) => Object.keys(pins).length <= PINS_PER_TYPE_MAX, 'too_many_pins');
const pins = z.record(blockType, typePins);

const blockRef = z
  .object({ s3Key: z.string().refine(isCatalogKey, 'catalog_key'), sha256: hex64.optional() })
  .strict();

const blockObject = z
  .object({
    tenantId: tenant.optional(),
    ref: blockRef.nullish(),
    methodologyRelease: releasePin.nullish(),
  })
  .strict();

export const CATALOG_OPS = Object.freeze({
  loadLibrary: z
    .object({
      workflowId: id,
      workflowVersion: version,
      methodologyPins: pins.nullish(),
      aidlcRepoRef: id.nullish(),
      methodologyRelease: releasePin.nullish(),
    })
    .strict(),
  listMergedBlocks: z.object({ type: blockType }).strict(),
  listReleaseBlocks: z
    .object({ type: blockType, methodologyRelease: releasePin, methodologyPins: pins.nullish() })
    .strict(),
  loadBlockBody: blockObject,
  loadBlockScript: blockObject,
  loadConductor: z
    .object({
      ref: z.string().refine(isCatalogRef, 'catalog_ref').nullish(),
      methodologyRelease: releasePin.nullish(),
    })
    .strict(),
  // Reads only runtime files the pinned release publishes; the entry content
  // selects among them and is never stored.
  loadScriptClosure: z
    .object({
      sensorId: z.string().regex(SENSOR_ID),
      entryContent: z.string().max(SCRIPT_MAX),
      methodologyRelease: releasePin,
    })
    .strict(),
});
