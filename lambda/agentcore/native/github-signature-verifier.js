// Protected host adapter for GitHub's attestation format. Only the trusted gh
// executable runs; package code and ambient source credentials are never used.
// gh performs cryptographic/certificate verification. This module binds that
// result to the exact metadata and proof already selected by the package loader.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  assessNativePackageTrust,
  NativePackageTrustError,
} from '../../shared/native-package-trust.js';
import { verifyNativeReleaseManifest } from '../../shared/native-release-manifest.js';
import { NATIVE_HARNESSES, NATIVE_PACKAGE_LIMITS } from '../../shared/native-runtime-package.js';
import {
  requireWorkflowSourceRevision,
  workflowSourceIdentity,
} from '../../shared/workflow-source-bindings.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import { runNativeCommand } from './command-runner.js';

const PROOF = 'aidlc-release.intoto.jsonl';
const ISSUER = 'https://token.actions.githubusercontent.com';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const STDOUT_BYTES = 2 * 1024 * 1024;
const STDERR_BYTES = 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const hash = (value) => exact(value, /^[a-f0-9]{64}$/);
const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  }) &&
  isAbsolute(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const identityDigest = (value) => `sha256:${digest(canonicalJson(value))}`;
const fail = (code = 'native_package_trust_invalid') => {
  throw new NativePackageTrustError(code);
};
const deny = () => fail('native_package_trust_denied');

const readInput = (input) => {
  const snapshot = structuredClone(input);
  const { binding, materialization } = snapshot;
  if (!record(binding) || !record(materialization)) fail();
  if (binding.provider !== 'github' || materialization.package?.source?.provider !== 'github')
    deny();
  if (materialization.attestation === null) deny(); // intake alone classifies absence
  requireWorkflowSourceRevision(binding, binding.revision);
  const source = workflowSourceIdentity(binding.provider, binding.repository);
  const pin = materialization.package;
  if (
    binding.sourceId !== source.sourceId ||
    binding.repository !== source.repository ||
    binding.repo !== source.repository ||
    pin.source.repository !== source.repository ||
    pin.schemaVersion !== 1 ||
    pin.target !== 'linux-arm64' ||
    !exact(pin.version, VERSION) ||
    pin.source.release !== `v${pin.version}` ||
    !exact(pin.source.commit, /^[a-f0-9]{40}$/) ||
    !hash(pin.manifestSha256) ||
    !hash(pin.checksumsSha256) ||
    !safePath(materialization.directory) ||
    materialization.attestationPath !== join(materialization.directory, PROOF)
  )
    fail();
  const identity = Object.fromEntries(
    [
      'schemaVersion',
      'source',
      'target',
      'version',
      'manifestSha256',
      'checksumsSha256',
      'assets',
      'harnesses',
    ].map((key) => [key, pin[key]]),
  );
  if (pin.packageId !== identityDigest(identity)) fail();
  const attestation = materialization.attestation;
  if (
    !record(attestation) ||
    (attestation.name !== undefined && attestation.name !== PROOF) ||
    !hash(attestation.sha256) ||
    !Number.isSafeInteger(attestation.bytes) ||
    attestation.bytes <= 0 ||
    attestation.bytes > NATIVE_PACKAGE_LIMITS.metadataBytes
  )
    fail();
  const proof = { name: PROOF, sha256: attestation.sha256, bytes: attestation.bytes };
  if (
    materialization.materializationId !==
    identityDigest({
      schemaVersion: 1,
      packageId: pin.packageId,
      attestation: proof,
    })
  )
    fail();
  return { ...snapshot, proof };
};

const privateDirectory = async (directory, create = false) => {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail();
  return realpath(directory);
};

const readPinnedFile = async (directory, name, expectedHash, expectedBytes) => {
  const handle = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    const limit = NATIVE_PACKAGE_LIMITS.metadataBytes;
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > limit ||
      (expectedBytes !== undefined && stat.size !== expectedBytes)
    )
      fail();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      size += bytesRead;
      if (size > limit) fail();
      if (bytesRead === 0) break;
    }
    const bytes = buffer.subarray(0, size);
    if (size !== stat.size || digest(bytes) !== expectedHash) fail();
    return Buffer.from(bytes);
  } finally {
    await handle.close();
  }
};

