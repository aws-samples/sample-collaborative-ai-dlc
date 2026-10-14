import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createNativePackageWorker } from '../worker.js';
import { NativePackageError } from '../../shared/native-runtime-package.js';
import { WorkflowSourceError } from '../../shared/workflow-source-bindings.js';
import { createNativePackageArchive } from '../../shared/native-package-archive.js';
import { loadNativePackage } from '../../agentcore/native/package-loader.js';
import { createNativePackageS3 } from '../../shared/test/fixtures/native-package-s3.js';
import { deferred, event, fixture, KEY, QUEUE, record, removeTree } from './fixtures.js';

let f;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await removeTree(f.root);
});
const failed = { batchItemFailures: [{ itemIdentifier: 'message-1' }] };
const passed = { batchItemFailures: [] };

const setup = (overrides = {}) => {
  const memory = createNativePackageS3();
  const trace = [];
  const hooks = {};
  const cleanup = vi.fn(async ({ authorizeCompletion }) => {
    trace.push('cleanup');
    await hooks.cleanup?.(authorizeCompletion);
  });
  const authorizeCompletion = vi.fn(async () => {
    trace.push('authorize-completion');
  });
  const finish = vi.fn(async () => {});
  let archive;
  const intake = {
    prepare: vi.fn(async (scope) => {
      trace.push('prepare');
      await hooks.prepare?.(scope);
      const receipt = await archive.publish({
        projectId: scope.projectId,
        sourceId: scope.sourceId,
        materialization: f.materialization,
        beforeCommit: async () => {
          trace.push('beforeCommit');
          await hooks.beforeCommit?.();
        },
      });
      await hooks.afterPublish?.();
      return { ...f.candidate, archiveReceipt: receipt };
    }),
    recoverPreparation: vi.fn(async ({ resolution }) => ({
      ...resolution,
      archiveReceipt: await archive.recoverReceipt({
        projectId: resolution.projectId,
        sourceId: resolution.sourceId,
        pin: resolution.packagePin,
        attestation: resolution.attestation,
        materializationId: resolution.materializationId,
        beforeReturn: async () => {
          trace.push('beforeReturn');
        },
      }),
    })),
    loadPinned: vi.fn(async ({ resolution }) => {
      await hooks.load?.();
      return archive.restore({
        projectId: resolution.projectId,
        sourceId: resolution.sourceId,
        pin: resolution.packagePin,
        attestation: resolution.attestation,
        materializationId: resolution.materializationId,
        receipt: resolution.archiveReceipt,
        cacheDirectory: join(f.root, 'restored-cache'),
        beforeMaterialize: async () => {
          trace.push('beforeMaterialize');
        },
      });
    }),
  };
  const createAttempt = vi.fn(async ({ wrapArchive }) => {
    archive = wrapArchive(
      createNativePackageArchive({
        s3: memory.s3,
        bucket: 'worker-package-tests',
        expectedBucketOwner: '123456789012',
        workRoot: join(f.root, 'archive-work'),
        materialize: loadNativePackage,
      }),
    );
    return { intake, cleanup, authorizeCompletion, finish };
  });
  const worker = createNativePackageWorker({
    jobs: f.jobs,
    expectedQueueArn: QUEUE,
    createAttempt,
    attemptTimeoutMs: 5000,
    cleanupReserveMs: 1,
    now: f.now,
    ...overrides,
  });
  return { worker, memory, trace, hooks, cleanup, createAttempt, intake };
};

