// Dedicated SQS consumer, default off. Deployment sizing, event-source/IAM
// acceptance and activation are separate decisions. No package code executes.
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { chmod, lstat, mkdtemp, opendir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativePackageJobs } from '../shared/native-package-jobs.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { resolveReadOnlySourceCredential } from '../shared/source-control-credentials.js';
import { getGitConnectionSnapshot } from '../shared/git-connection-store.js';
import { gitConnectionIdentity } from '../shared/git-connection-identity.js';
import { WorkflowSourceError } from '../shared/workflow-source-bindings.js';
import { createNativePackageIntake } from '../shared/native-package-intake.js';
import { createNativePackageArchive } from '../shared/native-package-archive.js';
import { loadNativePackage } from '../agentcore/native/package-loader.js';
import { createNativePackageWorker, NativePackageWorkerError } from './worker.js';

const clientOptions = {
  maxAttempts: 1,
  requestHandler: {
    connectionTimeout: 5_000,
    requestTimeout: 30_000,
    socketTimeout: 30_000,
    throwOnRequestTimeout: true,
  },
};
const defaultDdb = DynamoDBDocumentClient.from(new DynamoDBClient(clientOptions));
const defaultS3 = new S3Client(clientOptions);
const defaultSsm = new SSMClient(clientOptions);
const defaultSecrets = new SecretsManagerClient(clientOptions);
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const unavailable = () => {
  throw new NativePackageWorkerError('native_package_worker_unavailable');
};

const openNeptuneConnection = async () => {
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(
    process.env.NEPTUNE_ENDPOINT,
    process.env.GREMLIN_PORT ?? '8182',
    credentials,
    '/gremlin',
    process.env.GREMLIN_PROTOCOL ?? 'wss',
  );
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};

