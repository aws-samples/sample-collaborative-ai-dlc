import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile, unlink, rename, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';
import {
  nativeEngineArn,
  nativeEnginePin,
  nativeEngineFiles,
  engineDigest,
  engineFailure,
  encodeNativeEngineFiles,
  nativeEngineFileDigest,
} from '../../shared/native-workflow-protocol.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { snapshotNativeExecutionFiles } from './execution-files.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-project-files.js';

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const json = async (path, maximum = 256 * 1024) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw engineFailure();
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
};
const safeDirectory = async (path) => {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
    throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
};
const currentVersion = async (path) => {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      return {
        sha256: engineDigest(await handle.readFile()),
        mode: opened.mode & 0o100 ? '100755' : '100644',
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const applyPatches = async (project, patches) => {
  if (!Array.isArray(patches) || patches.length > 20_000) throw engineFailure();
  const files = nativeEngineFiles(patches.map((patch) => patch.after));
  const expected = new Map(patches.map((patch) => [patch.path, patch]));
  if (expected.size !== patches.length || files.some((file) => !expected.has(file.path)))
    throw engineFailure();
  for (const file of files) {
    let parent = project;
    await safeDirectory(parent);
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await safeDirectory(parent);
    }
    const path = join(project, file.path);
    const before = await currentVersion(path);
    if (before?.sha256 === file.sha256 && (!file.mode || before.mode === file.mode)) continue; // Replay after a lost local acknowledgement.
    const patch = expected.get(file.path);
    if (
      (before?.sha256 ?? null) !== patch.beforeSha256 ||
      (patch.beforeMode && before?.mode !== patch.beforeMode)
    )
      throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
    const temporary = join(parent, `.native-engine-${randomUUID()}`);
    try {
      await writeFile(temporary, file.content, {
        flag: 'wx',
        mode: file.mode === '100755' ? 0o700 : 0o600,
      });
      await safeDirectory(parent);
      if (!same(await currentVersion(path), before))
        throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
};
const localLock = async (directory) => {
  const path = join(directory, 'client.lock');
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await json(path, 1024);
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
      throw engineFailure('NATIVE_ENGINE_BUSY');
    try {
      process.kill(previous.pid, 0);
      throw engineFailure('NATIVE_ENGINE_BUSY');
    } catch (check) {
      if (check.code !== 'ESRCH') throw check;
    }
    // This releases only a dead local client lock. The backend operation is
    // still reconciled using the original request, never stolen or rerun.
    await unlink(path);
    await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  }
  return () => unlink(path);
};

const readGitBaseline = (context, s3) =>
  context.sourceBaseline?.receipt
    ? createNativePublications({ s3, bucket: context.bucket, accountId: context.accountId })
        .read(
          { ...context.identity, epoch: context.sourceBaseline.epoch },
          context.sourceBaseline.receipt,
        )
        .catch(() => null)
    : null;

export const createNativeEngineClient = ({
  context,
  lambda = new LambdaClient({}),
  s3 = new S3Client({}),
  forbiddenBytes = [],
  snapshot = snapshotNativeExecutionFiles,
  gitBaseline,
  signal,
}) => {
  const pin = nativeEnginePin(context.engine);
  const identity = context.identity;
  const directory = context.directory;
  if (
    context.schemaVersion !== 1 ||
    !context.project?.startsWith('/') ||
    resolve(context.project) !== context.project ||
    !directory?.startsWith('/') ||
    resolve(directory) !== directory
  )
    throw engineFailure();
  const objects = createNativeEngineObjects({
    s3,
    bucket: context.bucket,
    accountId: context.accountId,
  });
  const invoke = async (body) => {
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: nativeEngineArn(identity, pin),
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(body)),
      }),
      { abortSignal: signal },
    );
    if (response.FunctionError || !response.Payload || response.Payload.length > 1024 * 1024)
      throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
    const result = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
    if (result.ok !== true)
      throw engineFailure(
        /^NATIVE_[A-Z0-9_]+$/.test(result.code ?? '') ? result.code : 'NATIVE_ENGINE_UNAVAILABLE',
      );
    return result;
  };
  const accept = async (pending, observed) => {
    if (observed.status === 'pending') throw engineFailure('NATIVE_ENGINE_PENDING');
    if (
      !['completed', 'failed'].includes(observed.status) ||
      !Number.isSafeInteger(observed.version)
    )
      throw engineFailure('NATIVE_ENGINE_UNAVAILABLE');
    const result = await objects.read(identity, observed.result, 'output');
    const { configurationSha256: _configuration, ...returned } = result.identity ?? {};
    if (
      result.schemaVersion !== 1 ||
      result.requestId !== pending.requestId ||
      !same(returned, identity) ||
      !Number.isInteger(result.exitCode) ||
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string'
    )
      throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
    const received = join(directory, `${pending.requestId}.json`);
    try {
      await writeFile(received, JSON.stringify({ request: pending, observed }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // The immutable backend result stays retained even if current files no
    // longer accept its patch. A later command must submit those newer bytes.
    try {
      await applyPatches(context.project, result.patches);
    } finally {
      await unlink(join(directory, 'pending.json'));
    }
    return { ...result, version: observed.version };
  };
  const pendingPath = join(directory, 'pending.json');
  const readPending = () =>
    json(pendingPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
  const submit = async (request) => {
    try {
      return await accept(request, await invoke(request));
    } catch (error) {
      // Only the service can retire this exact request. Surface its refusal
      // to this caller; a later CLI invocation can submit a new command.
      if (['NATIVE_ENGINE_ABANDONED', 'NATIVE_ENGINE_PUBLICATION_ABANDONED'].includes(error.code))
        await unlink(pendingPath);
      throw error;
    }
  };
  const recoverOperation = async (args) => {
    const [verb, serialized, original] = args;
    const envelope = { schemaVersion: 1, identity };
    let response;
    if (verb === 'pending' && args.length === 1) {
      response = (await invoke({ ...envelope, action: 'pending' })).operation;
    } else {
      if (verb !== 'abandon' || ![2, 3].includes(args.length)) throw engineFailure();
      let operation;
      let originalRequest;
      try {
        operation = JSON.parse(serialized);
        if (original !== undefined) originalRequest = JSON.parse(original);
      } catch {
        throw engineFailure();
      }
      const request = { ...envelope, action: 'abandon', operation };
      try {
        response = await invoke(originalRequest ? { ...request, originalRequest } : request);
      } catch (error) {
        if (error.code !== 'NATIVE_ENGINE_ORIGINAL_REQUEST_REQUIRED' || original !== undefined)
          throw error;
        // Only a legacy operation without identifying output needs its accepted
        // envelope. The service verifies the digest and never invokes it.
        if (![operation?.sequence, operation?.writerGeneration].every(Number.isSafeInteger))
          throw error;
        const ownerDirectory = resolve(
          directory,
          '../..',
          `writer-${operation.writerGeneration}`,
          `turn-${operation.sequence}`,
        );
        try {
          await safeDirectory(ownerDirectory);
          originalRequest = await json(join(ownerDirectory, 'pending.json'));
        } catch (readError) {
          if (readError.code === 'ENOENT') throw error;
          throw readError;
        }
        response = await invoke({ ...request, originalRequest });
      }
      if (
        response.status !== 'abandoned' ||
        response.requestId !== operation?.requestId ||
        response.version !== operation.expectedVersion + 1
      )
        throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
      // A live client may still be waiting for the late invocation. It owns
      // pending.json until it receives the journal refusal and releases its lock.
      const release = await localLock(directory).catch((error) => {
        if (error.code !== 'NATIVE_ENGINE_BUSY') throw error;
        return null;
      });
      if (release) {
        try {
          const retained = await readPending();
          if (
            retained?.requestId === operation.requestId &&
            same(retained.identity, identity) &&
            retained.expectedVersion === operation.expectedVersion
          )
            await unlink(pendingPath);
        } finally {
          await release();
        }
      }
    }
    return { exitCode: 0, stdout: `${JSON.stringify(response)}\n`, stderr: '' };
  };
  return {
    async command(
      args = [],
      { action = 'execute', publication, interaction, expectedVersion, guard } = {},
    ) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await safeDirectory(directory);
      if (action === 'execute' && args[0] === 'engine' && args[1] === 'operation')
        return recoverOperation(args.slice(2));
      const release = await localLock(directory);
      try {
        const pending = await readPending();
        if (pending) {
          if (!same(pending.identity, identity))
            throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
          const reconciled = await submit(pending);
          if (
            action !== 'guard' &&
            pending.action === action &&
            same(pending.args ?? [], args) &&
            (action !== 'finalize' ||
              (pending.publication.id === publication?.id &&
                pending.interaction?.id === interaction?.id &&
                (expectedVersion === undefined || pending.expectedVersion === expectedVersion)))
          )
            return reconciled;
        }
        const status = await invoke({ schemaVersion: 1, identity, action: 'status' });
        if (status.pending) throw engineFailure('NATIVE_ENGINE_PENDING');
        // The publisher rendered the offer at the mirrored version. Even a
        // new offer with identical labels can name a different engine request.
        if (expectedVersion !== undefined && expectedVersion !== status.version)
          throw engineFailure('NATIVE_ENGINE_HEAD_CHANGED');
        const requestId = randomUUID();
        let input;
        if (action !== 'finalize') {
          const files = await snapshot({
            gitBaseline: gitBaseline ?? (await readGitBaseline(context, s3)),
            project: context.project,
            forbiddenBytes,
            signal,
            filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
          });
          if (
            guard &&
            forbiddenBytes.some((secret) =>
              [guard.content, guard.command, guard.path].some(
                (value) => typeof value === 'string' && Buffer.from(value).includes(secret),
              ),
            )
          )
            throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
          input = await objects.write(
            identity,
            requestId,
            'files',
            {
              schemaVersion: 1,
              ...(action === 'guard' ? { guard } : {}),
              files: encodeNativeEngineFiles(
                files.git
                  ? files.files
                  : files.files.map(({ path, content }) => ({ path, content })),
              ),
              ...(files.git ? { sourceBaseline: context.sourceBaseline, git: files.git } : {}),
              filesSha256: nativeEngineFileDigest(files.files),
            },
            'input',
          );
        }
        const request = {
          schemaVersion: 1,
          identity,
          action,
          requestId,
          expectedVersion: status.version,
          ...(input ? { input, args } : { publication, interaction }),
        };
        await writeFile(join(directory, 'pending.json'), JSON.stringify(request), {
          flag: 'wx',
          mode: 0o600,
        });
        return await submit(request);
      } finally {
        await release();
      }
    },
  };
};

export const prepareNativeEngineClient = async ({
  payload,
  sourceBaseline,
  env,
  project,
  control,
  forbiddenBytes,
  s3 = new S3Client({}),
  lambda,
  signal,
}) => {
  if (!payload.configuration.workflowEngine) return null;
  const { projectId, executionId, bindingId, attemptId, epoch, writerGeneration } = payload;
  const sequence = payload.command === 'native-start' ? 1 : payload.sequence;
  const identity = {
    projectId,
    executionId,
    bindingId,
    attemptId,
    epoch,
    writerGeneration,
    sequence,
  };
  const directory = join(
    control,
    'workflow-engine',
    `writer-${writerGeneration}`,
    `turn-${sequence}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await safeDirectory(directory);
  const context = {
    schemaVersion: 1,
    identity,
    ...(sourceBaseline?.receipt ? { sourceBaseline } : {}),
    directory,
    project,
    engine: payload.configuration.workflowEngine,
    accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
    bucket: env.NATIVE_PUBLICATION_BUCKET,
  };
  const path = join(directory, 'context.json');
  try {
    await writeFile(path, JSON.stringify(context), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!same(await json(path), context)) throw engineFailure('NATIVE_ENGINE_CONFIGURATION_CHANGED');
  const gitBaseline = await readGitBaseline(context, s3);
  const client = createNativeEngineClient({
    context,
    forbiddenBytes,
    s3,
    lambda,
    signal,
    gitBaseline,
  });
  if (payload.command === 'native-start' && sourceBaseline) {
    // Seal the preparer's source, including an unavailable capture, before coding starts.
    const mirrored = await client.command([], { action: 'mirror' });
    if (mirrored.exitCode !== 0) throw engineFailure('NATIVE_ENGINE_SOURCE_MISMATCH');
  }
  return { client, contextPath: path };
};

export const nativeEngineContext = (path) => json(path);
