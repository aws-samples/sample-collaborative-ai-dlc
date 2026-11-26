import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createNativePackageAttemptFactory, createNativePackageWorkerLambda } from '../index.js';
import { createNativePackageWorker } from '../worker.js';
import { createNativePackageIntake } from '../../shared/native-package-intake.js';
import { createNativePackageArchive } from '../../shared/native-package-archive.js';
import { WorkflowSourceError } from '../../shared/workflow-source-bindings.js';
import { loadNativePackage } from '../../agentcore/native/package-loader.js';
import { createNativePackageS3 } from '../../shared/test/fixtures/native-package-s3.js';
import { deferred, event, fixture, KEY, QUEUE, TABLE, removeTree } from './fixtures.js';

let f;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTree(f.root);
});
const failed = { batchItemFailures: [{ itemIdentifier: 'message-1' }] };
const passed = { batchItemFailures: [] };
const absent = (path) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });

const hostSetup = (overrides = {}) => {
  const memory = createNativePackageS3();
  const trace = [];
  const hooks = {};
  const roots = [];
  const captures = {};
  const connection = {
    close: vi.fn(async () => {
      trace.push('close');
      await hooks.close?.();
    }),
  };
  const completionConnection = {
    close: vi.fn(async () => {
      trace.push('completion-close');
      await hooks.completionClose?.();
    }),
  };
  const openCompletionConnection = vi.fn(async () => completionConnection);
  const binding = {
    schemaVersion: 1,
    purpose: 'workflow-source',
    projectId: f.request.projectId,
    sourceId: f.request.sourceId,
    revision: f.request.bindingRevision,
    provider: f.pin.source.provider,
    repository: f.pin.source.repository,
    repo: f.pin.source.repository,
    authType: 'public',
    status: 'active',
    access: 'read',
    capabilities: { repositoryRead: true, repositoryWrite: false },
    projectIdentity: 'project-vertex-1',
    updatedBy: f.request.actorId,
  };
  const createAttempt = createNativePackageAttemptFactory({
    ddb: f.storage.ddb,
    s3: memory.s3,
    ssm: {
      send: async () => {
        throw new Error('Unexpected SSM I/O');
      },
    },
    secrets: {
      send: async () => {
        throw new Error('Unexpected Secrets I/O');
      },
    },
    bucket: 'worker-package-tests',
    expectedBucketOwner: '123456789012',
    tempDirectory: f.root,
    openConnection: async () => connection,
    openCompletionConnection,
    membershipSnapshot: async () => {
      trace.push('authorize');
      await hooks.authorize?.();
      return { role: 'owner', membershipId: 'membership-1', projectIdentity: 'project-vertex-1' };
    },
    sourceServiceFactory: ({ getMembershipSnapshot }) => ({
      getAuthorizedBinding: async (scope) => {
        await getMembershipSnapshot(scope.projectId, scope.actorId);
        return structuredClone(binding);
      },
    }),
    resolveCredential: async (input) => {
      trace.push('credential');
      await hooks.credential?.(input);
      return { purpose: 'workflow-source', token: null };
    },
    intakeFactory: (ports) => {
      captures.intake = ports;
      return createNativePackageIntake(ports);
    },
    cleanupDirectory: async (root) => {
      roots.push(root);
      await removeTree(root);
      trace.push('files-removed');
      await hooks.afterRemove?.();
    },
    ...overrides,
  });
  const worker = createNativePackageWorker({
    jobs: f.jobs,
    expectedQueueArn: QUEUE,
    createAttempt,
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? 5000,
    cleanupReserveMs: 1,
    now: f.now,
  });
  const seed = async ({ receipt = false } = {}) => {
    const { job } = await f.jobs.claim(KEY);
    const lease = { ...KEY, leaseToken: job.leaseToken };
    await f.jobs.saveCandidate({ ...lease, candidate: f.candidate });
    const archive = createNativePackageArchive({
      s3: memory.s3,
      bucket: 'worker-package-tests',
      expectedBucketOwner: '123456789012',
      workRoot: join(f.root, 'seed-archive'),
      materialize: loadNativePackage,
    });
    const storedReceipt = await archive.publish({
      projectId: f.request.projectId,
      sourceId: f.request.sourceId,
      materialization: f.materialization,
      beforeCommit: async () => {},
    });
    if (receipt) await f.jobs.saveReceipt({ ...lease, receipt: storedReceipt });
    await removeTree(f.release.directory);
    await removeTree(join(f.root, 'original-cache'));
    f.expire();
    memory.operations.length = 0;
    return storedReceipt;
  };
  return {
    worker,
    createAttempt,
    memory,
    trace,
    hooks,
    roots,
    captures,
    connection,
    completionConnection,
    openCompletionConnection,
    seed,
  };
};