// Only this invocation's private tree is visited. Cache directories are 0500;
// restore directory permissions before removing them, without following links.
// The loader keeps 4/5 release files intact: runtime tar members are never
// extracted here. The limits bound this small cache/intake/staging tree only.
const removeOwnedDirectory = async (root) => {
  let entries = 0;
  const visit = async (directory, depth = 0) => {
    if (depth > 16 || ++entries > 512) unavailable();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
    await chmod(directory, 0o700);
    for await (const entry of await opendir(directory)) {
      if (++entries > 512) unavailable();
      if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(root);
  await rm(root, { recursive: true });
};

/**
 * All ports are trusted host composition, not event fields. Outstanding SDK,
 * fetch/stream, graph and materializer work is tracked until it settles. A
 * provider that ignores cancellation keeps the invocation pending rather than
 * allowing successful cleanup or another lease-authorized publication.
 */
export const createNativePackageAttemptFactory = ({
  ddb = defaultDdb,
  s3 = defaultS3,
  ssm = defaultSsm,
  secrets = defaultSecrets,
  bucket,
  expectedBucketOwner,
  tempDirectory = tmpdir(),
  operationTimeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  openConnection = openNeptuneConnection,
  openCompletionConnection = openConnection,
  membershipSnapshot = fetchWorkflowSourceMembership,
  resolveCredential = resolveReadOnlySourceCredential,
  materialize = loadNativePackage,
  sourceServiceFactory = createWorkflowSourceService,
  intakeFactory = createNativePackageIntake,
  archiveFactory = createNativePackageArchive,
  cleanupDirectory = removeOwnedDirectory,
} = {}) => {
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > 120_000
  )
    unavailable();
  let quarantined = false;
  let active = false;
  let completionConnection;
  const closeCompletionConnection = () => {
    const current = completionConnection;
    if (!current) return Promise.resolve();
    current.close ??= (async () => {
      let connection;
      try {
        connection = await current.open;
      } catch {
        // Opening failed before an owned connection was returned.
        completionConnection = undefined;
        return;
      }
      await connection.close();
      if (completionConnection === current) completionConnection = undefined;
    })();
    return current.close;
  };
  return async ({ job, signal, guard, wrapArchive }) => {
    if (quarantined || active || signal?.aborted) unavailable();
    active = true;
    let root;
    let graph;
    let connection;
    let connectionClose;
    let closing = false;
    let cleanupPromise;
    const stopped = new AbortController();
    const pending = new Set();
    const bodies = new Set();
    const closeTasks = new Set();
    const completionPending = new Set();
    let completionClose;
    let finished = false;
    const abortCompletion = () => {
      completionClose ??= closeCompletionConnection();
      completionClose.catch(() => {});
    };
    signal.addEventListener('abort', abortCompletion, { once: true });
    const completionFence = () => {
      if (finished || signal.aborted || quarantined)
        throw new NativePackageWorkerError('native_package_worker_timeout');
    };
    const trackCompletion = (operation) => {
      const promise = Promise.resolve().then(async () => {
        completionFence();
        await guard();
        completionFence();
        const result = await operation();
        completionFence();
        return result;
      });
      completionPending.add(promise);
      promise.then(
        () => completionPending.delete(promise),
        () => completionPending.delete(promise),
      );
      return promise;
    };
    const finish = async ({ success = false } = {}) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abortCompletion);
      try {
        if (!success || signal.aborted) {
          abortCompletion();
          while (completionPending.size) await Promise.allSettled(completionPending);
          await completionClose;
        }
      } catch {
        quarantined = true;
        throw new NativePackageWorkerError('native_package_worker_cleanup');
      } finally {
        active = false;
      }
    };
    const fence = () => {
      if (closing || stopped.signal.aborted || signal.aborted)
        throw new NativePackageWorkerError('native_package_worker_timeout');
    };
    const track = (operation) => {
      const promise = Promise.resolve().then(operation);
      pending.add(promise);
      promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const trackClose = (promise) => {
      closeTasks.add(promise);
      promise.catch(() => {});
      return promise;
    };
    const closeConnection = () => {
      if (!connection) return Promise.resolve();
      connectionClose ??= Promise.resolve().then(() => connection.close());
      return connectionClose;
    };
    const abortResources = () => {
      stopped.abort();
      for (const body of bodies) trackClose(body.cancel());
      // Closing the socket also releases pending Gremlin requests. A connection
      // that opens late sees the stopped signal and closes before exposing g.
      if (connection) trackClose(closeConnection());
    };
    signal.addEventListener('abort', abortResources, { once: true });
    const drain = async () => {
      while (pending.size) await Promise.allSettled(pending);
    };
    const sdk = (client) => ({
      send: (command, options = {}) =>
        track(async () => {
          fence();
          await guard();
          fence();
          return client.send(command, {
            ...options,
            abortSignal: AbortSignal.any([
              signal,
              stopped.signal,
              ...(options.abortSignal ? [options.abortSignal] : []),
            ]),
          });
        }),
    });

    // Keep the abort signal active through response-body consumption, including
    // helper calls to response.json(). Never use an unbounded body collector.
    const boundedFetch = (url, init = {}) =>
      track(async () => {
        fence();
        await guard();
        fence();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), operationTimeoutMs);
        const requestSignal = AbortSignal.any([
          signal,
          stopped.signal,
          deadline.signal,
          ...(init.signal ? [init.signal] : []),
        ]);
        let response;
        try {
          response = await fetchImpl(url, { ...init, signal: requestSignal });
          if (requestSignal.aborted || response.redirected) {
            if (response.body) await response.body.cancel();
            fence();
            unavailable();
          }
          if (!response.body) {
            clearTimeout(timer);
            return response;
          }
          const reader = response.body.getReader();
          const limit =
            new Headers(init.headers).get('accept') === 'application/octet-stream'
              ? 256 * 1024 * 1024
              : 8 * 1024 * 1024;
          let count = 0;
          let completed = false;
          let cancelPromise;
          let streamController;
          const release = () => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            requestSignal.removeEventListener('abort', abort);
            bodies.delete(owner);
            reader.releaseLock();
          };
          const owner = {
            cancel: () => {
              cancelPromise ??= track(async () => {
                try {
                  await reader.cancel();
                } finally {
                  release();
                }
              });
              return cancelPromise;
            },
          };
          const abort = () => {
            streamController?.error(new NativePackageWorkerError('native_package_worker_timeout'));
            trackClose(owner.cancel());
          };
          bodies.add(owner);
          requestSignal.addEventListener('abort', abort, { once: true });
          const body = new ReadableStream({
            start(controller) {
              streamController = controller;
            },
            async pull(controller) {
              try {
                fence();
                if (requestSignal.aborted) unavailable();
                const next = await track(() => reader.read());
                fence();
                if (requestSignal.aborted) unavailable();
                if (next.done) {
                  release();
                  controller.close();
                  return;
                }
                if (!(next.value instanceof Uint8Array) || (count += next.value.byteLength) > limit)
                  unavailable();
                controller.enqueue(next.value);
              } catch {
                controller.error(new NativePackageWorkerError('native_package_worker_unavailable'));
                await owner.cancel();
              }
            },
            cancel: () => owner.cancel(),
          });
          const wrapped = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          Object.defineProperty(wrapped, 'url', { value: response.url });
          return wrapped;
        } catch (error) {
          clearTimeout(timer);
          throw error;
        }
      });

    const guardedDdb = sdk(ddb);
    const guardedSsm = sdk(ssm);
    const guardedSecrets = sdk(secrets);
    const getGraph = () => {
      graph ??= track(async () => {
        fence();
        await guard();
        connection = await openConnection();
        if (signal.aborted || stopped.signal.aborted || closing) {
          await closeConnection();
          fence();
        }
        // eslint-disable-next-line no-underscore-dangle -- Gremlin's named API adds request options.
        return traversal().withRemote(connection).with_('evaluationTimeout', operationTimeoutMs);
      });
      return graph;
    };
    const sources = sourceServiceFactory({
      ddb: guardedDdb,
      ssm: guardedSsm,
      secrets: guardedSecrets,
      getMembershipSnapshot: (projectId, actorId) =>
        track(async () => {
          fence();
          await guard();
          const result = await membershipSnapshot(await getGraph(), projectId, actorId);
          fence();
          return result;
        }),
    });
    const readCredential = (input) =>
      track(async () => {
        fence();
        await guard();
        let result;
        try {
          result = await resolveCredential({ ...input, fetchImpl: boundedFetch });
        } catch (error) {
          const code =
            error instanceof Error
              ? Object.getOwnPropertyDescriptor(error, 'code')?.value
              : undefined;
          if (
            [
              'CONNECTION_REQUIRED',
              'CONNECTION_CHANGED',
              'BINDING_INVALID',
              'MISSING_SCOPES',
              'APP_INSTALLATION_UNAVAILABLE',
            ].includes(code)
          ) {
            throw new WorkflowSourceError(
              'WORKFLOW_SOURCE_FORBIDDEN',
              'Native package source credentials no longer permit preparation',
            );
          }
          throw error;
        }
        fence();
        return result;
      });
    const scope = {
      projectId: job.projectId,
      sourceId: job.sourceId,
      actorId: job.actorId,
      expectedRevision: job.bindingRevision,
    };
    const authorizeCredentials = async () => {
      await guard();
      const before = await sources.getAuthorizedBinding(scope);
      await readCredential({
        ddb: guardedDdb,
        ssm: guardedSsm,
        secrets: guardedSecrets,
        binding: before,
        fetchImpl: boundedFetch,
      });
      await sources.getAuthorizedBinding(scope);
      await guard();
    };
    // This connection belongs to the warm host, not the attempt. All attempt
    // files, streams and sockets have closed before this fresh read. No close
    // is awaited between authorization and the job success CAS. Graph reads
    // and that DynamoDB CAS remain non-atomic under the accepted D18 model.
    const completionDdb = {
      send: (command) =>
        trackCompletion(() => {
          if (!(command instanceof GetCommand)) unavailable();
          return ddb.send(command, {
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(operationTimeoutMs)]),
          });
        }),
    };
    const completionSources = sourceServiceFactory({
      ddb: completionDdb,
      getMembershipSnapshot: (projectId, actorId) =>
        trackCompletion(async () => {
          completionConnection ??= { open: Promise.resolve().then(openCompletionConnection) };
          const completionSocket = await completionConnection.open;
          completionFence();
          const g = traversal()
            .withRemote(completionSocket)
            // eslint-disable-next-line no-underscore-dangle -- Gremlin's named API adds request options.
            .with_('evaluationTimeout', operationTimeoutMs);
          return membershipSnapshot(g, projectId, actorId);
        }),
    });
    const authorizeCompletion = async () => {
      if (!cleanupPromise) unavailable();
      await cleanupPromise;
      await guard();
      const binding = await completionSources.getAuthorizedBinding(scope);
      if (binding.authType?.endsWith('-oauth')) {
        const currentConnection = await getGitConnectionSnapshot(
          completionDdb,
          binding.connectionUserId,
          binding.provider,
        );
        let matches = false;
        try {
          matches =
            currentConnection?.status !== 'deleted' &&
            currentConnection?.userId === binding.connectionUserId &&
            currentConnection?.provider === binding.provider &&
            currentConnection?.createdAt === binding.connectionCreatedAt &&
            gitConnectionIdentity(currentConnection) === binding.connectionIdentity;
        } catch {
          // Invalid lifecycle metadata never grants completion authority.
        }
        if (!matches)
          throw new WorkflowSourceError(
            'WORKFLOW_SOURCE_FORBIDDEN',
            'Native package source connection has changed',
          );
        await completionSources.getAuthorizedBinding(scope);
      }
      await guard();
    };
    const cleanup = ({ authorizeCompletion: authorize = false } = {}) => {
      cleanupPromise ??= (async () => {
        let failure;
        try {
          for (const body of bodies) trackClose(body.cancel());
          await drain();
          if (root) await cleanupDirectory(root);
          if (authorize) {
            try {
              await authorizeCredentials();
            } catch (error) {
              if (error instanceof WorkflowSourceError) throw error;
              // An unavailable final authorization remains retryable without
              // misrepresenting a fully cleaned workspace as quarantined.
              throw new WorkflowSourceError(
                'WORKFLOW_SOURCE_UNAVAILABLE',
                'Native package source authorization is unavailable',
              );
            }
          }
        } catch (error) {
          failure = error;
        } finally {
          closing = true;
          abortResources();
          await drain();
          const closed = await Promise.allSettled([...closeTasks, closeConnection()]);
          signal.removeEventListener('abort', abortResources);
          if (closed.some((result) => result.status === 'rejected')) {
            failure = new NativePackageWorkerError('native_package_worker_cleanup');
          }
        }
        if (failure) {
          if (failure instanceof WorkflowSourceError) throw failure;
          quarantined = true;
          throw new NativePackageWorkerError('native_package_worker_cleanup');
        }
      })();
      return cleanupPromise;
    };
    try {
      await guard();
      const base = await realpath(tempDirectory);
      root = await mkdtemp(join(base, 'native-package-worker-'));
      const archive = wrapArchive(
        archiveFactory({
          s3: sdk(s3),
          bucket,
          expectedBucketOwner,
          workRoot: join(root, 'archive'),
          materialize: (input) =>
            track(async () => {
              fence();
              await guard();
              const loaded = await materialize(input);
              fence();
              return loaded;
            }),
          operationTimeoutMs,
        }),
      );
      const intake = intakeFactory({
        workflowSources: sources,
        ddb: guardedDdb,
        ssm: guardedSsm,
        secrets: guardedSecrets,
        cacheRoot: join(root, 'cache'),
        workRoot: join(root, 'intake'),
        materialize: (input) =>
          track(async () => {
            fence();
            await guard();
            const loaded = await materialize(input);
            fence();
            return loaded;
          }),
        resolveCredential: readCredential,
        fetchImpl: boundedFetch,
        archive,
      });
      return { intake, cleanup, authorizeCompletion, finish };
    } catch (error) {
      try {
        await cleanup();
      } finally {
        await finish();
      }
      throw error;
    }
  };
};

