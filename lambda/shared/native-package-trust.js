// Policy assessment only. The protected broker supplies a currently authorized
// binding, a fresh loader report, and a trusted signature-verifier result.
// Neither these ordinary objects nor the returned evidence are authority tokens.
import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';
import { workflowSourceIdentity } from './workflow-source-bindings.js';
import { NATIVE_HARNESSES, NATIVE_PACKAGE_LIMITS } from './native-runtime-package.js';

const POLICY = 'owner-selected-source-v1';
const PROOF_NAME = 'aidlc-release.intoto.jsonl';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MESSAGES = Object.freeze({
  native_package_trust_invalid: 'Native package trust inputs are invalid',
  native_package_trust_mismatch:
    'Native package trust evidence does not match the selected package',
  native_package_trust_denied: 'Native package signature verification did not permit this package',
});

export class NativePackageTrustError extends Error {
  constructor(code = 'native_package_trust_invalid') {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'native_package_trust_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'NativePackageTrustError';
    this.code = safeCode;
  }
}

const fail = (code = 'native_package_trust_invalid') => {
  throw new NativePackageTrustError(code);
};
const mismatch = () => fail('native_package_trust_mismatch');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, expression) =>
  typeof value === 'string' && expression.exec(value)?.[0] === value;
const hash = (value) => matches(value, /^[a-f0-9]{64}$/);
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const boundedText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= max &&
  value.trim() === value &&
  ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });

const readBinding = (binding) => {
  if (
    !record(binding) ||
    binding.schemaVersion !== 1 ||
    binding.purpose !== 'workflow-source' ||
    binding.status !== 'active' ||
    binding.access !== 'read' ||
    binding.capabilities?.repositoryRead !== true ||
    binding.capabilities?.repositoryWrite !== false ||
    binding.capabilities?.contents !== 'read' ||
    !boundedText(binding.projectId, 256) ||
    !boundedText(binding.updatedBy, 256) ||
    !matches(binding.revision, REVISION)
  )
    fail();
  const source = workflowSourceIdentity(binding.provider, binding.repository);
  if (
    binding.sourceId !== source.sourceId ||
    binding.repository !== source.repository ||
    binding.repo !== source.repository
  )
    mismatch();
  return source;
};

const readAsset = (asset, name, maxBytes) => {
  if (
    !record(asset) ||
    asset.name !== name ||
    !hash(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    asset.bytes > maxBytes
  )
    fail();
  return { name, sha256: asset.sha256, bytes: asset.bytes };
};

const readPackage = (value, source) => {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.target !== 'linux-arm64' ||
    !boundedText(value.version, 255) ||
    !matches(value.version, VERSION) ||
    !hash(value.manifestSha256) ||
    !hash(value.checksumsSha256) ||
    value.verification?.integrity !== 'verified' ||
    value.verification?.projectionLayout !== 'verified' ||
    !record(value.source) ||
    !matches(value.source.commit, /^[a-f0-9]{40}$/) ||
    value.source.release !== `v${value.version}` ||
    !Array.isArray(value.harnesses) ||
    canonicalJson(value.harnesses) !== canonicalJson(NATIVE_HARNESSES)
  )
    fail();
  if (value.source.provider !== source.provider || value.source.repository !== source.repository)
    mismatch();
  const inventory = value.inventory;
  if (
    !record(inventory) ||
    !Number.isSafeInteger(inventory.fileCount) ||
    inventory.fileCount <= 0 ||
    inventory.fileCount > NATIVE_PACKAGE_LIMITS.entries ||
    !Number.isSafeInteger(inventory.expandedBytes) ||
    inventory.expandedBytes < 0 ||
    inventory.expandedBytes > NATIVE_PACKAGE_LIMITS.expandedBytes ||
    !Array.isArray(inventory.projections) ||
    inventory.projections.length !== NATIVE_HARNESSES.length ||
    NATIVE_HARNESSES.some((harness) => {
      const entries = inventory.projections.filter((entry) => entry?.harness === harness);
      return (
        entries.length !== 1 ||
        !matches(entries[0].harnessDir, /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,255}$/) ||
        !hash(entries[0].stampSha256)
      );
    })
  )
    fail();
  const identity = {
    schemaVersion: 1,
    source: {
      provider: source.provider,
      repository: source.repository,
      release: value.source.release,
      commit: value.source.commit,
    },
    target: value.target,
    version: value.version,
    manifestSha256: value.manifestSha256,
    checksumsSha256: value.checksumsSha256,
    assets: {
      binary: readAsset(
        value.assets?.binary,
        'aidlc-linux-arm64',
        NATIVE_PACKAGE_LIMITS.assetBytes,
      ),
      runtime: readAsset(
        value.assets?.runtime,
        `aidlc-runtime-${value.version}.tar.gz`,
        NATIVE_PACKAGE_LIMITS.compressedBytes,
      ),
    },
    harnesses: [...NATIVE_HARNESSES],
  };
  if (value.packageId !== `sha256:${digest(identity)}`) mismatch();
  return value.packageId;
};

