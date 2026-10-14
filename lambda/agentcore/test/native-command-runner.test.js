import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_COMMAND_LIMITS, runNativeCommand } from '../native/command-runner.js';

// Actual Node subprocesses execute only this test-authored inert fixture.
// The two lifecycle failure tests use fake children WITHOUT PIDs, so the
// production group-signalling code can never target an unrelated process.
vi.mock('node:child_process', async (original) => {
  const actual = await original();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const fixtureSource = `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
switch (mode) {
  case 'echo':
    process.stdout.write(JSON.stringify({
      args, cwd: process.cwd(), stdin: readFileSync(0, 'utf8'),
      envKeys: Object.keys(process.env),
      allowed: process.env.ONLY_ALLOWED,
    }));
    break;
  case 'nonzero':
    process.stdout.write('private stdout');
    process.stderr.write('private stderr');
    process.exitCode = 23;
    break;
  case 'utf8': {
    const bytes = Buffer.from('A💡café\\n');
    for (const byte of bytes) {
      writeSync(1, Buffer.from([byte]));
      writeSync(2, Buffer.from([byte]));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    break;
  }
  case 'utf8-overflow':
    writeSync(1, Buffer.from('A💡more'));
    setInterval(() => {}, 1000);
    break;
  case 'overflow': {
    const fd = args[0] === 'stderr' ? 2 : 1;
    const bytes = Buffer.alloc(65536, fd === 1 ? 65 : 66);
    while (true) writeSync(fd, bytes);
  }
  case 'finite-overflow':
    for (let i = 0; i < 32; i++) {
      writeSync(1, Buffer.alloc(8192, 65));
      writeSync(2, Buffer.alloc(8192, 66));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(args[0], 'finished after capture overflow');
    break;
  case 'wait':
    process.on('SIGTERM', () => {});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
    break;
  case 'descendant': {
    const pidFile = args[0];
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ], { env: {}, stdio: 'ignore' });
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    if (args[1] !== 'exit') setInterval(() => {}, 1000);
    break;
  }
  default: throw new Error('Unknown inert test mode');
}
`;

let realSpawn;
let root;
let fixture;
beforeAll(async () => {
  realSpawn = (await vi.importActual('node:child_process')).spawn;
});
beforeEach(async () => {
  vi.mocked(spawn).mockReset().mockImplementation(realSpawn);
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-command-runner-')));
  fixture = join(root, 'inert-fixture.mjs');
  await fs.writeFile(fixture, fixtureSource, { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const run = (mode, args = [], options = {}) =>
  runNativeCommand({
    command: process.execPath,
    args: [fixture, mode, ...args],
    cwd: root,
    env: {},
    timeoutMs: 2000,
    ...options,
  });
const success = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  spawnError: null,
  cleanupComplete: true,
};
const noProcess = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};
// CoreFoundation initializes this variable inside a fresh macOS Node process.
// It is not supplied to spawn; all other keys must match the explicit env.
const providedEnvKeys = (keys) =>
  keys.filter((key) => process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING');

describe.skipIf(process.platform === 'win32')('bounded native command runner', () => {
  it('pauses stdout until observer pressure resolves and cancels while paused', async () => {
    const controller = new AbortController();
    let release;
    const pressure = new Promise((resolve) => {
      release = resolve;
    });
    let observed;
    const received = new Promise((resolve) => {
      observed = resolve;
    });
    const pending = run('wait', [], {
      timeoutMs: null,
      signal: controller.signal,
      onStdoutChunk: () => {
        observed();
        return pressure;
      },
    });
    await received;
    const child = spawn.mock.results[0].value;
    expect(child.stdout.isPaused()).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.stdout.isPaused()).toBe(false);
    controller.abort();
    expect(await pending).toMatchObject({
      signal: 'SIGKILL',
      cleanupComplete: true,
      timedOut: false,
    });

    const nextController = new AbortController();
    let ready;
    const nextReceived = new Promise((resolve) => {
      ready = resolve;
    });
    const blocked = run('wait', [], {
      timeoutMs: null,
      signal: nextController.signal,
      onStdoutChunk: () => {
        ready();
        return new Promise(() => {});
      },
    });
    await nextReceived;
    expect(spawn.mock.results[1].value.stdout.isPaused()).toBe(true);
    nextController.abort();
    expect(await blocked).toMatchObject({
      signal: 'SIGKILL',
      cleanupComplete: true,
      timedOut: false,
    });
  });

  it('passes literal argv, an explicit environment and cwd, and ignores stdin', async () => {
    vi.stubEnv('NATIVE_RUNNER_PARENT_SECRET', 'inert-secret');
    const marker = join(root, 'shell-must-not-run');
    const args = [
      `$(touch ${marker})`,
      `; touch ${marker}`,
      '| cat',
      '> output',
      '`id`',
      'a b',
      '💡',
    ];
    const result = await run('echo', args, { env: { ONLY_ALLOWED: 'explicit' } });
    expect(result).toMatchObject(success);
    const output = JSON.parse(result.stdout);
    output.envKeys = providedEnvKeys(output.envKeys);
    expect(output).toEqual({
      args,
      cwd: root,
      stdin: '',
      envKeys: ['ONLY_ALLOWED'],
      allowed: 'explicit',
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawn.mock.calls[0][2]).toMatchObject({
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('supports an explicitly empty environment without inheriting parent variables', async () => {
    vi.stubEnv('NATIVE_RUNNER_PARENT_SECRET', 'inert-secret');
    const coverage = join(root, 'unrequested-coverage');
    vi.stubEnv('NODE_V8_COVERAGE', coverage);
    const result = await run('echo');
    expect(result).toMatchObject(success);
    expect(providedEnvKeys(JSON.parse(result.stdout).envKeys)).toEqual([]);
    expect(Object.hasOwn(spawn.mock.calls[0][2].env, '__CF_USER_TEXT_ENCODING')).toBe(false);
    await expect(fs.stat(coverage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns nonzero exit status and keeps both outputs private', async () => {
    const result = await run('nonzero');
    expect(result).toEqual({
      ...success,
      exitCode: 23,
      stdout: 'private stdout',
      stderr: 'private stderr',
    });
  });

  it('joins valid UTF-8 sequences split across stdout and stderr chunks', async () => {
    const result = await run('utf8');
    expect(result).toEqual({ ...success, stdout: 'A💡café\n', stderr: 'A💡café\n' });
  });

  it.each(['stdout', 'stderr'])(
    'kills output overflow and retains at most the %s byte budget',
    async (stream) => {
      const result = await run('overflow', [stream], { stdoutBytes: 31, stderrBytes: 17 });
      expect(result).toMatchObject({
        exitCode: null,
        signal: 'SIGKILL',
        outputLimitExceeded: true,
        timedOut: false,
        spawnError: null,
        cleanupComplete: true,
      });
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(31);
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(17);
      expect(result[stream]).toBe(
        (stream === 'stdout' ? 'A' : 'B').repeat(stream === 'stdout' ? 31 : 17),
      );
    },
  );

  it('does not emit a broken or over-budget UTF-8 character at the capture boundary', async () => {
    const result = await run('utf8-overflow', [], { stdoutBytes: 4 });
    expect(result).toMatchObject({ outputLimitExceeded: true, cleanupComplete: true });
    expect(result.stdout).toBe('A');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
  });

  it('drains overflowing streams without terminating the child when explicitly requested', async () => {
    const marker = join(root, 'completed');
    const result = await run('finite-overflow', [marker], {
      timeoutMs: null,
      outputLimitAction: 'truncate',
      stdoutBytes: 31,
      stderrBytes: 17,
    });
    expect(result).toEqual({
      ...success,
      outputLimitExceeded: true,
      stdout: 'A'.repeat(31),
      stderr: 'B'.repeat(17),
    });
    expect(await fs.readFile(marker, 'utf8')).toBe('finished after capture overflow');
  });

  it('passes literal UTF-8 stdin separately from argv', async () => {
    const prompt = 'A real user request 🐦\n$(touch never)\n';
    const result = await run('echo', [], { stdin: prompt, timeoutMs: null });
    expect(result).toMatchObject(success);
    expect(JSON.parse(result.stdout).stdin).toBe(prompt);
  });

  it('does not install a model deadline when timeoutMs is null', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.unref = vi.fn();
      vi.mocked(spawn).mockReturnValueOnce(child);
      const controller = new AbortController();
      const pending = run('wait', [], { timeoutMs: null, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(child.kill).not.toHaveBeenCalled();
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null, 'SIGKILL');
      expect(await pending).toMatchObject({ timedOut: false, cleanupComplete: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports zero-byte output budgets and stops on the first byte', async () => {
    const result = await run('overflow', ['stdout'], { stdoutBytes: 0, stderrBytes: 0 });
    expect(result).toMatchObject({
      stdout: '',
      stderr: '',
      outputLimitExceeded: true,
      cleanupComplete: true,
    });
  });

  it('kills a SIGTERM-ignoring process on timeout and waits for cleanup', async () => {
    const result = await run('wait', [], { timeoutMs: 150 });
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      outputLimitExceeded: false,
      cleanupComplete: true,
      spawnError: null,
    });
    const child = spawn.mock.results[0].value;
    expect(noProcess(child.pid)).toBe(true);
  });

  it('aborts an active child, then returns only after its close', async () => {
    const controller = new AbortController();
    const pending = run('wait', [], { signal: controller.signal });
    const child = spawn.mock.results[0].value;
    child.stdout.once('data', () => controller.abort('private abort reason'));
    let closed = false;
    child.once('close', () => {
      closed = true;
    });
    const result = await pending;
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
      outputLimitExceeded: false,
      cleanupComplete: true,
      spawnError: null,
    });
    expect(closed).toBe(true);
    expect(noProcess(child.pid)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private abort reason');
  });

  it('does not spawn when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run('wait', [], { signal: controller.signal });
    expect(result).toEqual({
      ...success,
      exitCode: null,
      stdout: '',
      stderr: '',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'exit'])('cleans ordinary descendants after parent %s', async (ending) => {
    const pidFile = join(root, 'owned-descendant.pid');
    // Let the fixture start under full-suite contention before testing cleanup.
    const result = await run('descendant', [pidFile, ending], { timeoutMs: 2000 });
    const descendant = Number(await fs.readFile(pidFile, 'utf8'));
    expect(result).toMatchObject({
      cleanupComplete: true,
      timedOut: ending === 'timeout',
      spawnError: null,
      outputLimitExceeded: false,
    });
    expect(noProcess(descendant)).toBe(true);
  });

  it('sanitizes asynchronous spawn failures without exposing paths or messages', async () => {
    const result = await run('echo', [], { command: join(root, 'private-missing-executable') });
    expect(result).toEqual({
      ...success,
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT',
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('private-missing-executable');
  });

  it('sanitizes synchronous spawn errors using only the fixed error enum', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw Object.assign(new Error('private executable and credentials'), { code: 'secret-code' });
    });
    expect(await run('echo')).toEqual({
      ...success,
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnError: 'SPAWN_FAILED',
    });
  });

  it.each([
    { command: 'node' },
    { args: ['safe', 1] },
    { cwd: '.' },
    { env: undefined },
    { env: { SECRET: undefined } },
    { env: Object.create({ SECRET: 'inherited' }) },
    { env: { 'BAD=KEY': 'value' } },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 2_147_483_648 },
    { stdoutBytes: -1 },
    { stdoutBytes: NATIVE_COMMAND_LIMITS.maxOutputBytes + 1 },
    { stderrBytes: NaN },
    { outputLimitAction: 'ignore' },
    { stdin: 5 },
    { stdin: Buffer.alloc(1024 * 1024 + 1) },
  ])('rejects invalid invocation options before spawning: %j', async (options) => {
    expect(await run('echo', [], options)).toEqual({
      ...success,
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnError: 'INVALID_ARGUMENT',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds cleanup when a child never emits close and ignores late errors', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => false);
    child.unref = vi.fn();
    // Deliberately no PID: this fake child must never reach process.kill().
    vi.mocked(spawn).mockReturnValueOnce(child);
    const result = await run('wait', [], { timeoutMs: 20 });
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      cleanupComplete: false,
      spawnError: null,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(() => child.emit('error', new Error('late private error'))).not.toThrow();
    expect(() => child.emit('close', 0, null)).not.toThrow();
    expect(result.cleanupComplete).toBe(false);
  }, 2000);
});
