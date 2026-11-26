import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNativePackageArchive,
  describeNativePackageArchiveReceipt,
  NativePackageArchiveError,
} from '../native-package-archive.js';
import { describeNativePackagePin, nativePackageIdentityOf } from '../native-package-pin.js';
import {
  NATIVE_PACKAGE_LIMITS,
  NativePackageError,
  verifyNativeReleaseDirectory,
} from '../native-runtime-package.js';
import { WorkflowSourceError, workflowSourceIdentity } from '../workflow-source-bindings.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import { loadNativePackage } from '../../agentcore/native/package-loader.js';
import { createNativeReleaseFixture } from './fixtures/native-release.js';
import { createNativePackageS3 } from './fixtures/native-package-s3.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BUCKET = 'native-archive-fixture';
const OWNER = '123456789012';
const PROOF_NAME = 'aidlc-release.intoto.jsonl';
const PROOF = Buffer.from('{"fixture":"inert proof; no cryptographic claim"}\n');
const noop = async () => {};
let root;

const removable = async (path) => {
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await removable(join(path, entry.name));
  }
};
const remove = async (path) => {
  await removable(path);
  await rm(path, { recursive: true, force: true });
};
const absent = async (path) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
const clean = async (f) => {
  const entries = await readdir(f.workRoot).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  expect(entries).toEqual([]);
};
const rejected = async (promise, suffix) =>
  expect(promise).rejects.toMatchObject({
    name: 'NativePackageArchiveError',
    code: `native_package_archive_${suffix}`,
    message: new NativePackageArchiveError(`native_package_archive_${suffix}`).message,
  });
