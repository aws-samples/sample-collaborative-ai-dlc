// Fixed CodeBuild entry. This process and project/reviewer children have only
// their job's capabilities. They never receive private engine snapshots,
// signing material, authority-table permissions, or engine invocation grants.
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
  chown,
  chmod,
  readdir,
} from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { inspectNativeRuntimeArchive } from '../../shared/native-runtime-package.js';
import { nativeGitDeltaSha256 } from '../../shared/native-git-change-set.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  NATIVE_ENGINE_PROFILE,
  engineFailure,
  engineDigest,
} from '../../shared/native-workflow-protocol.js';
import {
  nativeEngineJob,
  nativeEngineJobResult,
  NATIVE_ENGINE_JOB_ROOT,
} from '../../shared/native-workflow-job.js';
import { runNativeCommand } from './command-runner.js';
import { nativeExecutionInvocation } from './executor.js';
import { prepareNativeTransportInstructions } from './transport-instructions.js';
import { createNativeTurnOutput } from './turn-output.js';
import { getDriver } from '../cli/drivers.js';

const root = NATIVE_ENGINE_JOB_ROOT;
const project = join(root, 'project');
const home = join(root, 'home');
const workerUid = 1000;
const workerGid = 1000;
const requireObserver = async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw engineFailure('NATIVE_ENGINE_JOB_OBSERVER_INVALID');
  const status = await readFile('/proc/self/status', 'utf8');
  const effective = status
    .split('\n')
    .find((line) => line.startsWith('CapEff:'))
    ?.split(':')[1]
    .trim();
  // CAP_CHOWN, CAP_SETGID, CAP_SETUID and CAP_SETPCAP. setpriv cannot
  // reliably empty the bounding set when SETPCAP is unavailable.
  const required = 1n | (1n << 6n) | (1n << 7n) | (1n << 8n);
  if (!/^[a-f0-9]+$/.test(effective ?? '') || (BigInt(`0x${effective}`) & required) !== required)
    throw engineFailure('NATIVE_ENGINE_JOB_OBSERVER_INVALID');
};
const decode = (bytes) => JSON.parse(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }));
const workerDirectory = async (path) => {
  await mkdir(path, { mode: 0o755 });
  await chown(path, workerUid, workerGid);
};
const handOverInstructions = async (path) => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
    throw engineFailure('NATIVE_ENGINE_JOB_INPUT_INVALID');
  if (stat.isDirectory())
    for (const name of await readdir(path)) await handOverInstructions(join(path, name));
  await chown(path, workerUid, workerGid);
};
const storeFiles = async (directory, files, worker = false) => {
  for (const file of files) {
    const path = join(directory, file.path);
    let parent = directory;
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      try {
        await mkdir(parent, { mode: 0o755 });
        if (worker) await chown(parent, workerUid, workerGid);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (worker && stat.uid !== workerUid))
          throw engineFailure('NATIVE_ENGINE_JOB_INPUT_INVALID');
      }
    }
    await writeFile(path, file.content, {
      flag: 'wx',
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
    if (worker) await chown(path, workerUid, workerGid);
  }
};
// Re-observe the root-owned trees and the exact instructions' change list.
// A directory may replace a deleted file, or a file may replace its ancestor.
const reviewedVersion = async (directory, path) => {
  try {
    const filename = join(directory, path);
    const stat = await lstat(filename);
    if (stat.isDirectory()) return null;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.size > 16 * 1024 * 1024)
      throw engineFailure('NATIVE_ENGINE_JOB_INPUT_INVALID');
    const content = await readFile(filename);
    return {
      mode: stat.mode & 0o100 ? '100755' : '100644',
      bytes: content.length,
      sha256: engineDigest(content),
    };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
};
const reviewedGitSha256 = async () => {
  const delta = JSON.parse(await readFile(join(root, 'git-changes.json'), 'utf8'));
  for (const change of delta.changes) {
    change.before = await reviewedVersion(join(root, 'before'), change.path);
    change.after = await reviewedVersion(project, change.path);
  }
  return nativeGitDeltaSha256(delta);
};
const isolatedInvocation = (input) => ({
  ...input,
  command: '/usr/bin/setpriv',
  args: [
    `--reuid=${workerUid}`,
    `--regid=${workerGid}`,
    '--clear-groups',
    '--no-new-privs',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--',
    input.command,
    ...input.args,
  ],
});
const boundedBody = async (response, maximum) => {
  if (!response.ok || !response.body) throw engineFailure('NATIVE_ENGINE_JOB_TRANSFER_FAILED');
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > maximum) {
      await response.body.cancel().catch(() => {});
      throw engineFailure('NATIVE_ENGINE_JOB_TRANSFER_FAILED');
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
};
const baseEnv = () => ({
  HOME: home,
  TMPDIR: join(root, 'tmp'),
  PATH: '/usr/local/bin:/opt/bun/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'),
  XDG_CACHE_HOME: join(home, '.cache'),
  AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'protocol.allow',
  GIT_CONFIG_VALUE_2: 'never',
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  DO_NOT_TRACK: '1',
});
const executable = async (command) => {
  if (isAbsolute(command)) return command;
  if (!/^[a-zA-Z0-9_.+-]+$/.test(command)) throw engineFailure('NATIVE_ENGINE_JOB_COMMAND_INVALID');
  for (const directory of ['/usr/local/bin', '/opt/bun/bin', '/usr/bin', '/bin']) {
    const candidate = join(directory, command);
    try {
      if ((await lstat(candidate)).isFile() || (await lstat(candidate)).isSymbolicLink())
        return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw engineFailure('NATIVE_ENGINE_JOB_COMMAND_UNAVAILABLE');
};
const readReview = async (path, secret) => {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    throw engineFailure('NATIVE_ENGINE_REVIEW_INVALID');
  const bytes = await readFile(path);
  if (bytes.length !== stat.size || bytes.includes(Buffer.from(secret)))
    throw engineFailure('NATIVE_ENGINE_REVIEW_INVALID');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

export const createNativeEngineJobRunner = ({
  run = runNativeCommand,
  lambda = new LambdaClient({}),
  fetcher = fetch,
} = {}) => ({
  async prepare(env = process.env) {
    await requireObserver();
    if (!/^[a-f0-9]{64}$/.test(env.NATIVE_WORKFLOW_JOB_INPUT_SHA256 ?? ''))
      throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
    const response = await fetcher(env.NATIVE_WORKFLOW_JOB_INPUT, {
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = await boundedBody(response, 128 * 1024 * 1024);
    if (engineDigest(bytes) !== env.NATIVE_WORKFLOW_JOB_INPUT_SHA256)
      throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
    const source = decode(bytes);
    const job = nativeEngineJob(source);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { mode: 0o711 });
    // The CodeBuild observer keeps its own UID. Neither project code nor a
    // reviewer can read its environment/input/receipt or signal its processes.
    // Sticky project ownership also prevents replacing the root-owned sensors.
    await mkdir(project, { mode: 0o1777 });
    await chmod(project, 0o1777);
    // The home stays private to the observer until `run` has written a
    // reviewer's instruction transport into it; only then is it handed over.
    await mkdir(home, { mode: 0o700 });
    for (const path of [join(root, 'tmp'), join(root, 'review-output')])
      await workerDirectory(path);
    await writeFile(join(root, 'input.json.gz'), bytes, { flag: 'wx', mode: 0o600 });
    if (job.kind === 'check' && job.command.pinnedTool) {
      const archive = Buffer.from(job.archive ?? '', 'base64');
      if (engineDigest(archive) !== NATIVE_ENGINE_PROFILE.runtimeSha256)
        throw engineFailure('NATIVE_ENGINE_JOB_INVALID');
      const inspected = await inspectNativeRuntimeArchive(archive, {
        version: NATIVE_ENGINE_PROFILE.version,
        retainPrefix: `runtime/${job.harness}/`,
      });
      await storeFiles(
        project,
        [...inspected.retainedFiles]
          .filter(([path]) =>
            path.startsWith(
              `${{ claude: '.claude', codex: '.codex', opencode: '.aidlc' }[job.harness]}/`,
            ),
          )
          .map(([path, content]) => ({ path, content })),
      );
    }
    // Native public input excludes harness roots. An overlap is refused by wx;
    // a project cannot replace a pinned sensor entry before it is invoked.
    // Both trees of a Git review are root-owned throughout the isolated invocation.
    if (job.gitDelta) await chmod(project, 0o755);
    await storeFiles(project, job.files, !job.gitDelta);
    if (job.gitDelta) {
      const before = join(root, 'before');
      await mkdir(before, { mode: 0o755 });
      await storeFiles(before, job.beforeFiles);
      await writeFile(join(root, 'git-changes.json'), canonicalJson(job.gitDelta), {
        flag: 'wx',
        mode: 0o644,
      });
    }
    await writeFile(
      join(root, 'sensor.bunfig.toml'),
      'env = false\n[install]\nauto = "disable"\n',
      { flag: 'wx', mode: 0o644 },
    );
    await writeFile(join(root, 'sensor.tsconfig.json'), '{}', { flag: 'wx', mode: 0o644 });
    return { jobId: job.jobId, filesSha256: job.filesSha256 };
  },
  async run() {
    await requireObserver();
    const job = nativeEngineJob(decode(await readFile(join(root, 'input.json.gz'))));
    let result;
    if (job.kind === 'check') {
      const command = job.command;
      if (
        resolve(command.cwd) !== command.cwd ||
        (command.cwd !== project && !command.cwd.startsWith(`${project}/`))
      )
        throw engineFailure('NATIVE_ENGINE_JOB_COMMAND_INVALID');
      let args = command.args;
      if (command.pinnedTool) {
        const installation = { claude: '.claude', codex: '.codex', opencode: '.aidlc' }[
          job.harness
        ];
        const tool = join(project, installation, command.pinnedTool);
        if (command.command !== '/opt/bun/bin/bun' || command.args[0] !== tool)
          throw engineFailure('NATIVE_ENGINE_JOB_COMMAND_INVALID');
        args = [
          '--no-env-file',
          `--config=${join(root, 'sensor.bunfig.toml')}`,
          `--tsconfig-override=${join(root, 'sensor.tsconfig.json')}`,
          '--no-install',
          ...args,
        ];
      }
      await handOverInstructions(home);
      result = await run(
        isolatedInvocation({
          command: await executable(command.command),
          args,
          cwd: command.cwd,
          env: { ...baseEnv(), AIDLC_PROJECT_DIR: project, AIDLC_OFFLINE: '1' },
          ...(command.input === null ? {} : { stdin: Buffer.from(command.input, 'base64') }),
          timeoutMs: command.timeoutMs,
          stdoutBytes: 3 * 1024 * 1024,
          stderrBytes: 1024 * 1024,
        }),
      );
    } else {
      const response = await lambda.send(
        new InvokeCommand({
          FunctionName: job.credentialAlias,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(job.credentialScope)),
        }),
        { abortSignal: AbortSignal.timeout(20_000) },
      );
      if (response.FunctionError || !response.Payload || response.Payload.length > 128 * 1024)
        throw engineFailure('NATIVE_ENGINE_REVIEW_CREDENTIAL_UNAVAILABLE');
      const credential = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
      if (
        !credential.ok ||
        !credential.model?.value ||
        credential.git ||
        credential.projectId !== job.credentialScope.projectId ||
        credential.executionId !== job.credentialScope.executionId ||
        credential.attemptId !== job.credentialScope.attemptId ||
        credential.epoch !== job.credentialScope.epoch
      )
        throw engineFailure('NATIVE_ENGINE_REVIEW_CREDENTIAL_UNAVAILABLE');
      const secret = credential.model.value;
      const cwd = join(root, 'reviewer');
      await workerDirectory(cwd);
      const env = {
        ...baseEnv(),
        ...getDriver(job.harness).envForAuth({
          ...baseEnv(),
          AWS_BEARER_TOKEN_BEDROCK: secret,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          OPENCODE_XDG_DATA_HOME: join(home, '.local/share'),
        }),
      };
      const transport = await prepareNativeTransportInstructions({
        harness: job.harness,
        project: cwd,
        home,
        instructions: job.instructions,
        env,
      });
      await handOverInstructions(cwd);
      await handOverInstructions(home);
      const output = createNativeTurnOutput({ harness: job.harness, forbiddenBytes: [secret] });
      const invocation = nativeExecutionInvocation({
        harness: job.harness,
        model: job.model,
        prompt: job.prompt,
        project: cwd,
        ...transport.invocation,
      });
      result = await run(
        isolatedInvocation({
          ...invocation,
          cwd,
          env: transport.env,
          timeoutMs: 540_000,
          stdoutBytes: 1024 * 1024,
          stderrBytes: 1024 * 1024,
          onStdoutChunk: (chunk) => output.write(chunk),
        }),
      );
      if (result.exitCode === 0 && result.cleanupComplete && !result.timedOut) {
        const completed = output.finish();
        const review = await readReview(join(root, 'review-output/review.md'), secret);
        result = {
          ...result,
          stdout: completed.messages.map((message) => message.text).join('\n'),
          // CLI diagnostics may contain credentials even on success. They do
          // not participate in review evidence; never upload them.
          stderr: '',
          nativeSessionId: completed.nativeSessionId,
          review,
          reviewSha256: engineDigest(review),
        };
      } else result = { ...result, stdout: '', stderr: '' };
    }
    const value = nativeEngineJobResult(
      {
        schemaVersion: 1,
        kind: job.kind,
        jobId: job.jobId,
        filesSha256: job.filesSha256,
        producerSha256: job.producerSha256,
        exitCode: result.exitCode ?? 125,
        timedOut: result.timedOut,
        cleanupComplete: result.cleanupComplete,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.review
          ? {
              ...(job.gitDelta ? { gitSha256: await reviewedGitSha256() } : {}),
              review: result.review,
              reviewSha256: result.reviewSha256,
              nativeSessionId: result.nativeSessionId,
            }
          : {}),
      },
      job,
    );
    await writeFile(join(root, 'result.json.gz'), gzipSync(Buffer.from(canonicalJson(value))), {
      flag: 'wx',
      mode: 0o600,
    });
    return value;
  },
  async publish(env = process.env) {
    await requireObserver();
    const body = await readFile(join(root, 'result.json.gz'));
    if (body.length > 8 * 1024 * 1024) throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
    const response = await fetcher(env.NATIVE_WORKFLOW_JOB_OUTPUT, {
      method: 'PUT',
      body,
      redirect: 'error',
      headers: { 'content-type': 'application/gzip', 'x-amz-server-side-encryption': 'AES256' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw engineFailure('NATIVE_ENGINE_JOB_TRANSFER_FAILED');
  },
});

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv[2];
  try {
    if (!['prepare', 'run', 'publish'].includes(mode)) throw engineFailure();
    const result = await createNativeEngineJobRunner()[mode]();
    // A failing check keeps a failing CodeBuild BUILD phase. POST_BUILD still
    // publishes its bounded observation, including failure and timeout.
    if (mode === 'run' && (result.exitCode !== 0 || result.timedOut || !result.cleanupComplete))
      process.exitCode = 1;
  } catch {
    // Do not print presigned URLs, source bytes, CLI output or credentials.
    process.stderr.write('Native workflow job could not produce verified evidence.\n');
    process.exitCode = 1;
  }
}
