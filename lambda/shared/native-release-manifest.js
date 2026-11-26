import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

// Schema 1 follows upstream aidlc-release.ts, aidlc-channel.ts and
// scripts/package-release.ts. This validates metadata consistency only:
// artifact bytes, provenance/attestation and harness compatibility are separate.
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const REQUIRED_HARNESSES = ['claude', 'kiro', 'opencode', 'codex'];
const TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-arm64-musl',
  'linux-x64',
  'linux-x64-musl',
  'windows-x64',
]);
const PREVIEW_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.\d{8}\.[1-9]\d*$/;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

export class NativeReleaseValidationError extends Error {
  constructor(message = 'Invalid native release metadata') {
    super(message);
    this.name = 'NativeReleaseValidationError';
    this.code = 'native_release_invalid';
  }
}

const invalid = (message) => {
  // Never include untrusted metadata, parser errors, URLs or caller values.
  throw new NativeReleaseValidationError(message);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// JS `$` also matches before a final newline; require the entire input match.
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeName = (value) => matches(value, ASSET_NAME) && value.length <= 255;
const identifier = (value) => matches(value, IDENTIFIER) && value.length <= 255;

const readMetadata = (value) => {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    invalid('Metadata must be a Buffer or UTF-8 string');
  }
  const length = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
  if (length === 0 || length > MAX_METADATA_BYTES) {
    invalid('Metadata must contain between 1 byte and 1 MiB');
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  let text;
  try {
    // Preserve a BOM so it is rejected by the metadata grammar, not discarded.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid('Metadata must be valid UTF-8');
  }
  return { text, digest: sha256(bytes) };
};

const readChecksums = (text) => {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || match[0] !== line || !safeName(match[2]) || rows.has(match[2])) {
      invalid('Invalid or duplicate checksum entry');
    }
    rows.set(match[2], match[1]);
  }
  return rows;
};

const verifyDistributionInventory = (distributions) => {
  if (!Array.isArray(distributions) || distributions.length === 0) {
    invalid('Missing distribution inventory');
  }
  const names = new Set();
  for (const distribution of distributions) {
    if (
      !record(distribution) ||
      !identifier(distribution.name) ||
      typeof distribution.productName !== 'string' ||
      distribution.productName.trim().length === 0 ||
      names.has(distribution.name)
    ) {
      invalid('Invalid or duplicate distribution');
    }
    names.add(distribution.name);
  }
  if (REQUIRED_HARNESSES.some((name) => !names.has(name))) {
    invalid('Native releases must include all four required harnesses');
  }
  return Object.freeze([...names].toSorted());
};

const verifyAsset = (asset, version) => {
  if (
    !record(asset) ||
    !safeName(asset.name) ||
    !matches(asset.sha256, SHA256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 0 ||
    asset.bytes > MAX_ASSET_BYTES
  ) {
    invalid('Invalid asset name, digest or byte count');
  }
  if (asset.kind === 'binary') {
    if (
      !TARGETS.has(asset.target) ||
      asset.name !== `aidlc-${asset.target}${asset.target.startsWith('windows-') ? '.exe' : ''}`
    ) {
      invalid('Invalid native binary identity');
    }
    const verification = asset.verification;
    if (
      verification !== undefined &&
      (!record(verification) ||
        !['VERIFIED', 'UNVERIFIED'].includes(verification.status) ||
        !['full-runtime', 'inspection-only'].includes(verification.mode) ||
        !identifier(verification.hostTarget))
    ) {
      invalid('Invalid binary verification metadata');
    }
    return;
  }
  if (asset.target !== undefined || asset.verification !== undefined) {
    invalid('Invalid runtime or installer metadata');
  }
  if (asset.kind === 'runtime' && asset.name === `aidlc-runtime-${version}.tar.gz`) return;
  if (asset.kind === 'installer' && ['install.sh', 'install.ps1'].includes(asset.name)) return;
  // The copy runtime and its separate checksum are not native manifest assets.
  invalid('Unknown native release asset');
};

const sanitizedAsset = ({ name, sha256: digest, bytes }) =>
  Object.freeze({ name, sha256: digest, bytes });

const selectAssets = (assets, checksumRows, version, target) => {
  if (!Array.isArray(assets) || assets.length === 0) invalid('Missing asset inventory');
  const inventory = new Map();
  for (const asset of assets) {
    verifyAsset(asset, version);
    if (inventory.has(asset.name)) invalid('Duplicate release asset');
    if (checksumRows.get(asset.name) !== asset.sha256) {
      invalid('Asset checksum missing or inconsistent with manifest');
    }
    inventory.set(asset.name, asset);
  }
  for (const name of checksumRows.keys()) {
    if (name !== 'version.json' && !inventory.has(name)) {
      invalid('Checksum inventory contains an unknown asset');
    }
  }
  const binaryName = `aidlc-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
  const binary = inventory.get(binaryName);
  const runtime = inventory.get(`aidlc-runtime-${version}.tar.gz`);
  if (!binary || !runtime) invalid('Missing selected native binary or runtime');
  return Object.freeze({ binary: sanitizedAsset(binary), runtime: sanitizedAsset(runtime) });
};

/**
 * Verify exact version.json/checksums.txt bytes against caller-supplied pins.
 * expectedRelease is the exact native release tag (`v<version>`), not "latest"
 * or a branch. Forks using this release protocol work without a repository
 * assumption; other tag/source protocols must be implemented explicitly.
 * Preview tags still bind to v<version>, but their authored sourceRef is main.
 *
 * Returns frozen metadata only. This does not verify the actual asset payloads,
 * authenticate the publisher, resolve a tag, or prove live harness support.
 */
export const verifyNativeReleaseManifest = (input = {}) => {
  if (!record(input)) invalid('Invalid native release validation input');
  const { versionJson, checksums, expectedCommit, expectedRelease, target = 'linux-arm64' } = input;
  if (!matches(expectedCommit, COMMIT)) invalid('A pinned source commit is required');
  if (typeof expectedRelease !== 'string' || !TARGETS.has(target)) {
    invalid('An exact release tag and supported target are required');
  }

  const manifestMetadata = readMetadata(versionJson);
  const checksumMetadata = readMetadata(checksums);
  const checksumRows = readChecksums(checksumMetadata.text);
  if (checksumRows.get('version.json') !== manifestMetadata.digest) {
    invalid('Manifest checksum missing or inconsistent with exact metadata bytes');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestMetadata.text);
  } catch {
    invalid('Invalid manifest JSON');
  }
  if (!record(manifest) || manifest.schemaVersion !== 1) {
    invalid('Unsupported native release manifest schema');
  }
  const { version, sourceRef, sourceDigest } = manifest;
  const stable = matches(version, STABLE_VERSION);
  if (!stable && !matches(version, PREVIEW_VERSION)) invalid('Unsupported native release version');
  if (expectedRelease !== `v${version}`) invalid('Manifest does not match the exact release tag');
  if (sourceRef !== (stable ? `refs/tags/${expectedRelease}` : 'refs/heads/main')) {
    invalid('Manifest does not match the release source ref');
  }
  if (!matches(sourceDigest, COMMIT) || sourceDigest !== expectedCommit) {
    invalid('Manifest does not match the pinned source commit');
  }
  const harnesses = verifyDistributionInventory(manifest.distributions);
  const assets = selectAssets(manifest.assets, checksumRows, version, target);
  return Object.freeze({
    version,
    sourceRef,
    sourceDigest,
    harnesses,
    assets,
    manifestSha256: manifestMetadata.digest,
    checksumsSha256: checksumMetadata.digest,
  });
};
