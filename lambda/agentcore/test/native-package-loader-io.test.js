import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';
import { verifyNativeReleaseDirectory } from '../../shared/native-runtime-package.js';
import { loadNativePackage } from '../native/package-loader.js';

// Real files and streams, with failures injected only at the filesystem call
// under test. Package verification, copying and publication are not mocked.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

let realFs;
let root;
let fixture;
let args;
beforeAll(async () => {
  realFs = await vi.importActual('node:fs/promises');
});
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(realFs.open);
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  vi.mocked(fs.rm).mockImplementation(realFs.rm);
  root = await realFs.realpath(await realFs.mkdtemp(join(tmpdir(), 'native-loader-io-')));
  fixture = await createNativeReleaseFixture(join(root, 'release'));
  const proof = Buffer.from('{"synthetic":"not a real attestation"}\n');
  await realFs.writeFile(join(fixture.directory, 'aidlc-release.intoto.jsonl'), proof);
  const pin = await verifyNativeReleaseDirectory(fixture);
  args = {
    releaseDirectory: fixture.directory,
    cacheDirectory: join(root, 'cache'),
    pin,
    attestation: {
      sha256: createHash('sha256').update(proof).digest('hex'),
      bytes: proof.length,
    },
  };
});
afterEach(async () => {
  const makeRemovable = async (directory) => {
    await realFs.chmod(directory, 0o700);
    for (const entry of await realFs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeRemovable(join(directory, entry.name));
    }
  };
  if (root) {
    await makeRemovable(root);
    await realFs.rm(root, { recursive: true });
  }
});