const workflowName = (value) =>
  typeof value === 'string' &&
  value.length <= 512 &&
  exact(
    value,
    /^(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/,
  ) &&
  !value.split('/').some((part) => part === '.' || part === '..');

const successfulCommand = (result) =>
  record(result) &&
  result.exitCode === 0 &&
  result.signal === null &&
  (result.spawnError === null || result.spawnError === false) &&
  result.timedOut === false &&
  result.outputLimitExceeded === false &&
  result.cleanupComplete === true &&
  typeof result.stdout === 'string' &&
  Buffer.byteLength(result.stdout) <= STDOUT_BYTES &&
  typeof result.stderr === 'string' &&
  Buffer.byteLength(result.stderr) <= STDERR_BYTES;

const verifiedOutput = (stdout, checksumDigest) => {
  const output = JSON.parse(stdout);
  // gh --format=json returns an array of successful verification results.
  // Do not infer signer identity from user-controllable statement predicates.
  return (
    Array.isArray(output) &&
    output.length > 0 &&
    output.every((entry) => {
      const verified = entry?.verificationResult;
      const statement = verified?.statement;
      return (
        record(entry?.attestation) &&
        record(verified) &&
        record(verified.signature?.certificate) &&
        Array.isArray(verified.verifiedTimestamps) &&
        verified.verifiedTimestamps.every(record) &&
        record(statement) &&
        statement.predicateType === PREDICATE &&
        Array.isArray(statement.subject) &&
        statement.subject.some((subject) => subject?.digest?.sha256 === checksumDigest)
      );
    })
  );
};

/**
 * Host-owned configuration only. hostPath accepts a PATH string or an array of
 * absolute entries. signerWorkflowForSource receives a frozen pinned source
 * with version/preview added; it must return a workflow synchronously.
 *
 * A failed/indeterminate process cleanup preserves its private directory and
 * permanently denies subsequent calls on this verifier instance. The host must
 * halt execution in that environment rather than replacing the instance.
 */
export const createGitHubNativeSignatureVerifier = ({
  ghBinary,
  workRoot,
  hostPath,
  signerWorkflowForSource = ({ repository, preview }) =>
    `${repository}/.github/workflows/${preview ? 'preview-release.yml' : 'release.yml'}`,
  commandRunner = runNativeCommand,
  timeoutMs = 120_000,
} = {}) => {
  const paths = typeof hostPath === 'string' ? hostPath.split(delimiter) : hostPath;
  if (
    !safePath(ghBinary) ||
    !safePath(workRoot) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((path) => !safePath(path) || path.includes(delimiter)) ||
    typeof signerWorkflowForSource !== 'function' ||
    typeof commandRunner !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 120_000
  )
    fail();
  const path = paths.join(delimiter);
  let halted = false;

  return async function verifyBuildSignature(input) {
    let attempt;
    let processComplete = true;
    let evidence;
    let failure;
    try {
      if (halted) deny();
      const snapshot = readInput(input);
      const { binding, materialization, proof } = snapshot;
      const pin = materialization.package;
      const preview = pin.version.includes('-preview.');
      const workflow = signerWorkflowForSource(
        Object.freeze({
          ...pin.source,
          version: pin.version,
          preview,
        }),
      );
      if (workflow && typeof workflow.then === 'function') {
        void Promise.resolve(workflow).catch(() => {});
        fail();
      }
      if (!workflowName(workflow)) fail();
      const directory = await privateDirectory(materialization.directory);
      const root = await privateDirectory(workRoot, true);
      attempt = await mkdtemp(join(root, 'github-native-signature-'));
      const home = join(attempt, 'home');
      const config = join(attempt, 'gh-config');
      const temporary = join(attempt, 'tmp');
      for (const child of [home, config, temporary]) await mkdir(child, { mode: 0o700 });
      const metadata = {};
      for (const [name, expectedHash, expectedBytes] of [
        ['version.json', pin.manifestSha256],
        ['checksums.txt', pin.checksumsSha256],
        [PROOF, proof.sha256, proof.bytes],
      ]) {
        const bytes = await readPinnedFile(directory, name, expectedHash, expectedBytes);
        await writeFile(join(attempt, name), bytes, { flag: 'wx', mode: 0o400 });
        metadata[name] = bytes;
      }
      const manifest = verifyNativeReleaseManifest({
        versionJson: metadata['version.json'],
        checksums: metadata['checksums.txt'],
        expectedRelease: pin.source.release,
        expectedCommit: pin.source.commit,
        target: pin.target,
      });
      // Upstream may publish more distributions than this app executes. The
      // loader pins our supported subset; the signed manifest covers them all.
      if (
        canonicalJson(manifest.assets) !== canonicalJson(pin.assets) ||
        canonicalJson(pin.harnesses) !== canonicalJson(NATIVE_HARNESSES) ||
        NATIVE_HARNESSES.some((harness) => !manifest.harnesses.includes(harness))
      )
        fail();
      if (halted) deny();
      processComplete = false;
      const result = await commandRunner({
        command: ghBinary,
        args: [
          'attestation',
          'verify',
          join(attempt, 'checksums.txt'),
          '--bundle',
          join(attempt, PROOF),
          '--repo',
          pin.source.repository,
          '--signer-workflow',
          workflow,
          '--source-ref',
          preview ? 'refs/heads/main' : `refs/tags/${pin.source.release}`,
          '--source-digest',
          pin.source.commit,
          '--format=json',
          '--predicate-type',
          PREDICATE,
          '--cert-oidc-issuer',
          ISSUER,
        ],
        cwd: attempt,
        env: {
          HOME: home,
          GH_CONFIG_DIR: config,
          TMPDIR: temporary,
          PATH: path,
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
        },
        timeoutMs,
        stdoutBytes: STDOUT_BYTES,
        stderrBytes: STDERR_BYTES,
      });
      processComplete = result?.cleanupComplete === true;
      if (!processComplete) halted = true;
      if (
        halted ||
        !successfulCommand(result) ||
        !verifiedOutput(result.stdout, pin.checksumsSha256)
      )
        deny();
      evidence = Object.freeze({
        status: 'verified',
        packageId: pin.packageId,
        materializationId: materialization.materializationId,
        attestationSha256: proof.sha256,
        signer: Object.freeze({ subject: workflow, issuer: ISSUER }),
      });
      // Reuse the complete binding/report policy validation only after actual
      // gh verification. No synthetic "verified" or "absent" preflight claim.
      assessNativePackageTrust({ binding, materialization, signature: evidence });
    } catch (error) {
      if (!processComplete) halted = true;
      failure = new NativePackageTrustError(
        error instanceof NativePackageTrustError && error.code === 'native_package_trust_invalid'
          ? 'native_package_trust_invalid'
          : 'native_package_trust_denied',
      );
    } finally {
      if (attempt && processComplete) {
        try {
          await rm(attempt, { recursive: true });
        } catch {
          failure = new NativePackageTrustError('native_package_trust_denied');
        }
      }
    }
    if (failure) throw failure;
    if (halted) deny();
    return evidence;
  };
};
