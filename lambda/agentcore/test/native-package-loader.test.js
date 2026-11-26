import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNativePackage, NativePackageLoadError } from '../native/package-loader.js';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';
import { describeNativePackagePin } from '../../shared/native-package-pin.js';
import {
  NATIVE_PACKAGE_LIMITS,
  verifyNativeReleaseDirectory,
} from '../../shared/native-runtime-package.js';

const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const ROLES = ['version.json', 'checksums.txt', 'binary', 'runtime', ATTESTATION_NAME];
const INERT_ATTESTATION = Buffer.from(
  '{"fixture":"authored inert attestation sidecar","verified":false}\n',
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const attestationPin = (bytes) => ({ sha256: digest(bytes), bytes: bytes.length });
let root;

// Published directories are 0500. Restore directory write/search permission
// before removing them, without following symlinks into their targets.
const makeDirectoriesRemovable = async (directory) => {
  const stat = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesRemovable(join(directory, entry.name))),
  );
};

const removeTree = async (directory) => {
  await makeDirectoriesRemovable(directory);
  await rm(directory, { recursive: true, force: true });
};

const fixture = async () => {
  const release = await createNativeReleaseFixture(join(root, 'release'));
  await writeFile(join(release.directory, ATTESTATION_NAME), INERT_ATTESTATION);
  const pin = await verifyNativeReleaseDirectory(release);
  const attestation = attestationPin(INERT_ATTESTATION);
  const options = {
    releaseDirectory: release.directory,
    cacheDirectory: join(root, 'cache'),
    pin,
    attestation,
  };
  const names = [...release.fileNames, ATTESTATION_NAME];
  const bytes = new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(release.directory, name))]),
    ),
  );
  return {
    release,
    options,
    pin,
    attestation,
    names,
    bytes,
    nameFor: (role) =>
      role === 'binary' ? release.binaryName : role === 'runtime' ? release.runtimeName : role,
    load: (overrides = {}) => loadNativePackage({ ...options, ...overrides }),
  };
};

const expectAbsent = async (path) => {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
};

const expectRejectedPackage = async (promise) => {
  // Corrupt metadata may be rejected by the offline metadata validator and
  // mapped to native_package_io; neither failure may repair or replace a cache.
  await expect(promise).rejects.toMatchObject({
    code: expect.stringMatching(/^native_package_(invalid|io)$/),
  });
};

const expectCacheEntries = async (cacheDirectory, entries) => {
  expect((await readdir(cacheDirectory)).toSorted()).toEqual(entries.toSorted());
};

const expectPreservedBytes = async (directory, bytes) => {
  await Promise.all(
    [...bytes].map(async ([name, expected]) => {
      expect(await readFile(join(directory, name))).toEqual(expected);
    }),
  );
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-package-loader-')));
});

afterEach(async () => {
  await removeTree(root);
});