describe('native package materialization I/O boundaries', () => {
  it('returns a genuine cache miss without opening release files or leaving its publication lock', async () => {
    vi.mocked(fs.open).mockClear();
    await expect(loadNativePackage({ ...args, releaseDirectory: undefined })).rejects.toMatchObject(
      { code: 'native_package_not_cached' },
    );
    expect(fs.open).not.toHaveBeenCalled();
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
  });

  it('does not report a recoverable miss when releasing its owned lock fails', async () => {
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (String(path).endsWith('.lock')) throw new Error(`EACCES ${root}/private`);
      return realFs.rm(path, options);
    });
    await expect(loadNativePackage({ ...args, releaseDirectory: undefined })).rejects.toMatchObject(
      {
        code: 'native_package_cleanup',
        message: 'Native package staging or publication lock could not be cleaned up',
      },
    );
    const entries = await realFs.readdir(args.cacheDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/\.lock$/);
  });

  it('rejects a sidecar that appears after absence was checked but before copying finishes', async () => {
    const sidecar = join(fixture.directory, 'aidlc-release.intoto.jsonl');
    await realFs.unlink(sidecar);
    let appeared = false;
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      const handle = await realFs.open(path, ...options);
      if (String(path).includes('/.stage-') && basename(path) === fixture.binaryName) {
        await realFs.writeFile(sidecar, 'New synthetic sidecar must not be silently discarded\n');
        appeared = true;
      }
      return handle;
    });
    await expect(loadNativePackage({ ...args, attestation: null })).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    expect(appeared).toBe(true);
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
  });

  it('returns busy before reading source files or staging bytes when another publisher holds the lock', async () => {
    const first = await loadNativePackage(args);
    await realFs.chmod(first.directory, 0o700);
    await realFs.rm(first.directory, { recursive: true });
    const lock = `${first.directory}.lock`;
    await realFs.mkdir(lock, { mode: 0o700 });
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.open).mockImplementation(() => {
      throw new Error('A known-busy loader must not open source files');
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_busy',
    });
    expect(fs.open).not.toHaveBeenCalled();
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([basename(lock)]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a sidecar FIFO without waiting for a writer',
    async () => {
      const sidecar = join(fixture.directory, 'aidlc-release.intoto.jsonl');
      await realFs.unlink(sidecar);
      execFileSync('mkfifo', [sidecar]);
      await expect(loadNativePackage(args)).rejects.toMatchObject({
        code: 'native_package_invalid',
      });
      expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
    },
    1000,
  );

  it('rejects a same-size source replacement between verification and copying', async () => {
    const binary = join(fixture.directory, fixture.binaryName);
    let reads = 0;
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      if (path === binary && ++reads === 2) {
        await realFs.writeFile(binary, Buffer.alloc(args.pin.assets.binary.bytes, 88));
      }
      return realFs.open(path, ...options);
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_invalid',
    });
    expect(reads).toBe(2);
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
  });

  it('bounds a file that grows after the copy descriptor was statted', async () => {
    const binary = join(fixture.directory, fixture.binaryName);
    let reads = 0;
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      const handle = await realFs.open(path, ...options);
      if (path === binary && ++reads === 2) {
        const stream = handle.createReadStream.bind(handle);
        handle.createReadStream = (streamOptions) => {
          const source = stream({ ...streamOptions, highWaterMark: 1 });
          return (async function* () {
            let first = true;
            for await (const chunk of source) {
              if (first) {
                first = false;
                await realFs.appendFile(binary, 'unconfirmed appended bytes');
              }
              yield chunk;
            }
          })();
        };
      }
      return handle;
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_invalid',
      message: expect.stringContaining('pinned size limit'),
    });
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
  });

  it('does not follow a source symlink substituted after verification', async () => {
    const binary = join(fixture.directory, fixture.binaryName);
    const outside = join(root, 'outside');
    await realFs.copyFile(binary, outside);
    let reads = 0;
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      if (path === binary && ++reads === 2) {
        await realFs.unlink(binary);
        await realFs.symlink(outside, binary);
      }
      return realFs.open(path, ...options);
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_io',
    });
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
    expect((await realFs.stat(outside)).size).toBe(args.pin.assets.binary.bytes);
  });

  it('closes failed writes and waits for other copies before removing staging', async () => {
    let closed = false;
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      const handle = await realFs.open(path, ...options);
      if (String(path).includes('/.stage-') && basename(path) === fixture.binaryName) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          closed = true;
        };
        handle.writeFile = async () => {
          throw new Error(`EIO ${root}/private-provider-details`);
        };
      }
      return handle;
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_io',
      message: 'Native package files could not be read or published',
    });
    expect(closed).toBe(true);
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
  });

  it('cleans a read-only staging directory and releases its lock after failed rename', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error(`EIO ${root}`));
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_io',
    });
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([]);
    const retry = await loadNativePackage(args);
    expect(retry.cacheHit).toBe(false);
    expect(retry.package.packageId).toBe(args.pin.packageId);
  });

  it('attempts lock cleanup even when staging cleanup fails, without leaking paths', async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error(`EIO ${root}`));
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (basename(path).startsWith('.stage-')) throw new Error(`EACCES ${root}`);
      return realFs.rm(path, options);
    });
    await expect(loadNativePackage(args)).rejects.toMatchObject({
      code: 'native_package_cleanup',
      message: 'Native package staging or publication lock could not be cleaned up',
    });
    const left = await realFs.readdir(args.cacheDirectory);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\.stage-/);
  });

  it('publishes only after every copied file has finished and been verified', async () => {
    let releaseWrite;
    let enteredWrite;
    const paused = new Promise((resolve) => (enteredWrite = resolve));
    const proceed = new Promise((resolve) => (releaseWrite = resolve));
    vi.mocked(fs.open).mockImplementation(async (path, ...options) => {
      const handle = await realFs.open(path, ...options);
      if (String(path).includes('/.stage-') && basename(path) === 'aidlc-release.intoto.jsonl') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (bytes) => {
          enteredWrite();
          await proceed;
          await write(bytes);
        };
      }
      return handle;
    });
    const loading = loadNativePackage(args);
    await paused;
    const before = await realFs.readdir(args.cacheDirectory);
    releaseWrite();
    const result = await loading;
    expect(before).toHaveLength(2);
    expect(before.some((name) => name.startsWith('.stage-'))).toBe(true);
    expect(before.some((name) => name.endsWith('.lock'))).toBe(true);
    expect(await realFs.readdir(args.cacheDirectory)).toEqual([basename(result.directory)]);
  });
});
