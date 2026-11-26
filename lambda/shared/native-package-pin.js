// Describe pinned file identities without reading bytes or granting permission
// to execute them. The loader still verifies every materialized byte and layout.
import { createHash } from 'node:crypto';
import {
  NATIVE_HARNESSES,
  NATIVE_PACKAGE_LIMITS,
  NativePackageError,
} from './native-runtime-package.js';
import { canonicalJson } from './workflow-checkpoint.js';

const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const validHash = (value) => matches(value, /^[a-f0-9]{64}$/);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message) => {
  throw new NativePackageError(message);
};
const hasOnly = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

// Preserve the schema-1 identity projection and hash inputs exactly. This
// projection alone neither validates nor snapshots a caller-owned object.
export const nativePackageIdentityOf = (value) => ({
  schemaVersion: value.schemaVersion,
  source: value.source,
  target: value.target,
  version: value.version,
  manifestSha256: value.manifestSha256,
  checksumsSha256: value.checksumsSha256,
  assets: value.assets,
  harnesses: value.harnesses,
});

const assertSource = (source, version) => {
  if (
    !hasOnly(source, ['provider', 'repository', 'release', 'commit']) ||
    !['github', 'gitlab', 'bitbucket'].includes(source.provider) ||
    typeof source.repository !== 'string' ||
    source.repository.length > 512 ||
    source.repository !== source.repository.toLowerCase() ||
    !matches(source.commit, /^[a-f0-9]{40}$/) ||
    source.release !== `v${version}`
  ) {
    invalid('Native package pin contains an invalid source');
  }
  const parts = source.repository.split('/');
  if (
    parts.length < 2 ||
    (source.provider !== 'gitlab' && parts.length !== 2) ||
    parts.some((part) => !matches(part, /^[a-z0-9_.-]+$/) || part === '.' || part === '..')
  ) {
    invalid('Native package pin contains an invalid source');
  }
};

/**
 * Snapshot a complete schema-1 verifier pin and an independently pinned sidecar.
 * Explicit null means no sidecar; omission is invalid. Neither verifier status
 * fields nor this description are authority or evidence that bytes were read.
 *
 * Metadata sizes are unknown until read, so version.json/checksums.txt omit
 * `bytes`. File names, hashes, known byte counts and limits are an allowlist for
 * materialization/archive code, not an instruction to fetch arbitrary paths.
 */
export const describeNativePackagePin = (value, attestation) => {
  let snapshot;
  try {
    // Synchronous, before callers begin filesystem/network work. Snapshot the
    // package ID and proof too, never rereading caller-owned fields after this.
    snapshot = structuredClone({
      identity: nativePackageIdentityOf(value),
      packageId: value.packageId,
      attestation,
    });
  } catch {
    invalid('A complete native package pin is required');
  }
  const { identity, packageId } = snapshot;
  if (
    identity.schemaVersion !== 1 ||
    identity.target !== 'linux-arm64' ||
    !matches(identity.version, VERSION) ||
    `aidlc-runtime-${identity.version}.tar.gz`.length > 255 ||
    !validHash(identity.manifestSha256) ||
    !validHash(identity.checksumsSha256) ||
    !Array.isArray(identity.harnesses) ||
    identity.harnesses.length !== NATIVE_HARNESSES.length ||
    NATIVE_HARNESSES.some((harness, index) => identity.harnesses[index] !== harness)
  ) {
    invalid('Native package pin is incomplete or inconsistent');
  }
  assertSource(identity.source, identity.version);
  const assets = identity.assets;
  if (!hasOnly(assets, ['binary', 'runtime'])) {
    invalid('Native package pin contains an invalid asset');
  }
  for (const [role, maxBytes] of [
    ['binary', NATIVE_PACKAGE_LIMITS.assetBytes],
    ['runtime', NATIVE_PACKAGE_LIMITS.compressedBytes],
  ]) {
    const asset = assets[role];
    if (
      !hasOnly(asset, ['name', 'sha256', 'bytes']) ||
      !validHash(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > maxBytes
    ) {
      invalid('Native package pin contains an invalid asset');
    }
  }
  if (
    assets.binary.name !== 'aidlc-linux-arm64' ||
    assets.runtime.name !== `aidlc-runtime-${identity.version}.tar.gz`
  ) {
    invalid('Native package pin contains an unsupported asset name');
  }
  if (packageId !== `sha256:${digest(canonicalJson(identity))}`) {
    invalid('Native package pin is incomplete or inconsistent');
  }
  // An omitted or malformed proof must not downgrade a signed publication.
  const proofPin = snapshot.attestation;
  let proof = null;
  if (proofPin !== null) {
    if (
      !proofPin ||
      (proofPin.name !== undefined && proofPin.name !== ATTESTATION_NAME) ||
      !validHash(proofPin.sha256) ||
      !Number.isSafeInteger(proofPin.bytes) ||
      proofPin.bytes <= 0 ||
      proofPin.bytes > NATIVE_PACKAGE_LIMITS.metadataBytes
    ) {
      invalid('An attestation pin or explicit absence is required');
    }
    proof = { name: ATTESTATION_NAME, sha256: proofPin.sha256, bytes: proofPin.bytes };
  }
  const materializationId = `sha256:${digest(
    canonicalJson({ schemaVersion: 1, packageId, attestation: proof }),
  )}`;
  const files = [
    {
      name: 'version.json',
      sha256: identity.manifestSha256,
      limit: NATIVE_PACKAGE_LIMITS.metadataBytes,
    },
    {
      name: 'checksums.txt',
      sha256: identity.checksumsSha256,
      limit: NATIVE_PACKAGE_LIMITS.metadataBytes,
    },
    { ...assets.binary, limit: NATIVE_PACKAGE_LIMITS.assetBytes },
    { ...assets.runtime, limit: NATIVE_PACKAGE_LIMITS.compressedBytes },
    ...(proof ? [{ ...proof, limit: NATIVE_PACKAGE_LIMITS.metadataBytes }] : []),
  ];
  return { identity, packageId, attestation: proof, materializationId, files };
};
