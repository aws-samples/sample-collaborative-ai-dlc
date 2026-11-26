// Materialize pinned release bytes without executing release code. This is a
// local cache, not an authorization boundary, publisher-provenance verifier,
// installer, or durable checkpoint store. The caller must authorize cache reads
// and supply a private cache outside agent-controlled workspace paths.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  NativePackageError,
  verifyNativeReleaseDirectory,
} from '../../shared/native-runtime-package.js';
import {
  describeNativePackagePin,
  nativePackageIdentityOf,
} from '../../shared/native-package-pin.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';

const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
const invalid = (message) => {
  throw new NativePackageError(message);
};

export class NativePackageLoadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NativePackageLoadError';
    this.code = code;
  }
}

const assertAbsentAttestation = async (directory, pin) => {
  if (pin.attestation !== null) return;
  try {
    await lstat(join(directory, ATTESTATION_NAME));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  invalid('Release contains an attestation bundle despite its absence pin');
};

// Hash the exact bytes copied, rather than trusting an earlier pathname check.
// writeFile handles partial writes; each call is awaited before the next chunk.
const transferFile = async (source, file, destination) => {
  let input;
  let output;
  let transferFailure;
  try {
    input = await open(
      join(source, file.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await input.stat();
    if (
      !stat.isFile() ||
      stat.size > file.limit ||
      (file.bytes !== undefined && stat.size !== file.bytes)
    ) {
      invalid(`Release asset ${file.name} is not a bounded pinned regular file`);
    }
    if (destination) {
      output = await open(join(destination, file.name), 'wx', 0o400);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > file.limit || (file.bytes !== undefined && bytes > file.bytes)) {
        invalid(`Release asset ${file.name} exceeds its pinned size limit`);
      }
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (hash.digest('hex') !== file.sha256 || (file.bytes !== undefined && bytes !== file.bytes)) {
      invalid(`Release asset ${file.name} does not match its pin`);
    }
  } catch (error) {
    transferFailure = { error };
  }
  // Settle both closes, including failure paths, before staging can be removed.
  // Preserve the transfer error when closing a descriptor also fails.
  const closed = await Promise.allSettled([input, output].map(async (handle) => handle?.close()));
  if (transferFailure) throw transferFailure.error;
  const closeFailure = closed.find((result) => result.status === 'rejected');
  if (closeFailure) throw closeFailure.reason;
};

const assertIdentity = (report, pin) => {
  if (
    report.packageId !== pin.packageId ||
    canonicalJson(nativePackageIdentityOf(report)) !== canonicalJson(pin.identity)
  ) {
    invalid('Release bytes do not match the confirmed native package');
  }
};

const inspectDirectory = async (directory, pin, files) => {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    invalid('Native package cache entry must be a directory, not a link');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== files.length ||
    entries.some((entry) => !entry.isFile() || !files.some((file) => file.name === entry.name))
  ) {
    invalid('Native package cache entry has missing, unexpected, or non-regular files');
  }
  const report = await verifyNativeReleaseDirectory({
    directory,
    source: pin.identity.source,
    target: pin.identity.target,
  });
  assertIdentity(report, pin);
  if (pin.attestation) await transferFile(directory, files.at(-1));
  return report;
};

const inspectExisting = async (directory, pin, files) => {
  // Only absence of the directory is a cache miss. Missing files in a published
  // directory are corruption, and must never cause a replacement publication.
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return inspectDirectory(directory, pin, files);
};

const cleanupOwnedPaths = async (staging, lock) => {
  const cleaned = await Promise.allSettled([
    staging &&
      (async () => {
        await chmod(staging, 0o700);
        await rm(staging, { recursive: true });
      })(),
    lock && rm(lock, { recursive: true }),
  ]);
  if (cleaned.some((result) => result.status === 'rejected')) {
    throw new NativePackageLoadError(
      'Native package staging or publication lock could not be cleaned up',
      'native_package_cleanup',
    );
  }
};

/**
 * Cache a confirmed Linux ARM64 prebuilt release and its original provenance
 * sidecar. `pin` is the full offline verifier report, confirmed outside this
 * loader. `attestation` independently pins the sidecar's SHA-256 and byte size,
 * or is explicitly null when the publication has no sidecar. These bytes are
 * not covered by the upstream checksum manifest.
 *
 * The returned paths contain verified bytes, not permission to execute them.
 * Provenance authentication and harness qualification remain separate gates.
 * Cache hits require the same pin and work without the original release.
 * An absent cache entry with no releaseDirectory yields native_package_not_cached;
 * corrupt entries and malformed input never become cache misses.
 * Publication is atomic for cooperating loaders. A crashed publisher can leave
 * a lock/staging directory; locks are never automatically stolen. This cache
 * does not promise power-loss durability or isolation from same-UID writers.
 */
export const loadNativePackage = async ({
  releaseDirectory,
  cacheDirectory,
  pin: expectedPin,
  attestation,
}) => {
  const pin = describeNativePackagePin(expectedPin, attestation);
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory)) {
    invalid('Native package cache must be an absolute private directory');
  }
  const { files } = pin;
  let staging;
  let lock;
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const cacheStat = await lstat(cacheDirectory);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || (cacheStat.mode & 0o077) !== 0) {
      invalid('Native package cache must be a private directory, not a link');
    }
    const cache = await realpath(cacheDirectory);
    const directory = join(cache, pin.materializationId.slice('sha256:'.length));
    const result = (report, cacheHit) => ({
      directory,
      binaryPath: join(directory, pin.identity.assets.binary.name),
      runtimePath: join(directory, pin.identity.assets.runtime.name),
      attestationPath: pin.attestation ? join(directory, ATTESTATION_NAME) : null,
      materializationId: pin.materializationId,
      attestation: pin.attestation ? { ...pin.attestation } : null,
      package: report,
      cacheHit,
    });
    const existing = await inspectExisting(directory, pin, files);
    if (existing) return result(existing, true);

    // Serialize expensive verification/copy work as well as publication. A
    // known-busy retry must not recopy a potentially large release.
    const lockPath = `${directory}.lock`;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      lock = lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = await inspectExisting(directory, pin, files);
      if (winner) return result(winner, true);
      throw new NativePackageLoadError(
        'Native package publication is busy; retry without changing its pin',
        'native_package_busy',
      );
    }
    const published = await inspectExisting(directory, pin, files);
    if (published) return result(published, true);

    if (releaseDirectory === undefined) {
      throw new NativePackageLoadError(
        'The confirmed native package is not cached',
        'native_package_not_cached',
      );
    }
    if (typeof releaseDirectory !== 'string' || !isAbsolute(releaseDirectory)) {
      invalid('A local release directory is required for an uncached package');
    }
    const source = await realpath(releaseDirectory);
    await assertAbsentAttestation(source, pin);
    const report = await verifyNativeReleaseDirectory({
      directory: source,
      source: pin.identity.source,
      target: pin.identity.target,
    });
    assertIdentity(report, pin);
    staging = await mkdtemp(join(cache, '.stage-'));
    const copied = await Promise.allSettled(
      files.map((file) => transferFile(source, file, staging)),
    );
    const failure = copied.find((copy) => copy.status === 'rejected');
    if (failure) throw failure.reason;
    await assertAbsentAttestation(source, pin);
    const verified = await inspectDirectory(staging, pin, files);
    await chmod(join(staging, pin.identity.assets.binary.name), 0o500);

    const winner = await inspectExisting(directory, pin, files);
    if (winner) return result(winner, true);
    await chmod(staging, 0o500);
    await rename(staging, directory);
    staging = undefined;
    return result(verified, false);
  } catch (error) {
    if (error instanceof NativePackageError || error instanceof NativePackageLoadError) {
      throw error;
    }
    // Do not expose private source paths or provider details in API-safe errors.
    throw new NativePackageLoadError(
      'Native package files could not be read or published',
      'native_package_io',
    );
  } finally {
    await cleanupOwnedPaths(staging, lock);
  }
};