export const createNativePackageWorkerLambda = ({
  enabled = false,
  expectedQueueArn,
  tableName,
  bucket,
  expectedBucketOwner,
  ddb = defaultDdb,
  leaseMs = 150_000,
  maxAttempts = 3,
  attemptTimeoutMs = 120_000,
  cleanupReserveMs = 10_000,
  maxRecords = 10,
  jobsFactory = createNativePackageJobs,
  createAttempt,
  ...hostPorts
} = {}) => {
  if (enabled !== true) return async () => unavailable();
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= attemptTimeoutMs + cleanupReserveMs ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10
  )
    unavailable();
  const jobs = jobsFactory({ ddb, tableName, leaseMs, maxAttempts });
  const attempt =
    createAttempt ??
    createNativePackageAttemptFactory({
      ...hostPorts,
      ddb,
      bucket,
      expectedBucketOwner,
    });
  return createNativePackageWorker({
    jobs,
    expectedQueueArn,
    createAttempt: attempt,
    attemptTimeoutMs,
    cleanupReserveMs,
    maxRecords,
  });
};

const envInteger = (name, fallback) => {
  const text = process.env[name];
  if (text === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(text)) unavailable();
  const value = Number(text);
  if (!Number.isSafeInteger(value)) unavailable();
  return value;
};
let defaultHandler;
export const handler = async (event, context) => {
  if (process.env.NATIVE_PACKAGE_JOBS_ENABLED !== 'true') unavailable();
  defaultHandler ??= createNativePackageWorkerLambda({
    enabled: true,
    expectedQueueArn: process.env.NATIVE_PACKAGE_JOBS_QUEUE_ARN,
    tableName: process.env.NATIVE_PACKAGE_JOBS_TABLE,
    bucket: process.env.NATIVE_PACKAGES_BUCKET,
    expectedBucketOwner: process.env.NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER,
    attemptTimeoutMs: envInteger('NATIVE_PACKAGE_WORKER_BUDGET_MS', 120_000),
    leaseMs: envInteger('NATIVE_PACKAGE_WORKER_LEASE_MS', 150_000),
    cleanupReserveMs: envInteger('NATIVE_PACKAGE_WORKER_CLEANUP_RESERVE_MS', 10_000),
    operationTimeoutMs: envInteger('NATIVE_PACKAGE_WORKER_OPERATION_TIMEOUT_MS', 30_000),
    maxAttempts: envInteger('NATIVE_PACKAGE_WORKER_MAX_ATTEMPTS', 3),
  });
  return defaultHandler(event, context);
};
