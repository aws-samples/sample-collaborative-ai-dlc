import { spawn } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineDigest, engineFailure } from './package.js';
import { canonicalNativePath } from '../../shared/native-project-files.js';

const PORT_LIMIT = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const ADAPTER = dirname(fileURLToPath(import.meta.url));
const CHILD_ENV = new Set([
  'AIDLC_PROJECT_DIR',
  'AIDLC_SESSION_ID',
  'AIDLC_SESSION_BINDING_ID',
  'AIDLC_STATE_TRANSITION_OWNER',
  'AIDLC_AUDIT_LOCK_OWNER',
  'AIDLC_INTERNAL_HUMAN_TURN_TOKEN',
]);
const ISOLATED_SENSORS = new Set(['aidlc-sensor-linter.ts', 'aidlc-sensor-type-check.ts']);
const sensorReceipt = (request, entry, engine, project) => {
  if (!request.env.NATIVE_ENGINE_SENSOR_RECEIPT) return null;
  if (relative(engine.installation, entry) !== 'tools/aidlc-sensor.ts')
    throw engineFailure('NATIVE_ENGINE_SENSOR_INVALID');
  let value;
  try {
    value = JSON.parse(request.env.NATIVE_ENGINE_SENSOR_RECEIPT);
  } catch {
    throw engineFailure('NATIVE_ENGINE_SENSOR_INVALID');
  }
  if (
    Object.keys(value).toSorted().join(',') !== 'fireId,outputPath,sensor,stage,unit' ||
    !/^[a-f0-9]{8}$/.test(value.fireId ?? '') ||
    !/^[a-z][a-z0-9-]{0,127}$/.test(value.stage ?? '') ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.sensor ?? '') ||
    !(value.unit === null || /^[a-zA-Z0-9_-]{1,128}$/.test(value.unit)) ||
    typeof value.outputPath !== 'string'
  )
    throw engineFailure('NATIVE_ENGINE_SENSOR_INVALID');
  const path = relative(project, value.outputPath);
  if (!canonicalNativePath(path)) throw engineFailure('NATIVE_ENGINE_SENSOR_INVALID');
  return { ...value, outputPath: path };
};
const plain = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const argument = (value) =>
  typeof value === 'string' && !value.includes('\0') && value.length <= 65536;