describe('native package materialization on the filesystem', () => {
  it('preserves all five exact byte streams and returns the canonical four-harness report', async () => {
    const f = await fixture();
    const loaded = await f.load();

    expect(loaded).toMatchObject({
      cacheHit: false,
      package: f.pin,
      materializationId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      attestation: { name: ATTESTATION_NAME, ...f.attestation },
    });
    expect(loaded.directory).toBe(
      join(await realpath(f.options.cacheDirectory), loaded.materializationId.slice(7)),
    );
    expect(loaded.binaryPath).toBe(join(loaded.directory, f.release.binaryName));
    expect(loaded.runtimePath).toBe(join(loaded.directory, f.release.runtimeName));
    expect(loaded.attestationPath).toBe(join(loaded.directory, ATTESTATION_NAME));
    const described = describeNativePackagePin(f.pin, f.attestation);
    expect(loaded.materializationId).toBe(described.materializationId);
    expect(described.files.map(({ name }) => name).toSorted()).toEqual(f.names.toSorted());
    expect((await readdir(loaded.directory)).toSorted()).toEqual(f.names.toSorted());
    await expectPreservedBytes(loaded.directory, f.bytes);
    expect(loaded.package.harnesses).toEqual(HARNESSES);
    expect(loaded.package.inventory.projections.map(({ harness }) => harness)).toEqual(HARNESSES);
    expect(loaded.package.inventory.fileCount).toBe(17); // Includes the inert plugin.
    expect(loaded.package.verification).toEqual({
      integrity: 'verified',
      projectionLayout: 'verified',
      attestation: 'not-verified',
      harnessExecution: 'not-verified',
    });
    expect((await lstat(f.options.cacheDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(loaded.directory)).mode & 0o777).toBe(0o500);
    for (const name of f.names) {
      const stat = await lstat(join(loaded.directory, name));
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(name === f.release.binaryName ? 0o500 : 0o400);
    }
    await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
  });

  it('recomputes report claims instead of trusting caller-supplied verification and inventory', async () => {
    const f = await fixture();
    const pin = structuredClone(f.pin);
    pin.verification = {
      integrity: 'verified',
      projectionLayout: 'verified',
      attestation: 'verified',
      harnessExecution: 'verified',
    };
    pin.inventory = { fileCount: 0, projections: [] };

    const loaded = await f.load({ pin });
    expect(loaded.package).toEqual(f.pin);
    expect(loaded.package.verification.attestation).toBe('not-verified');
    expect(loaded.package.verification.harnessExecution).toBe('not-verified');
  });

  it('snapshots the confirmed pin and sidecar identity before asynchronous filesystem work', async () => {
    const f = await fixture();
    const pin = structuredClone(f.pin);
    const attestation = { ...f.attestation };
    const loading = f.load({ pin, attestation });
    pin.source.commit = 'b'.repeat(40);
    pin.assets.binary.sha256 = '0'.repeat(64);
    pin.harnesses.length = 0;
    attestation.sha256 = '0'.repeat(64);
    attestation.bytes = 1;

    const loaded = await loading;
    expect(loaded.package).toEqual(f.pin);
    expect(loaded.attestation).toEqual({ name: ATTESTATION_NAME, ...f.attestation });
    await expectPreservedBytes(loaded.directory, f.bytes);
  });

  it('serves a verified cache hit after the source directory is deleted', async () => {
    const f = await fixture();
    const first = await f.load();
    await removeTree(f.release.directory);

    const hit = await f.load({ releaseDirectory: undefined });
    expect(hit).toEqual({ ...first, cacheHit: true });
    await expectPreservedBytes(hit.directory, f.bytes);
    await expectCacheEntries(f.options.cacheDirectory, [basename(first.directory)]);
  });

  it('cannot replace the confirmed package when the source is overwritten with a newer release', async () => {
    const f = await fixture();
    const first = await f.load();
    const newer = await createNativeReleaseFixture(f.release.directory, {
      version: '2.10.0',
      source: { commit: 'b'.repeat(40) },
      binary: 'newer synthetic binary; never executed',
    });

    const oldHit = await f.load();
    expect(oldHit).toEqual({ ...first, cacheHit: true });
    await expectPreservedBytes(oldHit.directory, f.bytes);

    // Without a cached copy, the old pin must fail rather than follow rollover.
    const coldCache = join(root, 'cold-cache');
    await expectRejectedPackage(f.load({ cacheDirectory: coldCache }));
    await expectCacheEntries(coldCache, []);

    const newerPin = await verifyNativeReleaseDirectory(newer);
    const second = await f.load({ pin: newerPin });
    expect(second.cacheHit).toBe(false);
    expect(second.package).toEqual(newerPin);
    expect(second.package.packageId).not.toBe(first.package.packageId);
    expect(second.materializationId).not.toBe(first.materializationId);
    await expectPreservedBytes(first.directory, f.bytes);
    await expectCacheEntries(f.options.cacheDirectory, [
      basename(first.directory),
      basename(second.directory),
    ]);
  });

  it('pins changed sidecar bytes in a different materialization of the same package', async () => {
    const f = await fixture();
    const first = await f.load();
    const nextBytes = Buffer.from('{"fixture":"second inert attestation","verified":false}\n');
    await writeFile(join(f.release.directory, ATTESTATION_NAME), nextBytes);
    const nextAttestation = attestationPin(nextBytes);

    const second = await f.load({ attestation: nextAttestation });
    expect(second.package).toEqual(first.package);
    expect(second.materializationId).not.toBe(first.materializationId);
    expect(second.directory).not.toBe(first.directory);
    expect(second.attestation).toEqual({ name: ATTESTATION_NAME, ...nextAttestation });
    expect(await readFile(second.attestationPath)).toEqual(nextBytes);
    expect(await readFile(first.attestationPath)).toEqual(INERT_ATTESTATION);
    expect(await f.load()).toEqual({ ...first, cacheHit: true });
  });
});

describe('published cache corruption', () => {
  it.each(ROLES)(
    'rejects same-size corruption of cached %s without repairing it from source',
    async (role) => {
      const f = await fixture();
      const loaded = await f.load();
      const name = f.nameFor(role);
      const path = join(loaded.directory, name);
      const mode = (await lstat(path)).mode & 0o777;
      const corrupt = Buffer.from(f.bytes.get(name));
      corrupt[0] ^= 1;
      await chmod(path, 0o600);
      await writeFile(path, corrupt);
      await chmod(path, mode);

      await expectRejectedPackage(f.load());
      expect(await readFile(path)).toEqual(corrupt);
      expect(await readFile(join(f.release.directory, name))).toEqual(f.bytes.get(name));
      await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
    },
  );

  it.each(ROLES)('rejects missing cached %s even when the source still has it', async (role) => {
    const f = await fixture();
    const loaded = await f.load();
    const name = f.nameFor(role);
    const path = join(loaded.directory, name);
    await chmod(loaded.directory, 0o700);
    await unlink(path);
    await chmod(loaded.directory, 0o500);

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    await expectAbsent(path);
    expect(await readFile(join(f.release.directory, name))).toEqual(f.bytes.get(name));
    await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
  });

  it.each(ROLES)(
    'rejects cached %s replaced by a symlink to otherwise valid bytes',
    async (role) => {
      const f = await fixture();
      const loaded = await f.load();
      const name = f.nameFor(role);
      const path = join(loaded.directory, name);
      const target = join(f.release.directory, name);
      await chmod(loaded.directory, 0o700);
      await unlink(path);
      await symlink(target, path);
      await chmod(loaded.directory, 0o500);

      await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
      expect(await readlink(path)).toBe(target);
      expect(await readFile(target)).toEqual(f.bytes.get(name));
      await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
    },
  );

  it.each(['file', 'directory', 'symlink'])('rejects an unexpected cached %s', async (kind) => {
    const f = await fixture();
    const loaded = await f.load();
    const extra = join(loaded.directory, 'unexpected');
    await chmod(loaded.directory, 0o700);
    if (kind === 'file') await writeFile(extra, 'unexpected bytes');
    else if (kind === 'directory') await mkdir(extra);
    else await symlink(join(f.release.directory, 'version.json'), extra);
    await chmod(loaded.directory, 0o500);

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    expect((await readdir(loaded.directory)).toSorted()).toEqual(
      [...f.names, 'unexpected'].toSorted(),
    );
    await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
  });

  it('rejects a published directory replaced by a symlink', async () => {
    const f = await fixture();
    const loaded = await f.load();
    const target = join(root, 'displaced-package');
    await chmod(loaded.directory, 0o700);
    await rename(loaded.directory, target);
    await chmod(target, 0o500);
    await symlink(target, loaded.directory, 'dir');

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    expect(await readlink(loaded.directory)).toBe(target);
    await expectPreservedBytes(target, f.bytes);
  });

  it('rejects an existing empty destination without replacing it', async () => {
    const f = await fixture();
    const loaded = await f.load();
    await removeTree(loaded.directory);
    await mkdir(loaded.directory, { mode: 0o500 });

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    expect(await readdir(loaded.directory)).toEqual([]);
    await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
  });
});

describe('private cache root', () => {
  it('rejects a cache-root symlink without writing into its target', async () => {
    const f = await fixture();
    const target = join(root, 'real-cache');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, f.options.cacheDirectory, 'dir');

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    expect(await readdir(target)).toEqual([]);
    expect(await readlink(f.options.cacheDirectory)).toBe(target);
  });

  it.each([0o755, 0o750, 0o710, 0o701, 0o770])('rejects non-private root mode %i', async (mode) => {
    const f = await fixture();
    await mkdir(f.options.cacheDirectory, { mode: 0o700 });
    await chmod(f.options.cacheDirectory, mode);

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_invalid' });
    expect((await lstat(f.options.cacheDirectory)).mode & 0o777).toBe(mode);
    await expectCacheEntries(f.options.cacheDirectory, []);
  });

  it('rejects a regular file used as the cache root without modifying it', async () => {
    const f = await fixture();
    await writeFile(f.options.cacheDirectory, 'keep this file');

    await expectRejectedPackage(f.load());
    expect(await readFile(f.options.cacheDirectory, 'utf8')).toBe('keep this file');
  });

  it('requires an absolute cache path', async () => {
    const f = await fixture();
    await expect(f.load({ cacheDirectory: 'relative-cache' })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    await expectAbsent(f.options.cacheDirectory);
  });
});

describe('confirmed package and attestation pins', () => {
  it('pins explicit sidecar absence and recovers the exact four-file package from cache', async () => {
    const f = await fixture();
    await unlink(join(f.release.directory, ATTESTATION_NAME));
    const loaded = await f.load({ attestation: null });
    expect(loaded).toMatchObject({
      attestation: null,
      attestationPath: null,
      cacheHit: false,
      package: f.pin,
    });
    expect((await readdir(loaded.directory)).toSorted()).toEqual(f.release.fileNames.toSorted());
    await removeTree(f.release.directory);
    const cached = await f.load({ attestation: null, releaseDirectory: undefined });
    expect(cached).toEqual({ ...loaded, cacheHit: true });
  });

  it.each(['file', 'dangling link', 'directory'])(
    'rejects an absence pin when the source sidecar is a %s',
    async (kind) => {
      const f = await fixture();
      const path = join(f.release.directory, ATTESTATION_NAME);
      if (kind !== 'file') {
        await unlink(path);
        if (kind === 'directory') await mkdir(path);
        else await symlink(join(root, 'missing-proof'), path);
      }
      await expect(f.load({ attestation: null })).rejects.toMatchObject({
        code: 'native_package_invalid',
      });
      await expectCacheEntries(f.options.cacheDirectory, []);
    },
  );

  it('separates unsigned and sidecar materializations without changing package identity', async () => {
    const f = await fixture();
    const withProof = await f.load();
    await unlink(join(f.release.directory, ATTESTATION_NAME));
    const withoutProof = await f.load({ attestation: null });
    expect(withoutProof.package.packageId).toBe(withProof.package.packageId);
    expect(withoutProof.materializationId).not.toBe(withProof.materializationId);
    expect(await readFile(withProof.attestationPath)).toEqual(INERT_ATTESTATION);
    await chmod(withoutProof.directory, 0o700);
    await writeFile(join(withoutProof.directory, ATTESTATION_NAME), INERT_ATTESTATION);
    await expect(f.load({ attestation: null })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
  });

  it.each([
    ['missing pin', () => undefined],
    ['null pin', () => null],
    ['partial pin', () => ({})],
    ['missing package ID', (pin) => ({ ...pin, packageId: undefined })],
    ['wrong package ID', (pin) => ({ ...pin, packageId: `sha256:${'0'.repeat(64)}` })],
    [
      'changed source commit',
      (pin) => ({ ...pin, source: { ...pin.source, commit: 'b'.repeat(40) } }),
    ],
    ['changed manifest digest', (pin) => ({ ...pin, manifestSha256: '0'.repeat(64) })],
    [
      'changed asset size',
      (pin) => ({
        ...pin,
        assets: {
          ...pin.assets,
          binary: { ...pin.assets.binary, bytes: pin.assets.binary.bytes + 1 },
        },
      }),
    ],
    ['missing harness', (pin) => ({ ...pin, harnesses: pin.harnesses.slice(1) })],
    ['noncanonical harness order', (pin) => ({ ...pin, harnesses: pin.harnesses.toReversed() })],
    ['unsupported target', (pin) => ({ ...pin, target: 'linux-x64' })],
  ])('rejects %s before creating a cache', async (_name, change) => {
    const f = await fixture();
    await expect(f.load({ pin: change(structuredClone(f.pin)) })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    await expectAbsent(f.options.cacheDirectory);
  });

  it.each([
    ['missing sidecar pin', () => undefined],
    ['partial sidecar pin', () => ({})],
    ['unexpected sidecar name', (pin) => ({ ...pin, name: 'other-proof.json' })],
    ['noncanonical digest', (pin) => ({ ...pin, sha256: 'A'.repeat(64) })],
    ['short digest', (pin) => ({ ...pin, sha256: 'a'.repeat(63) })],
    ['zero byte count', (pin) => ({ ...pin, bytes: 0 })],
    ['negative byte count', (pin) => ({ ...pin, bytes: -1 })],
    ['fractional byte count', (pin) => ({ ...pin, bytes: 1.5 })],
    ['string byte count', (pin) => ({ ...pin, bytes: String(pin.bytes) })],
    ['oversized sidecar', (pin) => ({ ...pin, bytes: NATIVE_PACKAGE_LIMITS.metadataBytes + 1 })],
  ])('rejects %s before creating a cache', async (_name, change) => {
    const f = await fixture();
    await expect(f.load({ attestation: change({ ...f.attestation }) })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    await expectAbsent(f.options.cacheDirectory);
  });

  it.each(['digest', 'smaller size', 'larger size'])(
    'rejects a sidecar with a mismatched %s and removes staging',
    async (change) => {
      const f = await fixture();
      const attestation = { ...f.attestation };
      if (change === 'digest') attestation.sha256 = '0'.repeat(64);
      else attestation.bytes += change === 'smaller size' ? -1 : 1;

      await expect(f.load({ attestation })).rejects.toMatchObject({
        code: 'native_package_invalid',
      });
      await expectCacheEntries(f.options.cacheDirectory, []);
      await expectPreservedBytes(f.release.directory, f.bytes);
    },
  );

  it.each(['missing', 'symlink', 'directory'])(
    'rejects a %s source sidecar and cleans all staged copies',
    async (kind) => {
      const f = await fixture();
      const path = join(f.release.directory, ATTESTATION_NAME);
      await unlink(path);
      if (kind === 'symlink') {
        const target = join(root, 'inert-sidecar');
        await writeFile(target, INERT_ATTESTATION);
        await symlink(target, path);
      } else if (kind === 'directory') {
        await mkdir(path);
      }

      await expectRejectedPackage(f.load());
      await expectCacheEntries(f.options.cacheDirectory, []);
      for (const name of f.release.fileNames) {
        expect(await readFile(join(f.release.directory, name))).toEqual(f.bytes.get(name));
      }
    },
  );

  it('returns the distinct cache miss only for a valid pin with no local source, then releases its lock', async () => {
    const f = await fixture();
    await expect(f.load({ releaseDirectory: undefined })).rejects.toMatchObject({
      name: 'NativePackageLoadError',
      code: 'native_package_not_cached',
      message: 'The confirmed native package is not cached',
    });
    await expectCacheEntries(f.options.cacheDirectory, []);
    await expectPreservedBytes(f.release.directory, f.bytes);
    const retry = await f.load();
    expect(retry.cacheHit).toBe(false);
    await expectCacheEntries(f.options.cacheDirectory, [basename(retry.directory)]);
  });

  it('reports explicit unsigned absence as not cached without publishing anything', async () => {
    const f = await fixture();
    const result = f.load({ attestation: null, releaseDirectory: undefined });
    await expect(result).rejects.toBeInstanceOf(NativePackageLoadError);
    await expect(result).rejects.toMatchObject({ code: 'native_package_not_cached' });
    await expectCacheEntries(f.options.cacheDirectory, []);
  });

  it.each([null, '', 'relative-source', 42, {}])(
    'retains invalid input for uncached source directory %j',
    async (releaseDirectory) => {
      const f = await fixture();
      await expect(f.load({ releaseDirectory })).rejects.toMatchObject({
        code: 'native_package_invalid',
      });
      await expectCacheEntries(f.options.cacheDirectory, []);
    },
  );

  it('does not reinterpret a nonexistent absolute source directory as an archive cache miss', async () => {
    const f = await fixture();
    await expect(f.load({ releaseDirectory: join(root, 'not-downloaded') })).rejects.toMatchObject({
      code: 'native_package_io',
    });
    await expectCacheEntries(f.options.cacheDirectory, []);
  });

  it.each(['package', 'attestation'])(
    'validates the %s pin before declaring a cache miss',
    async (kind) => {
      const f = await fixture();
      await expect(
        f.load({
          releaseDirectory: undefined,
          ...(kind === 'package'
            ? { pin: { ...f.pin, packageId: 'bad' } }
            : { attestation: undefined }),
        }),
      ).rejects.toMatchObject({ code: 'native_package_invalid' });
      await expectAbsent(f.options.cacheDirectory);
    },
  );

  it.each(ROLES)(
    'never treats missing or corrupted cached %s as an archive cache miss',
    async (role) => {
      const f = await fixture();
      const loaded = await f.load();
      const path = join(loaded.directory, f.nameFor(role));
      const corrupted = Buffer.from(f.bytes.get(f.nameFor(role)));
      corrupted[0] ^= 1;
      await chmod(path, 0o600);
      await writeFile(path, corrupted);
      await expectRejectedPackage(f.load({ releaseDirectory: undefined }));
      expect(await readFile(path)).toEqual(corrupted);
      await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);

      await chmod(loaded.directory, 0o700);
      await unlink(path);
      await expect(f.load({ releaseDirectory: undefined })).rejects.toMatchObject({
        code: 'native_package_invalid',
      });
      await expectCacheEntries(f.options.cacheDirectory, [basename(loaded.directory)]);
    },
  );

  it('keeps a preexisting empty destination invalid when no source directory is supplied', async () => {
    const f = await fixture();
    const described = describeNativePackagePin(f.pin, f.attestation);
    const directory = join(f.options.cacheDirectory, described.materializationId.slice(7));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await expect(f.load({ releaseDirectory: undefined })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    expect(await readdir(directory)).toEqual([]);
    await expectCacheEntries(f.options.cacheDirectory, [basename(directory)]);
  });
});

describe('cooperating cache publishers', () => {
  it('publishes one complete destination under concurrency and permits retry with the same pin', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => f.load()));
    const successes = outcomes
      .filter(({ status }) => status === 'fulfilled')
      .map(({ value }) => value);
    const retries = outcomes.filter(({ status }) => status === 'rejected');
    expect(successes.length).toBeGreaterThan(0);
    for (const { reason } of retries) {
      expect(reason).toMatchObject({ code: 'native_package_busy' });
      const retry = await f.load();
      expect(retry.cacheHit).toBe(true);
      successes.push(retry);
    }

    expect(successes).toHaveLength(4);
    expect(successes.filter(({ cacheHit }) => !cacheHit)).toHaveLength(1);
    const first = successes[0];
    for (const result of successes) {
      expect(result.directory).toBe(first.directory);
      expect(result.materializationId).toBe(first.materializationId);
      expect(result.package).toEqual(f.pin);
    }
    await expectPreservedBytes(first.directory, f.bytes);
    await expectCacheEntries(f.options.cacheDirectory, [basename(first.directory)]);
    expect((await lstat(first.directory)).mode & 0o777).toBe(0o500);
  });

  it('returns busy for a held lock, removes its own staging, and leaves the other owner lock intact', async () => {
    const f = await fixture();
    const reference = await f.load();
    await removeTree(reference.directory);
    const lock = `${reference.directory}.lock`;
    await mkdir(lock, { mode: 0o700 });
    const owner = join(lock, 'owner');
    await writeFile(owner, 'another publisher');

    await expect(f.load()).rejects.toMatchObject({ code: 'native_package_busy' });
    await expect(f.load({ releaseDirectory: undefined })).rejects.toMatchObject({
      code: 'native_package_busy',
    });
    await expectAbsent(reference.directory);
    expect(await readFile(owner, 'utf8')).toBe('another publisher');
    await expectCacheEntries(f.options.cacheDirectory, [basename(lock)]);

    await removeTree(lock);
    const retried = await f.load();
    expect(retried.cacheHit).toBe(false);
    expect(retried.materializationId).toBe(reference.materializationId);
    expect(retried.package).toEqual(f.pin);
    await expectPreservedBytes(retried.directory, f.bytes);
    await expectCacheEntries(f.options.cacheDirectory, [basename(retried.directory)]);
  });
});
