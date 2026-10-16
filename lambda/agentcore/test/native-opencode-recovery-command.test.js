import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  captureNativeSessionRecovery,
  restoreNativeSessionRecovery,
} from '../native/session-recovery-files.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  spawn: vi.fn(),
}));

let root;
let project;
let home;
let calls;
let outcome;
let onLock;
const id = 'ses_fixture';
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-recovery-command-')));
  project = join(root, 'project');
  home = join(root, 'home');
  await fs.mkdir(project, { mode: 0o700 });
  await fs.mkdir(home, { mode: 0o700 });
  calls = [];
  outcome = 'success';
  onLock = () => {};
  const { spawn: actualSpawn } = await vi.importActual('node:child_process');
  spawn.mockImplementation((command, args, options) => {
    if (command !== '/opt/opencode/bin/opencode') return actualSpawn(command, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {
      setImmediate(() => child.emit('close', null));
    };
    calls.push({ command, args, ...options });
    setImmediate(async () => {
      // Model the pinned CLI's detached installer: it exits with a fresh lock.
      const state = options.env.XDG_STATE_HOME ?? join(home, '.local/state');
      await fs.mkdir(join(state, 'opencode/locks/installer.lock'), { recursive: true });
      await fs.writeFile(join(state, 'opencode/locks/installer.lock/heartbeat'), '');
      onLock();
      if (outcome === 'abort') return;
      if (outcome === 'spawn-error') return child.emit('error', new Error('fixture spawn error'));
      child.stdout.end(
        outcome === 'oversize'
          ? Buffer.alloc(2048)
          : JSON.stringify({
              info: { id, directory: project },
              messages: [{ info: { id: 'message', sessionID: id }, parts: [] }],
            }),
      );
      child.emit('close', outcome === 'exit-error' ? 1 : 0);
    });
    return child;
  });
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const capture = (extra = {}) =>
  captureNativeSessionRecovery({
    harness: 'opencode',
    nativeSessionId: id,
    project,
    home,
    ...extra,
  });

it('import/export leave no lock for the next writer and preserve the session/config/cache locations', async () => {
  const checkpoint = await capture();
  await restoreNativeSessionRecovery({
    harness: 'opencode',
    nativeSessionId: id,
    project,
    home,
    ...checkpoint,
  });
  expect(calls.map((call) => call.args[0])).toEqual(['export', 'import', 'export']);
  expect(new Set(calls.map((call) => call.env.XDG_STATE_HOME)).size).toBe(3);
  for (const call of calls) {
    expect(call.command).toBe('/opt/opencode/bin/opencode');
    expect(call.args.at(-1)).toBe('--pure');
    expect(call.cwd).toBe(project);
    expect(call.env).toMatchObject({
      HOME: home,
      XDG_DATA_HOME: join(home, '.data'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
    });
    expect(call.env).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG');
    expect(call.env).not.toHaveProperty('npm_config_bin_links');
  }
  expect(await fs.readdir(home)).toEqual(['.codex']);
});

it('removes command-owned locks after cancellation closes the child', async () => {
  const controller = new AbortController();
  outcome = 'abort';
  onLock = () => controller.abort();
  await expect(capture({ signal: controller.signal })).rejects.toThrow('native_recovery_cancelled');
  expect(await fs.readdir(home)).toEqual([]);
});

it.each(['exit-error', 'spawn-error', 'oversize'])(
  'cleans only command-owned state on %s without deleting existing writer state',
  async (failure) => {
    const sentinel = join(home, '.local/state/opencode/locks/writer.lock');
    await fs.mkdir(sentinel, { recursive: true });
    await fs.writeFile(join(sentinel, 'heartbeat'), 'retained');
    outcome = failure;
    await expect(capture({ limits: { maxFileBytes: 1024 } })).rejects.toThrow(
      'native_recovery_adapter_failed',
    );
    expect(await fs.readFile(join(sentinel, 'heartbeat'), 'utf8')).toBe('retained');
    expect(await fs.readdir(join(home, '.local/state/opencode/locks'))).toEqual(['writer.lock']);
    expect(
      (await fs.readdir(home)).filter((name) => name.startsWith('.native-recovery-state-')),
    ).toEqual([]);
  },
);
