import { describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { createNativeResultStore, RESULT_LEASE_MS, nativeResultQuery } from '../result-store.js';
import { createNativeResultApi } from '../result-api.js';
import { createNativeResultWorker } from '../result-worker.js';
import { createNativeResultStorage } from '../result-storage.js';
import { assertArchivePaths } from '../result-archive.js';
import { execFileSync } from 'node:child_process';
const unzipSync = (bytes) =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            'import sys,io,zipfile,json,base64; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))',
          ],
          { input: bytes, maxBuffer: 16 * 1024 * 1024 },
        ),
      ),
    ).map(([name, content]) => [name, Buffer.from(content, 'base64')]),
  );

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = async (files) => {
  const f = serialFixture();
  await f.ready();
  const published = await f.publish({ files });
  const request = {
    requestId: randomUUID(),
    publicationId: published.receipt.id,
    publicationSequence: published.receipt.sequence,
  };
  const revisions = createNativeArtifactRevisions({
    ddb: f.ddb,
    nativeTable: TABLE,
    publications: f.publications,
  });
  let time = Date.now();
  const jobs = createNativeResultStore({ ddb: f.ddb, tableName: TABLE, now: () => time });
  const artifacts = [];
  const storage = {
    upload: vi.fn(async (job, path, content) => {
      const bytes = await readFile(path);
      expect(sha(bytes)).toBe(content.sha256);
      expect(bytes.length).toBe(content.bytes);
      artifacts.push({ bytes, path, job });
      return { ...content, versionId: 'result-version' };
    }),
    remove: vi.fn(async () => {}),
    download: vi.fn(async (job) => ({
      ...job.artifact,
      downloadUrl: 'https://example.test/exact-version',
    })),
  };
  const read = async () => {
    await f.recheck();
    return f.store.get(f.row().scope);
  };
  const enqueue = vi.fn(async () => {});
  const api = createNativeResultApi({ read, revisions, jobs, storage, enqueue, now: () => time });
  const worker = createNativeResultWorker({ executions: f.store, jobs, revisions, storage });
  const build = () => worker({ ...f.row().scope, requestId: request.requestId });
  return {
    ...f,
    request,
    jobs,
    api,
    worker,
    build,
    storage,
    artifacts,
    enqueue,
    advance: () => {
      time += RESULT_LEASE_MS + 1;
    },
  };
};