describe('SQS boundary', () => {
  it.each([
    ['HTTP', { resource: '/api/jobs', httpMethod: 'POST' }],
    ['internal op', { ...event(), operation: 'prepare' }],
    ['wrong source', event(record({ eventSource: 'aws:lambda' }))],
    ['wrong queue', event(record({ eventSourceARN: `${QUEUE}-other` }))],
    ['missing message id', event(record({ messageId: undefined }))],
    ['duplicate message ids', event(record(), record())],
    [
      'oversize batch',
      event(...Array.from({ length: 11 }, (_, i) => record({ messageId: `message-${i}` }))),
    ],
  ])('rejects %s before job access', async (_, input) => {
    const s = setup();
    f.storage.calls.length = 0;
    await expect(s.worker(input)).rejects.toMatchObject({ code: 'native_package_worker_invalid' });
    expect(f.storage.calls).toHaveLength(0);
    expect(s.createAttempt).not.toHaveBeenCalled();
  });

  it.each([
    { actorId: 'attacker' },
    { pin: {} },
    { token: 'secret' },
    { operation: 'prepare' },
    { sourceId: 'a'.repeat(64) },
    { schemaVersion: 2 },
    { projectId: '../elsewhere' },
  ])('rejects forged pointer fields %j without reading a job', async (fields) => {
    const s = setup();
    f.storage.calls.length = 0;
    expect(
      await s.worker(
        event(
          record({
            body: JSON.stringify({ schemaVersion: 1, ...KEY, ...fields }),
          }),
        ),
      ),
    ).toEqual(failed);
    expect(f.storage.calls).toHaveLength(0);
  });

  it('acknowledges missing and terminal jobs without creating an attempt', async () => {
    const s = setup();
    expect(
      await s.worker(
        event(
          record({
            body: JSON.stringify({
              schemaVersion: 1,
              ...KEY,
              jobId: '33333333-3333-4333-8333-333333333333',
            }),
          }),
        ),
      ),
    ).toEqual(passed);
    const { job } = await f.jobs.claim(KEY);
    await f.jobs.fail({ ...KEY, leaseToken: job.leaseToken, code: 'native_package_invalid' });
    expect(await s.worker(event())).toEqual(passed);
    expect(s.createAttempt).not.toHaveBeenCalled();
  });

  it('returns a partial failure for a busy lease', async () => {
    await f.jobs.claim(KEY);
    const logger = { warn: vi.fn() };
    const s = setup({ logger });
    expect(await s.worker(event())).toEqual(failed);
    expect(f.storage.read().attempts).toBe(1);
    expect(s.createAttempt).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('handles duplicate job deliveries once using terminal state', async () => {
    const s = setup();
    expect(await s.worker(event(record(), record({ messageId: 'message-2' })))).toEqual(passed);
    expect(s.intake.prepare).toHaveBeenCalledOnce();
    expect(f.storage.read().attempts).toBe(1);
  });

  it('does not claim work without Lambda cleanup reserve', async () => {
    const s = setup();
    f.storage.calls.length = 0;
    expect(await s.worker(event(), { getRemainingTimeInMillis: () => 0 })).toEqual(failed);
    expect(f.storage.calls).toHaveLength(0);
  });
});

describe('lease-guarded durable preparation', () => {
  it('uses the protected actor, saves candidate before any S3 put, and cleans before success', async () => {
    const s = setup();
    s.memory.beforeSend = ({ name, input }) => {
      if (name === 'PutObjectCommand') {
        expect(f.storage.read().candidate).toEqual(f.candidate);
        s.trace.push(input.Key.endsWith('/manifest.json') ? 'commit' : 'file');
      }
    };
    f.storage.hooks.before = (command) => {
      if (
        command.input.ExpressionAttributeValues &&
        Object.values(command.input.ExpressionAttributeValues).includes('SUCCEEDED')
      )
        expect(s.cleanup).toHaveBeenCalledWith({ authorizeCompletion: true });
    };
    expect(await s.worker(event())).toEqual(passed);
    expect(s.intake.prepare).toHaveBeenCalledWith({
      projectId: f.request.projectId,
      sourceId: f.request.sourceId,
      actorId: 'trusted-actor',
      expectedRevision: f.request.bindingRevision,
      requestedRelease: 'latest',
    });
    expect(f.storage.read()).toMatchObject({
      state: 'SUCCEEDED',
      candidate: f.candidate,
      archiveReceipt: { schemaVersion: 1 },
    });
    expect(JSON.stringify(f.storage.read())).not.toMatch(
      /directory|binaryPath|verification|inventory/,
    );
    expect(s.trace.indexOf('beforeCommit')).toBeLessThan(s.trace.indexOf('commit'));
  });

  it('rejects a lease lost during source reauthorization before the S3 commit', async () => {
    const s = setup();
    s.hooks.beforeCommit = async () => {
      f.expire();
      await f.jobs.claim(KEY);
    };
    expect(await s.worker(event())).toEqual(failed);
    expect([...s.memory.objects.keys()].some((key) => key.endsWith('/manifest.json'))).toBe(false);
    expect(f.storage.read()).toMatchObject({ state: 'RUNNING', attempts: 2 });
  });

  it('recovers a committed candidate without reselecting latest after receipt persistence failed and local files vanished', async () => {
    let failReceipt = true;
    const jobs = {
      ...f.jobs,
      saveReceipt: async (input) => {
        if (failReceipt) throw new Error('private storage outage');
        return f.jobs.saveReceipt(input);
      },
    };
    const s = setup({ jobs });
    expect(await s.worker(event())).toEqual(failed);
    expect(f.storage.read()).toMatchObject({ state: 'RUNNING', candidate: f.candidate });
    expect(f.storage.read().archiveReceipt).toBeUndefined();
    await removeTree(f.release.directory);
    await removeTree(join(f.root, 'original-cache'));
    s.memory.operations.length = 0;
    failReceipt = false;
    f.expire();
    expect(await s.worker(event())).toEqual(passed);
    expect(s.intake.prepare).toHaveBeenCalledOnce();
    expect(s.intake.recoverPreparation).toHaveBeenCalledOnce();
    expect(s.intake.loadPinned).toHaveBeenCalledOnce();
    expect(s.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
    expect(f.storage.read()).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  });

  it('uses a saved receipt after a crash following publication, without reconciliation or fresh discovery', async () => {
    const s = setup();
    s.hooks.afterPublish = () => {
      throw new Error('crash before final result');
    };
    expect(await s.worker(event())).toEqual(failed);
    const receipt = f.storage.read().archiveReceipt;
    f.expire();
    expect(await s.worker(event())).toEqual(passed);
    expect(f.storage.read().archiveReceipt).toEqual(receipt);
    expect(s.intake.prepare).toHaveBeenCalledOnce();
    expect(s.intake.recoverPreparation).not.toHaveBeenCalled();
    expect(s.intake.loadPinned).toHaveBeenCalledOnce();
  });

  it('never reselects latest when a saved candidate has no committed archive', async () => {
    const { job } = await f.jobs.claim(KEY);
    await f.jobs.saveCandidate({ ...KEY, leaseToken: job.leaseToken, candidate: f.candidate });
    f.expire();
    const s = setup();
    expect(await s.worker(event())).toEqual(failed);
    expect(s.intake.prepare).not.toHaveBeenCalled();
    expect(s.intake.recoverPreparation).toHaveBeenCalledOnce();
    expect(f.storage.read().candidate).toEqual(f.candidate);
    expect(f.storage.read().state).toBe('RUNNING');
  });

  it.each([
    [
      'native_package_worker_denied',
      new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'private membership'),
    ],
    ['native_package_worker_invalid', new NativePackageError('private malformed package')],
  ])('records only safe terminal %s after complete cleanup', async (code, error) => {
    const s = setup();
    s.hooks.prepare = () => {
      throw error;
    };
    expect(await s.worker(event())).toEqual(passed);
    expect(f.storage.read()).toMatchObject({ state: 'FAILED', errorCode: code });
    expect(s.cleanup).toHaveBeenCalledWith({ authorizeCompletion: false });
    expect(JSON.stringify(f.storage.read())).not.toContain(error.message);
  });

  it('preserves final authorization denial after cleanup instead of marking success', async () => {
    const s = setup();
    s.hooks.cleanup = () => {
      throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'revoked during cleanup');
    };
    expect(await s.worker(event())).toEqual(passed);
    expect(f.storage.read()).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_worker_denied',
    });
  });

  it('leaves transient failures running and stops after the configured attempt limit', async () => {
    const s = setup();
    s.hooks.prepare = () => {
      throw new Error('private transient storage failure');
    };
    for (let i = 1; i <= 3; i++) {
      expect(await s.worker(event())).toEqual(failed);
      expect(f.storage.read()).toMatchObject({ state: 'RUNNING', attempts: i });
      f.expire();
    }
    expect(await s.worker(event())).toEqual(passed);
    expect(f.storage.read()).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_job_attempts_exhausted',
    });
    expect(s.intake.prepare).toHaveBeenCalledTimes(3);
  });

  it('awaits cooperative completion after abort rather than returning with detached work', async () => {
    const wait = deferred();
    const started = deferred();
    let signal;
    const cleanup = vi.fn(async () => {});
    const createAttempt = async (ports) => {
      signal = ports.signal;
      return {
        intake: {
          prepare: async () => {
            started.resolve();
            await wait.promise;
            await ports.guard();
          },
          loadPinned: vi.fn(),
          recoverPreparation: vi.fn(),
        },
        cleanup,
        authorizeCompletion: vi.fn(),
        finish: vi.fn(),
      };
    };
    const s = setup({ createAttempt, attemptTimeoutMs: 20 });
    let settled = false;
    const result = s.worker(event()).then((value) => {
      settled = true;
      return value;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    wait.resolve();
    expect(await result).toEqual(failed);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.storage.read().state).toBe('RUNNING');
  });
});