const sdkError = (status) =>
  Object.assign(new Error('https://private.example/?token=secret'), {
    name: status === 412 ? 'PreconditionFailed' : 'ConditionalRequestConflict',
    $metadata: { httpStatusCode: status },
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const fixture = async ({ proof = true, operationTimeoutMs, materialize } = {}) => {
  const home = await mkdtemp(join(root, 'case-'));
  const release = await createNativeReleaseFixture(join(home, 'release'));
  if (proof) await writeFile(join(release.directory, PROOF_NAME), PROOF);
  const pin = await verifyNativeReleaseDirectory(release);
  const attestation = proof ? { sha256: digest(PROOF), bytes: PROOF.length } : null;
  const loaded = await loadNativePackage({
    releaseDirectory: release.directory,
    cacheDirectory: join(home, 'initial-cache'),
    pin,
    attestation,
  });
  const memory = createNativePackageS3({ bucket: BUCKET, expectedBucketOwner: OWNER });
  const workRoot = join(home, 'archive-work');
  const materializer = vi.fn(materialize ?? loadNativePackage);
  const archive = createNativePackageArchive({
    s3: memory.s3,
    bucket: BUCKET,
    expectedBucketOwner: OWNER,
    workRoot,
    materialize: materializer,
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
  });
  const scope = {
    projectId: 'project-1',
    sourceId: workflowSourceIdentity(pin.source.provider, pin.source.repository).sourceId,
  };
  const scopeId = digest(canonicalJson({ schemaVersion: 1, ...scope }));
  const prefix = `native-packages/v1/${scopeId}/${loaded.materializationId.slice(7)}/`;
  const description = describeNativePackagePin(pin, attestation);
  const bytes = new Map(
    await Promise.all(
      description.files.map(async ({ name }) => [
        name,
        await readFile(join(loaded.directory, name)),
      ]),
    ),
  );
  const cacheDirectory = join(home, 'cold-cache');
  return {
    ...scope,
    archive,
    home,
    release,
    pin,
    attestation,
    loaded,
    memory,
    workRoot,
    materializer,
    prefix,
    description,
    bytes,
    cacheDirectory,
    manifestKey: `${prefix}manifest.json`,
    publish: (overrides = {}) =>
      archive.publish({ ...scope, materialization: loaded, beforeCommit: noop, ...overrides }),
    recover: (overrides = {}) =>
      archive.recoverReceipt({
        ...scope,
        pin,
        attestation,
        materializationId: loaded.materializationId,
        beforeReturn: noop,
        ...overrides,
      }),
    restore: (receipt, overrides = {}) =>
      archive.restore({
        ...scope,
        pin,
        attestation,
        materializationId: loaded.materializationId,
        receipt,
        cacheDirectory,
        beforeMaterialize: noop,
        ...overrides,
      }),
  };
};
const storedManifest = (f, receipt) => {
  const stored = f.memory.objects.get(f.manifestKey).get(receipt.manifest.versionId);
  return { stored, manifest: JSON.parse(stored.bytes.toString()) };
};
const rewriteManifest = (f, receipt, edit) => {
  const { manifest } = storedManifest(f, receipt);
  edit(manifest);
  const bytes = Buffer.from(canonicalJson(manifest));
  const stored = f.memory.putVersion(f.manifestKey, bytes);
  return {
    schemaVersion: 1,
    materializationId: f.loaded.materializationId,
    manifest: { versionId: stored.versionId, sha256: digest(bytes), bytes: bytes.length },
  };
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-package-archive-')));
});
afterEach(async () => {
  await remove(root);
});

describe('durable native package bytes', () => {
  it('publishes exact files with conditional checksummed puts and commits a closed manifest last', async () => {
    const f = await fixture();
    const events = [];
    f.memory.beforeSend = ({ name, input }) => {
      events.push(`${name}:${input.Key}`);
    };
    const receipt = await f.publish({
      materialization: {
        ...f.loaded,
        token: 'private-source-token',
        package: {
          ...f.pin,
          verification: { attestation: 'verified' },
          inventory: { privatePath: '/secret/workspace' },
        },
      },
      beforeCommit: async () => {
        events.push('authorize');
        return { token: 'never-forward-callback-receipts' };
      },
    });
    expect(receipt).toEqual({
      schemaVersion: 1,
      materializationId: f.loaded.materializationId,
      manifest: {
        versionId: expect.any(String),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.manifest)).toBe(true);
    expect(events.at(-2)).toBe('authorize');
    expect(events.at(-1)).toBe(`PutObjectCommand:${f.manifestKey}`);
    expect(f.memory.operations).toHaveLength(6);
    for (const { name, input } of f.memory.operations) {
      expect(name).toBe('PutObjectCommand');
      expect(input).toMatchObject({
        Bucket: BUCKET,
        ExpectedBucketOwner: OWNER,
        IfNoneMatch: '*',
        ContentLength: input.Body.length,
        ChecksumSHA256: createHash('sha256').update(input.Body).digest('base64'),
      });
    }
    const { manifest, stored } = storedManifest(f, receipt);
    expect(digest(stored.bytes)).toBe(receipt.manifest.sha256);
    expect(stored.bytes.length).toBe(receipt.manifest.bytes);
    expect(Object.keys(manifest).toSorted()).toEqual(
      [
        'schemaVersion',
        'projectId',
        'sourceId',
        'packagePin',
        'attestation',
        'materializationId',
        'files',
      ].toSorted(),
    );
    expect(manifest.packagePin).toEqual({
      ...nativePackageIdentityOf(f.pin),
      packageId: f.pin.packageId,
    });
    expect(manifest.attestation).toEqual({ name: PROOF_NAME, ...f.attestation });
    for (const file of manifest.files) {
      expect(Object.keys(file).toSorted()).toEqual(['bytes', 'name', 'sha256', 'versionId']);
      expect(
        f.memory.objects.get(`${f.prefix}files/${file.name}`).get(file.versionId).bytes,
      ).toEqual(f.bytes.get(file.name));
    }
    expect(stored.bytes.toString()).not.toMatch(
      /token|privatePath|verification|inventory|workspace/,
    );
    expect(f.materializer).not.toHaveBeenCalled();
    await clean(f);
  });

  it.each([true, false])(
    'recovers a cold cache with proof=%s using only pinned S3 versions',
    async (proof) => {
      const f = await fixture({ proof });
      const receipt = await f.publish();
      await remove(f.release.directory);
      await remove(join(f.home, 'initial-cache'));
      f.memory.operations.length = 0;
      const beforeMaterialize = vi.fn(async () => {
        expect(f.materializer).not.toHaveBeenCalled();
        expect(f.memory.operations).toHaveLength(f.description.files.length + 1);
      });
      const loaded = await f.restore(receipt, { beforeMaterialize });
      expect(beforeMaterialize).toHaveBeenCalledOnce();
      expect(loaded).toMatchObject({
        materializationId: f.loaded.materializationId,
        package: f.pin,
        attestation: proof ? { name: PROOF_NAME, ...f.attestation } : null,
        cacheHit: false,
      });
      for (const [name, bytes] of f.bytes)
        expect(await readFile(join(loaded.directory, name))).toEqual(bytes);
      for (const { name, input } of f.memory.operations) {
        expect(name).toBe('GetObjectCommand');
        expect(input.ExpectedBucketOwner).toBe(OWNER);
        expect(input.VersionId).toEqual(expect.any(String));
      }
      expect(f.memory.operations[0].input).toMatchObject({
        Key: f.manifestKey,
        VersionId: receipt.manifest.versionId,
      });
      expect(loaded.package.verification.attestation).toBe('not-verified');
      await clean(f);
    },
  );

  it('keeps signed and explicitly unsigned materializations distinct', async () => {
    const signed = await fixture();
    const unsigned = await fixture({ proof: false });
    expect(signed.pin.packageId).toBe(unsigned.pin.packageId);
    expect(signed.loaded.materializationId).not.toBe(unsigned.loaded.materializationId);
    const receipt = await signed.publish();
    await rejected(unsigned.restore(receipt), 'invalid');
    expect(unsigned.memory.operations).toEqual([]);
  });

  it('rechecks reusable files and the manifest without creating new versions', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    f.memory.operations.length = 0;
    const beforeCommit = vi.fn(noop);
    expect(await f.publish({ beforeCommit })).toEqual(receipt);
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(f.memory.operations.filter(({ name }) => name === 'GetObjectCommand')).toHaveLength(6);
    expect([...f.memory.objects.values()].every((versions) => versions.size === 1)).toBe(true);
    await clean(f);
  });

  it('concurrent publishers converge on the same immutable commit', async () => {
    const f = await fixture();
    const receipts = await Promise.all([f.publish(), f.publish()]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(f.memory.objects.size).toBe(6);
    expect([...f.memory.objects.values()].every((versions) => versions.size === 1)).toBe(true);
    await clean(f);
  });

  it.each(['file', 'manifest'])(
    'recovers after a lost %s put acknowledgement without overwriting',
    async (kind) => {
      const f = await fixture();
      let lost = false;
      f.memory.afterSend = ({ name, input }) => {
        if (
          !lost &&
          name === 'PutObjectCommand' &&
          (kind === 'file' ? input.Key.endsWith('/version.json') : input.Key === f.manifestKey)
        ) {
          lost = true;
          throw new Error('https://private.example/lost?token=secret');
        }
      };
      await rejected(f.publish(), 'unavailable');
      await clean(f);
      const receipt = await f.publish();
      expect((await f.restore(receipt)).package.packageId).toBe(f.pin.packageId);
      expect([...f.memory.objects.values()].every((versions) => versions.size === 1)).toBe(true);
    },
  );

  it('uploads the verified private snapshot even if the original cache changes during puts', async () => {
    const f = await fixture();
    let changed = false;
    f.memory.beforeSend = async ({ name }) => {
      if (name === 'PutObjectCommand' && !changed) {
        changed = true;
        const path = join(f.loaded.directory, f.pin.assets.binary.name);
        await chmod(path, 0o600);
        await writeFile(path, 'changed caller-owned cache bytes');
      }
    };
    const receipt = await f.publish();
    const restored = await f.restore(receipt);
    expect(await readFile(restored.binaryPath)).toEqual(f.bytes.get(f.pin.assets.binary.name));
    await clean(f);
  });

  it('rejects a self-consistent forged report over invalid runtime bytes before any S3 put', async () => {
    const f = await fixture();
    await chmod(f.release.directory, 0o700);
    const runtime = Buffer.from('not an archive; report claims are not verification');
    await writeFile(join(f.release.directory, f.release.runtimeName), runtime);
    const metadata = JSON.parse(await readFile(join(f.release.directory, 'version.json'), 'utf8'));
    Object.assign(
      metadata.assets.find(({ kind }) => kind === 'runtime'),
      {
        sha256: digest(runtime),
        bytes: runtime.length,
      },
    );
    const versionBytes = Buffer.from(JSON.stringify(metadata));
    const checksums = Buffer.from(
      `${digest(versionBytes)}  version.json\n${metadata.assets.map(({ sha256, name }) => `${sha256}  ${name}\n`).join('')}`,
    );
    await writeFile(join(f.release.directory, 'version.json'), versionBytes);
    await writeFile(join(f.release.directory, 'checksums.txt'), checksums);
    const pin = structuredClone(f.pin);
    pin.manifestSha256 = digest(versionBytes);
    pin.checksumsSha256 = digest(checksums);
    pin.assets.runtime = {
      name: f.release.runtimeName,
      sha256: digest(runtime),
      bytes: runtime.length,
    };
    pin.packageId = `sha256:${digest(canonicalJson(nativePackageIdentityOf(pin)))}`;
    const description = describeNativePackagePin(pin, f.attestation);
    await rejected(
      f.publish({
        materialization: {
          ...f.loaded,
          directory: f.release.directory,
          package: pin,
          materializationId: description.materializationId,
        },
      }),
      'corrupt',
    );
    expect(f.memory.operations).toEqual([]);
    await clean(f);
  });
});

describe('receipt recovery for an originally pinned candidate', () => {
  it('recovers a lost manifest acknowledgement after all local files are lost, then restores using only GETs', async () => {
    const f = await fixture();
    // Represents the original candidate saved in the protected job before
    // publication. No receipt or live provider discovery survives the crash.
    const candidate = structuredClone({
      projectId: f.projectId,
      sourceId: f.sourceId,
      pin: f.pin,
      attestation: f.attestation,
      materializationId: f.loaded.materializationId,
    });
    f.memory.afterSend = ({ name, input }) => {
      if (name === 'PutObjectCommand' && input.Key === f.manifestKey)
        throw new Error('Manifest committed; acknowledgement lost');
    };
    await rejected(f.publish(), 'unavailable');
    const committed = f.memory.latest(f.manifestKey);
    const manifest = JSON.parse(committed.bytes.toString());
    await remove(f.home);
    f.memory.operations.length = 0;
    f.memory.afterSend = undefined;
    const materialize = vi.fn(loadNativePackage);
    const workRoot = join(root, 'new-worker-work');
    const archive = createNativePackageArchive({
      s3: f.memory.s3,
      bucket: BUCKET,
      expectedBucketOwner: OWNER,
      workRoot,
      materialize,
    });
    const beforeReturn = vi.fn(async () => {
      expect(f.memory.operations).toHaveLength(manifest.files.length + 1);
      expect(materialize).not.toHaveBeenCalled();
      return { token: 'ignored-callback-receipt' };
    });
    const receipt = await archive.recoverReceipt({ ...candidate, beforeReturn });
    expect(beforeReturn).toHaveBeenCalledOnce();
    expect(receipt).toEqual({
      schemaVersion: 1,
      materializationId: candidate.materializationId,
      manifest: {
        versionId: committed.versionId,
        sha256: digest(committed.bytes),
        bytes: committed.bytes.length,
      },
    });
    expect(Object.isFrozen(receipt.manifest)).toBe(true);
    expect(f.memory.operations[0].input).toEqual({
      Bucket: BUCKET,
      ExpectedBucketOwner: OWNER,
      Key: f.manifestKey,
    });
    expect(f.memory.operations.slice(1).map(({ input }) => input.VersionId)).toEqual(
      manifest.files.map(({ versionId }) => versionId),
    );
    await absent(workRoot); // Recovery hashes streams without staging any files.
    const restored = await archive.restore({
      ...candidate,
      receipt,
      cacheDirectory: join(root, 'new-worker-cache'),
      beforeMaterialize: noop,
    });
    expect(restored.package).toEqual(candidate.pin);
    for (const [name, bytes] of f.bytes)
      expect(await readFile(join(restored.directory, name))).toEqual(bytes);
    expect(f.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it.each([false, true])(
    'returns not_found without assembling partial uploads (partial=%s)',
    async (partial) => {
      const f = await fixture();
      if (partial) {
        await expect(
          f.publish({
            beforeCommit: async () => {
              throw new WorkflowSourceError('WORKFLOW_SOURCE_CONFLICT', 'Publication interrupted');
            },
          }),
        ).rejects.toBeInstanceOf(WorkflowSourceError);
        expect(f.memory.objects.size).toBe(5);
      }
      f.memory.operations.length = 0;
      const beforeReturn = vi.fn(noop);
      await rejected(f.recover({ beforeReturn }), 'not_found');
      expect(beforeReturn).not.toHaveBeenCalled();
      expect(f.materializer).not.toHaveBeenCalled();
      expect(f.memory.operations.map(({ name }) => name)).toEqual(['GetObjectCommand']);
      expect(f.memory.objects.has(f.manifestKey)).toBe(false);
    },
  );

  it.each([
    ['project', () => ({ projectId: '../another-project' })],
    ['source', () => ({ sourceId: workflowSourceIdentity('github', 'other/repo').sourceId })],
    [
      'pin source',
      (f) => ({ pin: { ...f.pin, source: { ...f.pin.source, repository: 'other/repo' } } }),
    ],
    ['materialization', () => ({ materializationId: `sha256:${'0'.repeat(64)}` })],
    ['callback', () => ({ beforeReturn: undefined })],
  ])('rejects invalid original %s input before I/O', async (_, overrides) => {
    const f = await fixture();
    await rejected(f.recover(overrides(f)), 'invalid');
    expect(f.memory.operations).toEqual([]);
    expect(f.materializer).not.toHaveBeenCalled();
    await absent(f.workRoot);
  });

  it.each([
    [
      'source',
      (manifest) => {
        manifest.sourceId = 'b'.repeat(64);
      },
    ],
    [
      'materialization',
      (manifest) => {
        manifest.materializationId = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'file whitelist',
      (manifest) => {
        manifest.files[0].name = '../version.json';
      },
    ],
  ])('rejects a committed manifest with altered %s', async (_, edit) => {
    const f = await fixture();
    rewriteManifest(f, await f.publish(), edit);
    f.memory.operations.length = 0;
    const beforeReturn = vi.fn(noop);
    await rejected(f.recover({ beforeReturn }), 'corrupt');
    expect(beforeReturn).not.toHaveBeenCalled();
    expect(f.memory.operations.map(({ name }) => name)).toEqual(['GetObjectCommand']);
    expect(f.materializer).not.toHaveBeenCalled();
  });

  it.each(['version.json', 'checksums.txt', 'binary', 'runtime', PROOF_NAME])(
    'hashes the exact stored %s file version before returning a receipt',
    async (role) => {
      const f = await fixture();
      await f.publish();
      const fileName =
        role === 'binary'
          ? f.pin.assets.binary.name
          : role === 'runtime'
            ? f.pin.assets.runtime.name
            : role;
      f.memory.latest(`${f.prefix}files/${fileName}`).bytes[0] ^= 1;
      f.memory.operations.length = 0;
      const beforeReturn = vi.fn(noop);
      await rejected(f.recover({ beforeReturn }), 'corrupt');
      expect(beforeReturn).not.toHaveBeenCalled();
      expect(f.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
      expect(f.materializer).not.toHaveBeenCalled();
    },
  );

  it('never substitutes a latest file version when the committed version is missing', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const { manifest } = storedManifest(f, receipt);
    const file = manifest.files[0];
    const key = `${f.prefix}files/${file.name}`;
    f.memory.objects.get(key).delete(file.versionId);
    f.memory.putVersion(key, f.bytes.get(file.name));
    f.memory.operations.length = 0;
    await rejected(f.recover(), 'corrupt');
    expect(f.memory.operations.at(-1).input.VersionId).toBe(file.versionId);
    expect(f.memory.operations).toHaveLength(2);
    expect(f.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
  });

  it('recovers the commit while ignoring different latest file versions', async () => {
    const f = await fixture({ proof: false });
    const receipt = await f.publish();
    for (const file of f.description.files)
      f.memory.putVersion(`${f.prefix}files/${file.name}`, Buffer.from('different latest bytes'));
    f.memory.operations.length = 0;
    expect(await f.recover()).toEqual(receipt);
    expect(f.memory.operations).toHaveLength(5);
    expect(f.memory.operations.slice(1).every(({ input }) => input.VersionId !== undefined)).toBe(
      true,
    );
  });

  it.each(['WORKFLOW_SOURCE_FORBIDDEN', 'WORKFLOW_SOURCE_CONFLICT'])(
    'preserves %s from reauthorization after all files were verified',
    async (code) => {
      const f = await fixture();
      await f.publish();
      f.memory.operations.length = 0;
      const failure = new WorkflowSourceError(code, 'Source authorization changed');
      await expect(
        f.recover({
          beforeReturn: async () => {
            expect(f.memory.operations).toHaveLength(6);
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(f.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
      expect(f.materializer).not.toHaveBeenCalled();
    },
  );

  it('sanitizes an unknown callback failure and returns no receipt', async () => {
    const f = await fixture();
    await f.publish();
    await rejected(
      f.recover({
        beforeReturn: async () => {
          throw new Error('https://private.example/?token=secret');
        },
      }),
      'unavailable',
    );
    expect(f.materializer).not.toHaveBeenCalled();
  });

  it('requires a real manifest VersionId and does not invoke the authorization callback on failure', async () => {
    const f = await fixture();
    await f.publish();
    f.memory.afterSend = ({ name, input, response }) =>
      name === 'GetObjectCommand' && input.Key === f.manifestKey
        ? { ...response, VersionId: 'null' }
        : undefined;
    const beforeReturn = vi.fn(noop);
    await rejected(f.recover({ beforeReturn }), 'corrupt');
    expect(beforeReturn).not.toHaveBeenCalled();
  });
});

describe('archive identity and authorization boundaries', () => {
  it.each(['../escape', 'a/b', 'a%2fb', 'a\n', '', 'a'.repeat(257)])(
    'rejects unsafe project identity %j before storage I/O',
    async (projectId) => {
      const f = await fixture();
      await rejected(f.publish({ projectId }), 'invalid');
      expect(f.memory.operations).toEqual([]);
      await clean(f);
    },
  );

  it('rejects a source belonging to another repository before I/O', async () => {
    const f = await fixture();
    await rejected(
      f.publish({ sourceId: workflowSourceIdentity('github', 'other/repo').sourceId }),
      'invalid',
    );
    expect(f.memory.operations).toEqual([]);
  });

  it('cannot resolve a receipt through a different project prefix', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const puts = f.memory.operations.length;
    await rejected(f.restore(receipt, { projectId: 'project-2' }), 'not_found');
    expect(f.memory.operations).toHaveLength(puts + 1);
    expect(f.memory.operations.at(-1).input.Key).not.toBe(f.manifestKey);
    expect(f.materializer).not.toHaveBeenCalled();
  });

  it.each(['publish', 'restore'])('requires the %s authorization callback', async (operation) => {
    const f = await fixture();
    const receipt = await f.publish();
    f.memory.operations.length = 0;
    await rejected(
      operation === 'publish'
        ? f.publish({ beforeCommit: undefined })
        : f.restore(receipt, { beforeMaterialize: undefined }),
      'invalid',
    );
    expect(f.memory.operations).toEqual([]);
  });

  it.each(['WORKFLOW_SOURCE_FORBIDDEN', 'WORKFLOW_SOURCE_CONFLICT'])(
    'preserves trusted %s denial before committing and before materializing',
    async (code) => {
      const f = await fixture();
      const failure = new WorkflowSourceError(code, 'Safe workflow source denial');
      const deny = async () => {
        throw failure;
      };
      await expect(f.publish({ beforeCommit: deny })).rejects.toBe(failure);
      expect(f.memory.objects.has(f.manifestKey)).toBe(false);
      await clean(f);
      const receipt = await f.publish();
      await expect(f.restore(receipt, { beforeMaterialize: deny })).rejects.toBe(failure);
      expect(f.materializer).not.toHaveBeenCalled();
      await absent(f.cacheDirectory);
      await clean(f);
    },
  );

  it('reauthorizes after the existing commit read before returning its receipt', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const failure = new WorkflowSourceError('WORKFLOW_SOURCE_CONFLICT', 'Source changed');
    let changed = false;
    f.memory.afterSend = ({ name, input }) => {
      if (name === 'GetObjectCommand' && input.Key === f.manifestKey) changed = true;
    };
    await expect(
      f.publish({
        beforeCommit: async () => {
          if (changed) throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(f.memory.latest(f.manifestKey).versionId).toBe(receipt.manifest.versionId);
    await clean(f);
  });

  it.each(['publish', 'restore'])(
    'sanitizes unknown %s callback failures and cleans staging',
    async (operation) => {
      const f = await fixture();
      const receipt = await f.publish();
      const deny = async () => {
        throw new Error('https://private.example/?token=secret /private/path');
      };
      await rejected(
        operation === 'publish'
          ? f.publish({ beforeCommit: deny })
          : f.restore(receipt, { beforeMaterialize: deny }),
        'unavailable',
      );
      await clean(f);
    },
  );

  it('snapshots the restore receipt and pin before the first await', async () => {
    const f = await fixture();
    const receipt = structuredClone(await f.publish());
    const pin = structuredClone(f.pin);
    const restoring = f.restore(receipt, { pin });
    receipt.manifest.versionId = 'changed';
    receipt.manifest.sha256 = '0'.repeat(64);
    pin.source.commit = 'b'.repeat(40);
    expect((await restoring).package).toEqual(f.pin);
  });
});

describe('committed archive corruption', () => {
  it('does not accept partial files without the pinned commit record', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    f.memory.objects.delete(f.manifestKey);
    f.memory.operations.length = 0;
    await rejected(f.restore(receipt), 'not_found');
    expect(f.memory.operations).toHaveLength(1);
    expect(f.materializer).not.toHaveBeenCalled();
    await clean(f);
  });

  it('never follows replaced latest manifest or file versions', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const { manifest } = storedManifest(f, receipt);
    for (const file of manifest.files)
      f.memory.putVersion(`${f.prefix}files/${file.name}`, Buffer.from('new bad latest version'));
    f.memory.putVersion(f.manifestKey, Buffer.from('new bad latest manifest'));
    f.memory.operations.length = 0;
    expect((await f.restore(receipt)).package).toEqual(f.pin);
    expect(f.memory.operations.map(({ input }) => input.VersionId)).toEqual([
      receipt.manifest.versionId,
      ...manifest.files.map(({ versionId }) => versionId),
    ]);
  });

  it('rejects a missing pinned file version without reading a replacement', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const { manifest } = storedManifest(f, receipt);
    const file = manifest.files[0];
    f.memory.objects.get(`${f.prefix}files/${file.name}`).delete(file.versionId);
    f.memory.putVersion(`${f.prefix}files/${file.name}`, f.bytes.get(file.name));
    await rejected(f.restore(receipt), 'corrupt');
    expect(f.materializer).not.toHaveBeenCalled();
    await clean(f);
  });

  it.each(['manifest', 'file'])(
    'rejects a response for the wrong %s VersionId despite matching bytes',
    async (kind) => {
      const f = await fixture();
      const receipt = await f.publish();
      f.memory.afterSend = ({ name, input, response }) => {
        if (
          name === 'GetObjectCommand' &&
          (kind === 'manifest' ? input.Key === f.manifestKey : input.Key.endsWith('/version.json'))
        )
          return { ...response, VersionId: 'another-version' };
      };
      await rejected(f.restore(receipt), 'corrupt');
      await clean(f);
    },
  );

  it('hashes bytes independently of matching S3 checksum claims', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    const key = `${f.prefix}files/${f.pin.assets.binary.name}`;
    const stored = f.memory.latest(key);
    const originalChecksum = createHash('sha256').update(stored.bytes).digest('base64');
    stored.bytes[0] ^= 1;
    f.memory.afterSend = ({ name, input, response }) => {
      if (name === 'GetObjectCommand' && input.Key === key)
        return { ...response, ChecksumSHA256: originalChecksum };
    };
    await rejected(f.restore(receipt), 'corrupt');
    expect(f.materializer).not.toHaveBeenCalled();
    await clean(f);
  });

  it.each([
    [
      'unknown field',
      (m) => {
        m.token = 'secret';
      },
    ],
    [
      'project',
      (m) => {
        m.projectId = 'project-2';
      },
    ],
    [
      'source',
      (m) => {
        m.sourceId = 'a'.repeat(64);
      },
    ],
    [
      'pin',
      (m) => {
        m.packagePin.source.commit = 'b'.repeat(40);
      },
    ],
    [
      'proof absence',
      (m) => {
        m.attestation = null;
      },
    ],
    [
      'file path',
      (m) => {
        m.files[0].name = '../version.json';
      },
    ],
    [
      'null version',
      (m) => {
        m.files[0].versionId = 'null';
      },
    ],
    [
      'duplicate file',
      (m) => {
        m.files[1] = m.files[0];
      },
    ],
    [
      'missing file',
      (m) => {
        m.files.pop();
      },
    ],
  ])('rejects a correctly hashed commit with invalid %s metadata', async (_, edit) => {
    const f = await fixture();
    const receipt = rewriteManifest(f, await f.publish(), edit);
    f.memory.operations.length = 0;
    await rejected(f.restore(receipt), 'corrupt');
    expect(f.memory.operations).toHaveLength(1);
    expect(f.materializer).not.toHaveBeenCalled();
    await clean(f);
  });

  it.each(['sha256', 'bytes'])(
    'checks receipt manifest %s against the actual object',
    async (field) => {
      const f = await fixture();
      const receipt = structuredClone(await f.publish());
      receipt.manifest[field] = field === 'sha256' ? '0'.repeat(64) : receipt.manifest.bytes + 1;
      await rejected(f.restore(receipt), 'corrupt');
      expect(f.materializer).not.toHaveBeenCalled();
    },
  );

  it('does not overwrite a conflicting preexisting file on publication', async () => {
    const f = await fixture();
    const key = `${f.prefix}files/version.json`;
    const stored = f.memory.putVersion(key, Buffer.from('corrupt preexisting file'));
    await rejected(f.publish(), 'corrupt');
    expect(f.memory.latest(key)).toBe(stored);
    expect(f.memory.objects.has(f.manifestKey)).toBe(false);
    await clean(f);
  });

  it('does not overwrite a conflicting preexisting manifest', async () => {
    const f = await fixture();
    const stored = f.memory.putVersion(f.manifestKey, Buffer.from('corrupt existing commit'));
    await rejected(f.publish(), 'corrupt');
    expect(f.memory.latest(f.manifestKey)).toBe(stored);
    expect(f.memory.objects.get(f.manifestKey).size).toBe(1);
    await clean(f);
  });
});

describe('bounded storage and filesystem handling', () => {
  it.each([
    ['unavailable', new Error('private materializer failure /private/path?token=secret')],
    ['corrupt', new NativePackageError('private invalid package details')],
    ['busy', Object.assign(new Error('private cache location'), { code: 'native_package_busy' })],
  ])('sanitizes a materializer failure as %s and cleans its downloads', async (code, failure) => {
    const f = await fixture({
      materialize: async () => {
        throw failure;
      },
    });
    const receipt = await f.publish();
    await rejected(f.restore(receipt), code);
    await clean(f);
  });

  it('rejects a mismatched materializer result and removes staging', async () => {
    const f = await fixture({
      materialize: async (request) => ({
        ...(await loadNativePackage(request)),
        materializationId: `sha256:${'0'.repeat(64)}`,
      }),
    });
    const receipt = await f.publish();
    await rejected(f.restore(receipt), 'corrupt');
    await clean(f);
  });

  it.each([0, -1, 120001, Infinity, '30'])(
    'rejects an unbounded/invalid timeout %j',
    (operationTimeoutMs) => {
      expect(() =>
        createNativePackageArchive({
          s3: createNativePackageS3().s3,
          bucket: BUCKET,
          expectedBucketOwner: OWNER,
          workRoot: join(root, 'unused-work'),
          materialize: loadNativePackage,
          operationTimeoutMs,
        }),
      ).toThrow(new NativePackageArchiveError('native_package_archive_invalid'));
    },
  );

  it.each([undefined, '', 'null', 'https://private.example/version'])(
    'requires a usable VersionId on successful puts (%j)',
    async (VersionId) => {
      const f = await fixture();
      f.memory.afterSend = ({ name, response }) =>
        name === 'PutObjectCommand' ? { ...response, VersionId } : undefined;
      await rejected(f.publish(), 'unavailable');
      expect(f.memory.objects.has(f.manifestKey)).toBe(false);
      await clean(f);
    },
  );

  it.each(['file', 'manifest'])(
    'returns busy for a 409 %s put without reading or repairing',
    async (kind) => {
      const f = await fixture();
      f.memory.beforeSend = ({ name, input }) => {
        if (name === 'PutObjectCommand' && (kind === 'file' || input.Key === f.manifestKey))
          throw sdkError(409);
      };
      await rejected(f.publish(), 'busy');
      expect(f.memory.operations.every(({ name }) => name === 'PutObjectCommand')).toBe(true);
      await clean(f);
    },
  );

  it.each(['missing length', 'oversize length', 'truncated body', 'extra bytes', 'body error'])(
    'rejects %s and destroys the body before returning',
    async (kind) => {
      const f = await fixture();
      const receipt = await f.publish();
      let body;
      f.memory.afterSend = ({ name, input, response }) => {
        if (name !== 'GetObjectCommand' || !input.Key.endsWith('/version.json')) return;
        response.Body.destroy();
        const bytes = f.bytes.get('version.json');
        body =
          kind === 'body error'
            ? new Readable({
                read() {
                  this.destroy(new Error('private body error'));
                },
              })
            : Readable.from([
                kind === 'truncated body'
                  ? bytes.subarray(1)
                  : kind === 'extra bytes'
                    ? Buffer.concat([bytes, Buffer.from('x')])
                    : bytes,
              ]);
        return {
          ...response,
          Body: body,
          ContentLength:
            kind === 'missing length'
              ? undefined
              : kind === 'oversize length'
                ? NATIVE_PACKAGE_LIMITS.metadataBytes + 1
                : bytes.length,
        };
      };
      await rejected(f.restore(receipt), kind === 'body error' ? 'unavailable' : 'corrupt');
      expect(body.destroyed).toBe(true);
      expect(f.materializer).not.toHaveBeenCalled();
      await clean(f);
    },
  );

  it('consumes split byte chunks without depending on S3 body convenience collectors', async () => {
    const f = await fixture();
    const receipt = await f.publish();
    f.memory.afterSend = ({ name, input, response }) => {
      if (name !== 'GetObjectCommand') return;
      response.Body.destroy();
      const bytes = f.memory.objects.get(input.Key).get(input.VersionId).bytes;
      const half = Math.floor(bytes.length / 2);
      return { ...response, Body: Readable.from([bytes.subarray(0, half), bytes.subarray(half)]) };
    };
    expect((await f.restore(receipt)).package).toEqual(f.pin);
  });

  it('bounds a hung S3 send and destroys a late body without late filesystem writes', async () => {
    const f = await fixture({ operationTimeoutMs: 30 });
    const receipt = await f.publish();
    const pending = deferred();
    f.memory.beforeSend = ({ name }) => (name === 'GetObjectCommand' ? pending.promise : undefined);
    await rejected(f.restore(receipt), 'unavailable');
    expect(f.memory.operations.at(-1).signal.aborted).toBe(true);
    await clean(f);
    const body = new Readable({ read() {} });
    pending.resolve({ Body: body, ContentLength: 1, VersionId: receipt.manifest.versionId });
    await new Promise((resolve) => setImmediate(resolve));
    expect(body.destroyed).toBe(true);
    expect(f.materializer).not.toHaveBeenCalled();
    await absent(f.cacheDirectory);
    await clean(f);
  });

  it('bounds a stalled body after partial restore writes, destroys it, and removes staging', async () => {
    const f = await fixture({ operationTimeoutMs: 30 });
    const receipt = await f.publish();
    let body;
    f.memory.afterSend = ({ name, input, response }) => {
      if (name !== 'GetObjectCommand' || !input.Key.endsWith(f.pin.assets.runtime.name)) return;
      response.Body.destroy();
      let pushed = false;
      body = new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            this.push(Buffer.from('x'));
          }
        },
      });
      return { ...response, Body: body };
    };
    await rejected(f.restore(receipt), 'unavailable');
    expect(body.destroyed).toBe(true);
    expect(f.materializer).not.toHaveBeenCalled();
    await absent(f.cacheDirectory);
    await clean(f);
    body.push(Buffer.from('late bytes'));
    await clean(f);
  });

  it('bounds a hung put and cleans the verified local staging directory', async () => {
    const f = await fixture({ operationTimeoutMs: 30 });
    f.memory.beforeSend = ({ name }) =>
      name === 'PutObjectCommand' ? new Promise(() => {}) : undefined;
    await rejected(f.publish(), 'unavailable');
    expect(f.memory.operations.at(-1).signal.aborted).toBe(true);
    expect(f.memory.objects.has(f.manifestKey)).toBe(false);
    await clean(f);
  });

  it('cancels a stalled Web stream through its locked reader before returning', async () => {
    const f = await fixture({ operationTimeoutMs: 30 });
    const receipt = await f.publish();
    const cancel = vi.fn();
    let body;
    f.memory.afterSend = ({ name, input, response }) => {
      if (name !== 'GetObjectCommand' || !input.Key.endsWith(f.pin.assets.runtime.name)) return;
      response.Body.destroy();
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      });
      return { ...response, Body: body };
    };
    await rejected(f.restore(receipt), 'unavailable');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(f.materializer).not.toHaveBeenCalled();
    await absent(f.cacheDirectory);
    await clean(f);
  });

  it.each(['symlink', 'fifo', 'oversize metadata', 'unexpected proof'])(
    'rejects %s in local materialization before S3 writes',
    async (kind) => {
      const f = await fixture({ proof: kind !== 'unexpected proof' });
      await chmod(f.loaded.directory, 0o700);
      const path = join(f.loaded.directory, 'version.json');
      if (kind === 'symlink' || kind === 'fifo') {
        await unlink(path);
        if (kind === 'symlink') await symlink(join(f.release.directory, 'version.json'), path);
        else await promisify(execFile)('mkfifo', [path]);
      } else if (kind === 'oversize metadata') {
        await chmod(path, 0o600);
        await writeFile(path, Buffer.alloc(NATIVE_PACKAGE_LIMITS.metadataBytes + 1));
      } else {
        await writeFile(join(f.loaded.directory, PROOF_NAME), PROOF);
      }
      await rejected(f.publish(), 'corrupt');
      expect(f.memory.operations).toEqual([]);
      await clean(f);
    },
  );

  it.each(['symlink parent', 'writable parent'])(
    'rejects a %s before creating staging descendants',
    async (kind) => {
      const f = await fixture();
      const parent = join(f.home, 'unsafe');
      const target = join(f.home, 'target');
      await mkdir(target, { mode: 0o700 });
      if (kind === 'symlink parent') await symlink(target, parent);
      else {
        await mkdir(parent, { mode: 0o777 });
        await chmod(parent, 0o777);
      }
      const archive = createNativePackageArchive({
        s3: f.memory.s3,
        bucket: BUCKET,
        expectedBucketOwner: OWNER,
        workRoot: join(parent, 'nested'),
        materialize: loadNativePackage,
      });
      await rejected(
        archive.publish({
          projectId: f.projectId,
          sourceId: f.sourceId,
          materialization: f.loaded,
          beforeCommit: noop,
        }),
        'invalid',
      );
      expect(f.memory.operations).toEqual([]);
      await absent(join(kind === 'symlink parent' ? target : parent, 'nested'));
    },
  );

  it('returns a fixed cleanup error if its own staging directory cannot be removed', async () => {
    const f = await fixture();
    await rejected(
      f.publish({
        beforeCommit: async () => {
          const [stage] = await readdir(f.workRoot);
          await chmod(join(f.workRoot, stage), 0o000);
        },
      }),
      'cleanup',
    );
    expect(f.memory.objects.has(f.manifestKey)).toBe(true);
    expect(await readdir(f.workRoot)).toHaveLength(1);
  });
});

describe('pure receipt validation', () => {
  const materializationId = `sha256:${'a'.repeat(64)}`;
  const valid = () => ({
    schemaVersion: 1,
    materializationId,
    manifest: { versionId: 'version-1', sha256: 'b'.repeat(64), bytes: 1234 },
  });

  it('returns an independent frozen snapshot without storage I/O', () => {
    const receipt = valid();
    const snapshot = describeNativePackageArchiveReceipt(receipt, materializationId);
    receipt.manifest.versionId = 'replacement';
    expect(snapshot.manifest.versionId).toBe('version-1');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
  });

  it.each([
    [
      'unknown field',
      (r) => {
        r.key = '/secret/path';
      },
    ],
    [
      'schema',
      (r) => {
        r.schemaVersion = 2;
      },
    ],
    [
      'materialization',
      (r) => {
        r.materializationId = `sha256:${'b'.repeat(64)}`;
      },
    ],
    [
      'null version',
      (r) => {
        r.manifest.versionId = 'null';
      },
    ],
    [
      'empty version',
      (r) => {
        r.manifest.versionId = '';
      },
    ],
    [
      'bad hash',
      (r) => {
        r.manifest.sha256 = 'bad';
      },
    ],
    [
      'zero bytes',
      (r) => {
        r.manifest.bytes = 0;
      },
    ],
    [
      'oversize bytes',
      (r) => {
        r.manifest.bytes = NATIVE_PACKAGE_LIMITS.metadataBytes + 1;
      },
    ],
    [
      'fractional bytes',
      (r) => {
        r.manifest.bytes = 1.5;
      },
    ],
    [
      'secret metadata',
      (r) => {
        r.manifest.token = 'secret';
      },
    ],
  ])('rejects %s with a fixed invalid error', (_, edit) => {
    const receipt = valid();
    edit(receipt);
    expect(() => describeNativePackageArchiveReceipt(receipt, materializationId)).toThrow(
      new NativePackageArchiveError('native_package_archive_invalid'),
    );
  });

  it('rejects malformed expected identities even if the receipt repeats them', () => {
    const receipt = { ...valid(), materializationId: 'not-a-hash' };
    expect(() => describeNativePackageArchiveReceipt(receipt, receipt.materializationId)).toThrow(
      new NativePackageArchiveError('native_package_archive_invalid'),
    );
  });
});