const readAttestation = (attestation) => {
  // A null proof is explicit. Missing/malformed proof metadata is not absence.
  if (attestation === null) return null;
  if (
    !record(attestation) ||
    (attestation.name !== undefined && attestation.name !== PROOF_NAME) ||
    !hash(attestation.sha256) ||
    !Number.isSafeInteger(attestation.bytes) ||
    attestation.bytes <= 0 ||
    attestation.bytes > NATIVE_PACKAGE_LIMITS.metadataBytes
  )
    fail();
  return { name: PROOF_NAME, sha256: attestation.sha256, bytes: attestation.bytes };
};

const readSignature = (signature, packageId, materializationId, attestation) => {
  if (!record(signature)) fail('native_package_trust_denied');
  if (!['verified', 'absent'].includes(signature.status)) fail('native_package_trust_denied');
  if (
    signature.packageId !== packageId ||
    signature.materializationId !== materializationId ||
    signature.attestationSha256 !== (attestation?.sha256 ?? null)
  )
    mismatch();
  const evidence = { status: signature.status };
  if (signature.status === 'verified' && signature.signer !== undefined) {
    if (!record(signature.signer)) fail();
    const signer = {};
    // Opaque verified identifiers, with no provider/issuer allowlist implied.
    // Never copy certificates, proof bodies, transport details or arbitrary keys.
    for (const key of ['subject', 'issuer', 'keyId']) {
      if (signature.signer[key] === undefined) continue;
      if (!boundedText(signature.signer[key], 512)) fail();
      signer[key] = signature.signer[key];
    }
    if (Object.keys(signer).length === 0) fail();
    evidence.signer = Object.freeze(signer);
  }
  return Object.freeze(evidence);
};

/**
 * Evaluate D17 against server-owned evidence, without I/O or cryptography.
 * `signature` is an explicit verifier result: {status, packageId,
 * materializationId, attestationSha256: hex | null, signer?}. A nonnull proof
 * may contain unsigned provenance, but only the verifier may classify it absent.
 *
 * Owner/admin configuration and current membership/revision authorization are
 * broker preconditions. Loader reports carry no tenant/revision authority.
 * Null proofs use the same schema-1 materialization digest with attestation:null.
 * Returned evidence records a decision; it cannot authorize later execution.
 */
export const assessNativePackageTrust = (input = {}) => {
  try {
    if (!record(input)) fail();
    const { binding, materialization, signature } = input;
    const source = readBinding(binding);
    if (!record(materialization)) fail();
    const packageId = readPackage(materialization.package, source);
    const attestation = readAttestation(materialization.attestation);
    const materializationId = `sha256:${digest({ schemaVersion: 1, packageId, attestation })}`;
    if (materialization.materializationId !== materializationId) mismatch();
    const signatureEvidence = readSignature(signature, packageId, materializationId, attestation);
    return Object.freeze({
      schemaVersion: 1,
      policy: POLICY,
      projectId: binding.projectId,
      sourceId: source.sourceId,
      bindingRevision: binding.revision,
      configuredBy: binding.updatedBy,
      packageId,
      materializationId,
      signature: signatureEvidence,
      allowed: true,
    });
  } catch (error) {
    if (error instanceof NativePackageTrustError) throw error;
    // Do not expose callback/parser errors, source details or private paths.
    throw new NativePackageTrustError();
  }
};