describe('worker production host composition', () => {
  it.each([false, true])(
    'uses real intake/archive for cold recovery (saved receipt=%s), then authorizes after cleanup and closes before success',
    async (receipt) => {
      const h = hostSetup();
      const original = await h.seed({ receipt });
      f.storage.hooks.before = (command) => {
        if (
          command.input.ExpressionAttributeValues &&
          Object.values(command.input.ExpressionAttributeValues).includes('SUCCEEDED')
        )
          expect(h.trace.at(-1)).toBe('authorize');
      };
      expect(await h.worker(event())).toEqual(passed);
      expect(f.storage.read()).toMatchObject({ state: 'SUCCEEDED', archiveReceipt: original });
      expect(h.memory.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
      expect(h.trace.lastIndexOf('files-removed')).toBeLessThan(h.trace.lastIndexOf('authorize'));
      expect(h.trace.lastIndexOf('files-removed')).toBeLessThan(h.trace.lastIndexOf('credential'));
      expect(h.trace.lastIndexOf('close')).toBeLessThan(h.trace.lastIndexOf('authorize'));
      expect(h.connection.close).toHaveBeenCalledOnce();
      expect(h.openCompletionConnection).toHaveBeenCalledOnce();
      expect(h.completionConnection.close).not.toHaveBeenCalled();
      expect(h.roots).toHaveLength(1);
      await absent(h.roots[0]);
    },
  );

  it('rejects revocation during awaited attempt close using fresh post-close authorization', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    const closing = deferred();
    const closed = deferred();
    let revoked = false;
    h.hooks.close = async () => {
      closing.resolve();
      await closed.promise;
    };
    h.hooks.authorize = () => {
      if (revoked) throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Membership revoked');
    };
    const result = h.worker(event());
    await closing.promise;
    expect(f.storage.read().state).toBe('RUNNING');
    expect(h.openCompletionConnection).not.toHaveBeenCalled();
    revoked = true;
    closed.resolve();
    expect(await result).toEqual(passed);
    expect(f.storage.read()).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_worker_denied',
    });
    expect(h.trace.indexOf('close')).toBeLessThan(h.trace.lastIndexOf('authorize'));
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.completionConnection.close).toHaveBeenCalledOnce();
    expect(h.trace.at(-1)).toBe('completion-close');
    await absent(h.roots[0]);
  });

  it('quarantines a failed completion close and never records success', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    h.hooks.authorize = () => {
      if (h.trace.includes('close'))
        throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Membership revoked');
    };
    h.hooks.completionClose = () => {
      throw new Error('private socket failure');
    };
    expect(await h.worker(event())).toEqual(failed);
    expect(f.storage.read().state).toBe('RUNNING');
    expect(h.completionConnection.close).toHaveBeenCalledOnce();
    f.expire();
    expect(await h.worker(event())).toEqual(failed);
    expect(h.openCompletionConnection).toHaveBeenCalledOnce();
  });

  it('owns cancellation and draining of a blocked completion read', async () => {
    const h = hostSetup({ attemptTimeoutMs: 2000 });
    await h.seed({ receipt: true });
    const query = deferred();
    h.hooks.authorize = async () => {
      if (h.trace.includes('close')) await query.promise;
    };
    h.hooks.completionClose = () => {
      query.resolve();
    };
    expect(await h.worker(event())).toEqual(failed);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.completionConnection.close).toHaveBeenCalledOnce();
    expect(f.storage.read().state).toBe('RUNNING');
    await absent(h.roots[0]);
  });

  it('detects source revocation during filesystem cleanup and closes before recording denial', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    let revoked = false;
    h.hooks.afterRemove = () => {
      revoked = true;
    };
    h.hooks.authorize = () => {
      if (revoked) throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Membership revoked');
    };
    expect(await h.worker(event())).toEqual(passed);
    expect(f.storage.read()).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_worker_denied',
    });
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.trace.at(-1)).toBe('close');
    await absent(h.roots[0]);
  });

  it('fails without success when final credential authorization changes', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    h.hooks.credential = () => {
      if (h.trace.includes('files-removed'))
        throw Object.assign(new Error('private connection metadata'), {
          code: 'CONNECTION_CHANGED',
        });
    };
    expect(await h.worker(event())).toEqual(passed);
    expect(f.storage.read()).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_worker_denied',
    });
    expect(h.connection.close).toHaveBeenCalledOnce();
  });

  it('keeps a final authorization outage retryable without quarantining completed cleanup', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    let unavailable = true;
    h.hooks.credential = () => {
      if (unavailable && h.trace.includes('files-removed'))
        throw new Error('private provider outage');
    };
    expect(await h.worker(event())).toEqual(failed);
    expect(f.storage.read().state).toBe('RUNNING');
    unavailable = false;
    f.expire();
    expect(await h.worker(event())).toEqual(passed);
    expect(f.storage.read().state).toBe('SUCCEEDED');
  });

  it.each([false, true])(
    'preserves response metadata or rejects automatic redirects (redirected=%s)',
    async (redirected) => {
      const cancel = vi.fn();
      let received;
      const h = hostSetup({
        fetchImpl: async () => {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[]'));
              if (!redirected) controller.close();
            },
            cancel,
          });
          const response = new Response(body, {
            status: 200,
            headers: { 'x-next-page': '2', 'content-type': 'application/json' },
          });
          Object.defineProperties(response, {
            redirected: { value: redirected },
            url: { value: 'https://fixture.example/source' },
          });
          return response;
        },
        intakeFactory: (ports) => ({
          prepare: async () => {
            const response = await ports.fetchImpl('https://fixture.example/source', {
              headers: { Accept: 'application/json' },
              redirect: 'manual',
            });
            received = {
              url: response.url,
              redirected: response.redirected,
              nextPage: response.headers.get('x-next-page'),
              data: await response.json(),
            };
            throw new Error('Fixture stops after inspecting transport');
          },
          recoverPreparation: vi.fn(),
          loadPinned: vi.fn(),
        }),
      });
      expect(await h.worker(event())).toEqual(failed);
      if (redirected) {
        expect(cancel).toHaveBeenCalledOnce();
        expect(received).toBeUndefined();
      } else {
        expect(received).toEqual({
          url: 'https://fixture.example/source',
          redirected: false,
          nextPage: '2',
          data: [],
        });
      }
      expect(h.memory.operations).toHaveLength(0);
    },
  );

  it('keeps the lease retryable and quarantines the host when connection close fails', async () => {
    const h = hostSetup();
    await h.seed({ receipt: true });
    h.hooks.close = () => {
      throw new Error('private close failure /path');
    };
    expect(await h.worker(event())).toEqual(failed);
    expect(f.storage.read().state).toBe('RUNNING');
    expect(h.connection.close).toHaveBeenCalledOnce();
    f.expire();
    expect(await h.worker(event())).toEqual(failed);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(f.storage.read().state).toBe('RUNNING');
  });

  it('closes Neptune and preserves failed cleanup as retryable, without a success CAS', async () => {
    const h = hostSetup({
      cleanupDirectory: async () => {
        throw new Error('private filesystem cleanup failure');
      },
    });
    await h.seed({ receipt: true });
    expect(await h.worker(event())).toEqual(failed);
    expect(f.storage.read().state).toBe('RUNNING');
    expect(h.connection.close).toHaveBeenCalledOnce();
  });

  it('merges cancellation into S3 calls and drains a cooperative cancelled request', async () => {
    const h = hostSetup({ operationTimeoutMs: 15 });
    await h.seed();
    let requestSignal;
    h.memory.beforeSend = ({ name, signal }) => {
      if (name !== 'GetObjectCommand') return;
      requestSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled S3 read')), {
          once: true,
        });
      });
    };
    expect(await h.worker(event())).toEqual(failed);
    expect(requestSignal.aborted).toBe(true);
    expect(f.storage.read().state).toBe('RUNNING');
    expect(h.connection.close).toHaveBeenCalledOnce();
    await absent(h.roots[0]);
  });

  it('does not return while an S3 request ignores cancellation, and destroys its late body before cleanup', async () => {
    const h = hostSetup({ operationTimeoutMs: 15, attemptTimeoutMs: 40 });
    await h.seed();
    const pending = deferred();
    const started = deferred();
    h.memory.beforeSend = ({ name }) => {
      if (name !== 'GetObjectCommand') return;
      started.resolve();
      return pending.promise;
    };
    let completed = false;
    const result = h.worker(event()).then((value) => {
      completed = true;
      return value;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    const body = new Readable({ read() {} });
    pending.resolve({ VersionId: 'late-version', ContentLength: 1, Body: body });
    expect(await result).toEqual(failed);
    expect(body.destroyed).toBe(true);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(f.storage.read().state).toBe('RUNNING');
    await absent(h.roots[0]);
  });

  it('waits for an aborted materializer to settle before removing its private files', async () => {
    const waiting = deferred();
    const started = deferred();
    let directory;
    const h = hostSetup({
      attemptTimeoutMs: 20,
      materialize: async (request) => {
        directory = request.cacheDirectory;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        started.resolve();
        await waiting.promise;
        await writeFile(join(directory, 'inert-late-file'), 'private fixture');
        return f.materialization;
      },
      intakeFactory: (ports) => ({
        prepare: async () => ports.materialize({ cacheDirectory: ports.cacheRoot }),
        recoverPreparation: vi.fn(),
        loadPinned: vi.fn(),
      }),
    });
    let completed = false;
    const result = h.worker(event()).then((value) => {
      completed = true;
      return value;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(completed).toBe(false);
    waiting.resolve();
    expect(await result).toEqual(failed);
    expect(h.memory.operations).toHaveLength(0);
    await absent(directory);
    expect(f.storage.read().state).toBe('RUNNING');
  });

  it('cancels and drains a credential fetch body through the propagated fetch port', async () => {
    let body;
    const cancelled = vi.fn();
    const h = hostSetup({
      operationTimeoutMs: 15,
      fetchImpl: async () => {
        body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('['));
          },
          cancel: cancelled,
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
      resolveCredential: async ({ fetchImpl }) => {
        const response = await fetchImpl('https://fixture.example/credential', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        await response.json();
        return { purpose: 'workflow-source', token: null };
      },
    });
    await h.seed();
    expect(await h.worker(event())).toEqual(failed);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(f.storage.read().state).toBe('RUNNING');
  });
});

describe('worker host configuration', () => {
  it('is default-off and accepts only the exact enabled boolean', async () => {
    const jobsFactory = vi.fn();
    for (const enabled of [undefined, false, 'true']) {
      const worker = createNativePackageWorkerLambda({ enabled, jobsFactory });
      await expect(worker(event())).rejects.toMatchObject({
        code: 'native_package_worker_unavailable',
      });
    }
    expect(jobsFactory).not.toHaveBeenCalled();
  });

  it('accepts configurable ten attempts and passes the settings to the store', async () => {
    const jobsFactory = vi.fn(() => f.jobs);
    createNativePackageWorkerLambda({
      enabled: true,
      expectedQueueArn: QUEUE,
      tableName: TABLE,
      jobsFactory,
      createAttempt: vi.fn(),
      maxAttempts: 10,
      attemptTimeoutMs: 60_000,
      leaseMs: 90_000,
    });
    expect(jobsFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: TABLE,
        maxAttempts: 10,
        leaseMs: 90_000,
      }),
    );
  });

  it('uses the Terraform environment names without ambient AWS calls', async () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    ddb.on(GetCommand).resolves({});
    try {
      vi.stubEnv('NATIVE_PACKAGE_JOBS_ENABLED', 'true');
      vi.stubEnv('NATIVE_PACKAGE_JOBS_TABLE', TABLE);
      vi.stubEnv('NATIVE_PACKAGE_JOBS_QUEUE_ARN', QUEUE);
      vi.stubEnv('NATIVE_PACKAGES_BUCKET', 'worker-package-tests');
      vi.stubEnv('NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER', '123456789012');
      vi.stubEnv('NATIVE_PACKAGE_WORKER_BUDGET_MS', '60000');
      vi.stubEnv('NATIVE_PACKAGE_WORKER_LEASE_MS', '90000');
      vi.stubEnv('NATIVE_PACKAGE_WORKER_MAX_ATTEMPTS', '10');
      const { handler } = await import('../index.js');
      expect(await handler(event())).toEqual(passed);
      expect(ddb.commandCalls(GetCommand)).toHaveLength(1);
      expect(ddb.commandCalls(GetCommand)[0].args[0].input.TableName).toBe(TABLE);
    } finally {
      ddb.restore();
    }
  });
});
