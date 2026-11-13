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
const currentDigest = async (path) => {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return engineDigest(await handle.readFile());
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
  const expected = new Map(patches.map((patch) => [patch.path, patch.beforeSha256]));
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
    const before = await currentDigest(path);
    if (before === file.sha256) continue; // Replay after a lost local acknowledgement.
    if (before !== expected.get(file.path)) throw engineFailure('NATIVE_ENGINE_WORKSPACE_CHANGED');
    const temporary = join(parent, `.native-engine-${randomUUID()}`);
    try {
      await writeFile(temporary, file.content, { flag: 'wx', mode: 0o600 });
      await safeDirectory(parent);
      if ((await currentDigest(path)) !== before)
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

export const createNativeEngineClient = ({
  context,
  lambda = new LambdaClient({}),
  s3 = new S3Client({}),
  forbiddenBytes = [],
  snapshot = snapshotNativeExecutionFiles,
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
    return result;
  };
  return {
    async command(args = [], { action = 'execute', publication, interaction } = {}) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await safeDirectory(directory);
      const release = await localLock(directory);
      try {
        let pending;
        try {
          pending = await json(join(directory, 'pending.json'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (pending) {
          if (!same(pending.identity, identity))
            throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
          const reconciled = await accept(pending, await invoke(pending));
          if (
            pending.action === action &&
            same(pending.args ?? [], args) &&
            (action !== 'finalize' || pending.publication.id === publication?.id)
          )
            return reconciled;
        }
        const status = await invoke({ schemaVersion: 1, identity, action: 'status' });
        if (status.pending) throw engineFailure('NATIVE_ENGINE_PENDING');
        const requestId = randomUUID();
        let input;
        if (action !== 'finalize') {
          const files = await snapshot({
            project: context.project,
            forbiddenBytes,
            signal,
            filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
          });
          input = await objects.write(
            identity,
            requestId,
            'files',
            {
              schemaVersion: 1,
              files: encodeNativeEngineFiles(files.files),
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
        return await accept(request, await invoke(request));
      } finally {
        await release();
      }
    },
  };
};

export const prepareNativeEngineClient = async ({
  payload,
  env,
  project,
  control,
  forbiddenBytes,
  s3,
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
  const client = createNativeEngineClient({ context, forbiddenBytes, s3, lambda, signal });
  return { client, contextPath: path };
};

export const nativeEngineContext = (path) => json(path);