const reply = (value) => ({
  ...value,
  stdout: Buffer.from(value.stdout ?? '').toString('base64'),
  stderr: Buffer.from(value.stderr ?? '').toString('base64'),
});
const untilAbort = (work, signal) =>
  new Promise((resolve, reject) => {
    const abort = () => reject(engineFailure('NATIVE_ENGINE_CANCELLED'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });

// The only external-process port belongs to the host. Its implementation must
// put project commands/reviewers in a separate service without engine authority.
// There is deliberately no fallback to a local shell on refusal or failure.
export const createNativeEngineRunner = async ({
  project,
  home,
  engine,
  bun = '/opt/bun/bin/bun',
  external,
  signal,
  sessionId,
  timeoutMs = 840_000,
  inspectCheck,
}) => {
  if (
    !isAbsolute(project) ||
    !isAbsolute(home) ||
    (await realpath(project)) !== project ||
    (await realpath(home)) !== home ||
    !(signal instanceof AbortSignal) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 840_000
  )
    throw engineFailure();
  const modules = { ...engine.modules };
  for (const name of ['preload.mjs', 'process-port.mjs', 'observe.mjs', 'member.mjs']) {
    const path = join(ADAPTER, name);
    modules[path] = engineDigest(await readFile(path));
  }
  const moduleManifest = join(home, 'modules.json');
  await writeFile(moduleManifest, JSON.stringify(modules), { flag: 'wx', mode: 0o600 });
  const bunConfig = join(home, 'engine.bunfig.toml');
  const tsConfig = join(home, 'engine.tsconfig.json');
  await writeFile(bunConfig, 'env = false\n[install]\nauto = "disable"\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(tsConfig, '{}', { flag: 'wx', mode: 0o600 });
  const cancellation = new AbortController();
  const runSignal = AbortSignal.any([signal, cancellation.signal]);
  const baseEnv = {
    HOME: home,
    TMPDIR: home,
    PATH: `${dirname(bun)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    AIDLC_PROJECT_DIR: project,
    AIDLC_OFFLINE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'protocol.allow',
    GIT_CONFIG_VALUE_1: 'never',
    GIT_CONFIG_KEY_2: 'credential.helper',
    GIT_CONFIG_VALUE_2: '',
    NATIVE_ENGINE_MODULES: moduleManifest,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    ...(sessionId ? { AIDLC_SESSION_ID: sessionId } : {}),
  };
  const deadline = Date.now() + timeoutMs;
  const observations = [];
  const refusals = [];
  let processCount = 0;
  const trustedEntry = (path) => {
    const name = relative(engine.installation, path);
    return (
      Object.hasOwn(modules, path) &&
      !isAbsolute(name) &&
      /^(?:tools|hooks)\/[a-z0-9-]+\.ts$/.test(name)
    );
  };
  const execute = async (entry, args, input = null, carried = {}, depth = 0) => {
    if (
      runSignal.aborted ||
      Date.now() >= deadline ||
      depth > 12 ||
      ++processCount > 128 ||
      !(
        trustedEntry(entry) ||
        ['observe.mjs', 'member.mjs'].some((name) => entry === join(ADAPTER, name))
      ) ||
      !Array.isArray(args) ||
      args.length > 128 ||
      !args.every(argument)
    )
      throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
    return new Promise((resolve, reject) => {
      const child = spawn(
        bun,
        [
          '--no-env-file',
          `--config=${bunConfig}`,
          `--tsconfig-override=${tsConfig}`,
          '--no-install',
          '--preload',
          join(ADAPTER, 'preload.mjs'),
          entry,
          ...args,
        ],
        {
          cwd: project,
          env: { ...baseEnv, ...carried },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        },
      );
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let buffer = Buffer.alloc(0);
      let processing = Promise.resolve();
      let failure;
      let lastId = 0;
      const stop = (error) => {
        failure ??= error;
        cancellation.abort(error);
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (killError) {
            if (killError.code !== 'ESRCH') failure = engineFailure('NATIVE_ENGINE_CLEANUP_FAILED');
          }
        }
      };
      const aborted = () => stop(engineFailure('NATIVE_ENGINE_CANCELLED'));
      runSignal.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(
        () => stop(engineFailure('NATIVE_ENGINE_TIMEOUT')),
        Math.max(1, deadline - Date.now()),
      );
      const collect = (target, chunk) => {
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) stop(engineFailure('NATIVE_ENGINE_OUTPUT_LIMIT'));
        else target.push(chunk);
      };
      child.stdout.on('data', (chunk) => collect(stdout, chunk));
      child.stderr.on('data', (chunk) => collect(stderr, chunk));
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') stop(error);
      });
      child.stdio[3].on('error', stop);
      child.stdio[3].on('data', (chunk) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > PORT_LIMIT + 4) throw engineFailure('NATIVE_ENGINE_PORT_LIMIT');
          while (buffer.length >= 4) {
            const length = buffer.readUInt32BE();
            if (!length || length > PORT_LIMIT) throw engineFailure('NATIVE_ENGINE_PORT_LIMIT');
            if (buffer.length < length + 4) break;
            const request = JSON.parse(buffer.subarray(4, length + 4));
            buffer = buffer.subarray(length + 4);
            if (
              !plain(request) ||
              request.id !== ++lastId ||
              request.kind !== 'process' ||
              !argument(request.command) ||
              !Array.isArray(request.args) ||
              request.args.length > 128 ||
              !request.args.every(argument) ||
              !argument(request.cwd) ||
              !plain(request.env) ||
              request.shell !== false ||
              !(
                request.timeoutMs === null ||
                (Number.isSafeInteger(request.timeoutMs) &&
                  request.timeoutMs > 0 &&
                  request.timeoutMs <= 840_000)
              ) ||
              !(request.input === null || typeof request.input === 'string')
            )
              throw engineFailure('NATIVE_ENGINE_PORT_INVALID');
            processing = processing
              .then(async () => {
                let value;
                try {
                  const sensor = sensorReceipt(request, entry, engine, project);
                  const inspected = sensor && inspectCheck ? await inspectCheck(sensor) : null;
                  if (
                    request.command === bun &&
                    trustedEntry(request.args[0]) &&
                    !ISOLATED_SENSORS.has(basename(request.args[0]))
                  ) {
                    const childEnv = Object.fromEntries(
                      Object.entries(request.env).filter(
                        ([key, value]) => CHILD_ENV.has(key) && argument(value),
                      ),
                    );
                    value = await execute(
                      request.args[0],
                      request.args.slice(1),
                      request.input,
                      childEnv,
                      depth + 1,
                    );
                  } else {
                    if (!external) throw engineFailure('NATIVE_ENGINE_CAPABILITY_UNAVAILABLE');
                    value = await untilAbort(
                      external({
                        command: request.command,
                        args: request.args,
                        cwd: request.cwd,
                        input: request.input === null ? null : Buffer.from(request.input, 'base64'),
                        origin: relative(engine.installation, entry),
                        signal: runSignal,
                        deadline,
                        timeoutMs: request.timeoutMs,
                        ...(request.command === bun &&
                        trustedEntry(request.args[0]) &&
                        ISOLATED_SENSORS.has(basename(request.args[0]))
                          ? { pinnedTool: relative(engine.installation, request.args[0]) }
                          : {}),
                      }),
                      runSignal,
                    );
                    if (
                      !plain(value) ||
                      !Number.isInteger(value.exitCode) ||
                      value.exitCode < 0 ||
                      value.exitCode > 255
                    )
                      throw engineFailure('NATIVE_ENGINE_CAPABILITY_INVALID');
                  }
                  observations.push({
                    origin: relative(engine.installation, entry),
                    command: basename(request.command),
                    exitCode: value.exitCode,
                    ...(sensor
                      ? {
                          observation: {
                            kind: 'check',
                            invocation: 'protected-engine',
                            ...value.observation,
                            ...sensor,
                            ...inspected,
                          },
                        }
                      : value.observation
                        ? { observation: value.observation }
                        : {}),
                  });
                  const body = Buffer.from(JSON.stringify({ id: request.id, value: reply(value) }));
                  if (body.length > PORT_LIMIT) throw engineFailure('NATIVE_ENGINE_PORT_LIMIT');
                  const header = Buffer.alloc(4);
                  header.writeUInt32BE(body.length);
                  child.stdio[3].write(Buffer.concat([header, body]));
                } catch (error) {
                  refusals.push(error.code ?? 'NATIVE_ENGINE_CAPABILITY_UNAVAILABLE');
                  stop(engineFailure(refusals.at(-1)));
                }
              })
              .catch(stop);
          }
        } catch (error) {
          stop(error);
        }
      });
      child.once('error', stop);
      child.once('close', async (exitCode, childSignal) => {
        clearTimeout(timer);
        runSignal.removeEventListener('abort', aborted);
        await processing;
        if (failure || buffer.length) {
          reject(failure ?? engineFailure('NATIVE_ENGINE_PORT_TRUNCATED'));
          return;
        }
        resolve({
          exitCode,
          signal: childSignal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
      child.stdin.end(input === null ? undefined : Buffer.from(input, 'base64'));
    });
  };
  return {
    async tool(name, args = [], { input, env = {} } = {}) {
      if (!/^[a-z][a-z0-9-]+\.ts$/.test(name)) throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
      const words = args.indexOf('--');
      const scoped =
        words < 0
          ? [...args, '--project-dir', project]
          : [...args.slice(0, words), '--project-dir', project, ...args.slice(words)];
      return execute(join(engine.installation, 'tools', name), scoped, input, env);
    },
    async hook(name, input) {
      if (!/^[a-z][a-z0-9-]+\.ts$/.test(name)) throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
      return execute(
        join(engine.installation, 'hooks', name),
        [],
        Buffer.from(JSON.stringify(input)).toString('base64'),
      );
    },
    observe: () => execute(join(ADAPTER, 'observe.mjs'), [engine.installation, project]),
    member: (decision) =>
      execute(
        join(ADAPTER, 'member.mjs'),
        [engine.installation, project],
        Buffer.from(JSON.stringify(decision)).toString('base64'),
      ),
    observations,
    refusals,
  };
};