describe('native obtainable results', () => {
  it('builds exact binary, empty, BOM and CRLF bytes with a public checksum manifest after cancellation', async () => {
    const files = [
      { path: 'bin/x.dat', role: 'code', content: Buffer.from([0, 255, 128]) },
      { path: 'empty', role: 'code', content: Buffer.alloc(0) },
      { path: 'bom.txt', role: 'code', content: Buffer.from('\ufeffhi\r\n') },
      { path: 'unknown.ext', role: 'code', content: Buffer.from('text\r\nend') },
    ];
    const f = await fixture(files);
    await f.store.cancel(f.bindingIdentity);
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    await f.build();
    const result = await f.api.result(f.prepared, f.request, f.recheck);
    expect(result.status).toBe('ready');
    const zip = unzipSync(f.artifacts[0].bytes);
    for (const file of files) expect(Buffer.from(zip[`files/${file.path}`])).toEqual(file.content);
    const manifest = JSON.parse(Buffer.from(zip['result-manifest.json']));
    expect(manifest).toMatchObject({
      publicationId: f.request.publicationId,
      publicationSequence: 1,
      verification: { workflowCompletion: 'not_verified', requiredChecks: 'not_recorded' },
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /versionId|credential|runtimeSession|checkpoint|object/,
    );
    await expect(access(f.artifacts[0].path)).rejects.toThrow();
  });

  it('obtains the full admitted 32 MiB binary without inline/API buffering', async () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0xfe);
    const f = await fixture([{ path: 'large.bin', role: 'code', content: bytes }]);
    const revision = await f.api.requestResult(f.prepared, f.request, f.recheck);
    expect(revision.status).toBe('pending');
    const file = (
      await f.publications.read(
        {
          ...f.row().scope,
          attemptId: f.row().attemptId,
          epoch: f.row().publicationEpoch,
        },
        f.row().publication,
      )
    ).files[0];
    f.request.fileId = file.id;
    f.request.sha256 = file.sha256;
    f.request.requestId = randomUUID();
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    await f.build();
    expect(f.artifacts[0].bytes.equals(bytes)).toBe(true);
  });

  it.each(['missing', 'tampered', 'short', 'interrupted'])(
    'fails the whole %s source transfer and supports explicit retry',
    async (fault) => {
      const f = await fixture([
        { path: 'data.bin', role: 'code', content: Buffer.from([0, 1, 2]) },
      ]);
      const objectKey = [...f.objects.keys()].find((key) => key.includes('/files/'));
      const saved = f.objects.get(objectKey);
      await f.api.requestResult(f.prepared, f.request, f.recheck);
      if (fault === 'missing') f.objects.delete(objectKey);
      else if (fault === 'tampered') f.objects.set(objectKey, Buffer.from([3, 4, 5]));
      else {
        const original = f.publications.file;
        const revisions = createNativeArtifactRevisions({
          ddb: f.ddb,
          nativeTable: TABLE,
          publications: {
            ...f.publications,
            file: async () => {
              throw new Error(fault);
            },
          },
        });
        await createNativeResultWorker({
          executions: f.store,
          jobs: f.jobs,
          revisions,
          storage: f.storage,
        })({
          ...f.row().scope,
          requestId: f.request.requestId,
        });
        expect(original).toBeTypeOf('function');
      }
      if (['missing', 'tampered'].includes(fault)) await f.build();
      expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('failed');
      expect(f.storage.upload).not.toHaveBeenCalled();
      f.objects.set(objectKey, saved);
      await f.api.requestResult(f.prepared, f.request, f.recheck);
      await f.build();
      expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('ready');
    },
  );

  it('fences duplicate/concurrent builders and expired completion, then removes the losing output', async () => {
    const f = await fixture();
    await Promise.all([1, 2].map(() => f.api.requestResult(f.prepared, f.request, f.recheck)));
    await Promise.all([f.build(), f.build()]);
    expect(f.storage.upload).toHaveBeenCalledTimes(1);
    await expect(
      f.api.requestResult(f.prepared, { ...f.request, publicationId: 'c'.repeat(64) }, f.recheck),
    ).rejects.toThrow();
    const g = await fixture();
    await g.api.requestResult(g.prepared, g.request, g.recheck);
    g.storage.upload.mockImplementationOnce(async (_job, path, content) => {
      g.advance();
      return { ...content, versionId: 'late-version' };
    });
    await g.build();
    expect(g.storage.remove).toHaveBeenCalledOnce();
    expect((await g.api.result(g.prepared, g.request, g.recheck)).status).toBe('retryable');
    await g.api.requestResult(g.prepared, g.request, g.recheck);
    await g.build();
    expect((await g.api.result(g.prepared, g.request, g.recheck)).status).toBe('ready');
  });

  it('confirms lost job-write acknowledgements without duplicating a claim', async () => {
    const f = await fixture();
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) {
        delete f.hooks.after;
        throw new Error('lost acknowledgement');
      }
    };
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    await f.build();
    expect(f.storage.upload).toHaveBeenCalledOnce();
  });

  it('regenerates a missing derived archive without changing its source publication', async () => {
    const f = await fixture();
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    await f.build();
    f.storage.download.mockRejectedValue(new Error('Missing derived version'));
    expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('retryable');
    expect((await f.api.requestResult(f.prepared, f.request, f.recheck)).status).toBe('pending');
    await f.build();
    f.storage.download.mockResolvedValue({ downloadUrl: 'exact-regenerated-version' });
    expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('ready');
    expect(f.storage.upload).toHaveBeenCalledTimes(2);
    expect(f.artifacts[0].bytes.equals(f.artifacts[1].bytes)).toBe(true);
  });
  it('cleans temporary output and publishes no URL after an upload failure', async () => {
    const f = await fixture();
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    f.storage.upload.mockRejectedValue(new Error('Upload interrupted'));
    await f.build();
    expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('failed');
    expect(f.storage.download).not.toHaveBeenCalled();
    await expect(access(f.storage.upload.mock.calls[0][1])).rejects.toThrow();
    expect((await f.api.requestResult(f.prepared, f.request, f.recheck)).status).toBe('pending');
  });

  it('preserves a version when ready-write acknowledgement and readback are uncertain', async () => {
    const f = await fixture();
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    const worker = createNativeResultWorker({
      executions: f.store,
      storage: f.storage,
      revisions: createNativeArtifactRevisions({
        ddb: f.ddb,
        nativeTable: TABLE,
        publications: f.publications,
      }),
      jobs: {
        ...f.jobs,
        finish: async (claim, result) => {
          await f.jobs.finish(claim, result);
          throw new Error('Lost acknowledgement and readback unavailable');
        },
      },
    });
    await worker({ ...f.row().scope, requestId: f.request.requestId });
    expect(f.storage.remove).not.toHaveBeenCalled();
    expect((await f.api.result(f.prepared, f.request, f.recheck)).status).toBe('ready');
  });

  it('keeps an older publication fixed when another member publishes, and denies revoked access', async () => {
    const f = await fixture();
    await f.api.requestResult(f.prepared, f.request, f.recheck);
    await f.respond();
    const claim = await f.store.claim(f.bindingIdentity);
    await f.store.dispatched({ row: claim.row });
    await f.publish();
    await f.build();
    expect((await f.api.result(f.prepared, f.request, f.recheck)).publicationId).toBe(
      f.request.publicationId,
    );
    f.storage.download.mockImplementationOnce(async () => {
      f.authorization.member = false;
      return { downloadUrl: 'must-not-return' };
    });
    await expect(f.api.result(f.prepared, f.request, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
  });

  it.each(['.env', '.npmrc', '.agents/private.json'])(
    'does not expand historical visibility for %s',
    async (path) => {
      const f = await fixture([{ path, role: 'code', content: Buffer.from('not-exported') }]);
      await expect(f.api.requestResult(f.prepared, f.request, f.recheck)).rejects.toMatchObject({
        code: 'NATIVE_RESULT_FILE_POLICY',
      });
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
});

it.each([
  ['../escape'],
  ['/absolute'],
  ['a\\b'],
  ['a:b'],
  ['CON.txt'],
  ['end.'],
  ['A', 'a'],
  ['a', 'a/b'],
  ['é', 'e\u0301'],
])('rejects unsafe archive inventories %j', (...paths) => {
  expect(() => assertArchivePaths(paths.map((path) => ({ path })))).toThrow();
});

it('checks immutable version, exact length and full SHA-256 before issuing a five-minute bearer URL', async () => {
  const f = await fixture();
  await f.api.requestResult(f.prepared, f.request, f.recheck);
  await f.build();
  const job = await f.jobs.get(f.row().scope, f.request.requestId);
  const s3 = {
    send: vi.fn(async () => ({
      VersionId: job.artifact.versionId,
      ContentLength: job.artifact.bytes,
      ChecksumSHA256: Buffer.from(job.artifact.sha256, 'hex').toString('base64'),
    })),
  };
  const presign = vi.fn(async () => 'https://example.test/signed');
  const storage = createNativeResultStorage({
    s3,
    bucket: 'result-bucket',
    accountId: '123456789012',
    presign,
  });
  const result = await storage.download(job);
  expect(result.sha256).toBe(job.artifact.sha256);
  expect(s3.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  expect(presign.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
  expect(presign.mock.calls[0][1].input.VersionId).toBe(job.artifact.versionId);
  expect(presign.mock.calls[0][2]).toEqual({ expiresIn: 300 });
  s3.send.mockResolvedValue({ VersionId: 'wrong', ContentLength: job.artifact.bytes });
  await expect(storage.download(job)).rejects.toThrow();
  expect(presign).toHaveBeenCalledOnce();
});

it('rejects duplicate, unknown and incomplete result query identities', () => {
  expect(() =>
    nativeResultQuery({ queryStringParameters: { publicationSequence: '01' } }),
  ).toThrow();
  expect(() =>
    nativeResultQuery({ multiValueQueryStringParameters: { requestId: ['a', 'b'] } }),
  ).toThrow();
});
