import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { captureChild, runChild } from '../cli/spawn.js';

const waitForFile = async (path) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
};

// The runner and the probes are checked-in fixture modules, and every path they
// need travels in the environment. Building either script from a value would make
// the test itself a code-construction sink.
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('CLI child process shutdown', () => {
  const runSignalled = async (signal, { group = true, install = true } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentcore-spawn-shutdown-'));
    const readyFile = join(directory, 'ready');
    const sentinelFile = join(directory, 'sentinel');
    let runner;
    try {
      runner = spawn(process.execPath, [fixture('spawn-shutdown-runner.mjs')], {
        cwd: directory,
        stdio: 'ignore',
        env: {
          ...process.env,
          SPAWN_SHUTDOWN_READY: readyFile,
          SPAWN_SHUTDOWN_SENTINEL: sentinelFile,
          SPAWN_SHUTDOWN_CHILD: group
            ? fixture('spawn-shutdown-orphan.mjs')
            : fixture('spawn-shutdown-plain-child.mjs'),
          SPAWN_SHUTDOWN_GRANDCHILD: fixture('process-tree-late-writer.mjs'),
          SPAWN_SHUTDOWN_GROUP: group ? '1' : '0',
          SPAWN_SHUTDOWN_INSTALL: install ? '1' : '0',
        },
      });
      const closed = new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      await waitForFile(readyFile);
      runner.kill(signal);
      const outcome = await closed;
      // Past the grandchild's 1.8 s write delay.
      await delay(2000);
      return {
        outcome,
        sentinelWritten: await access(sentinelFile).then(
          () => true,
          () => false,
        ),
      };
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  };

  it.each([['SIGTERM'], ['SIGINT']])(
    'kills a persona process group and its grandchild on %s, then takes the default course',
    async (signal) => {
      const { outcome, sentinelWritten } = await runSignalled(signal);
      // No `process.exit`: the handler reaps the group and re-raises, so the
      // runner dies by the signal exactly as an unhandled one would.
      expect(outcome).toMatchObject({ code: null, signal });
      // The grandchild is NOT a group leader, so only a whole-group kill reaches it.
      expect(sentinelWritten).toBe(false);
    },
  );

  // A container that hosts no persona session must terminate exactly as it did
  // before persona sessions existed.
  it('terminates a non-persona run exactly as a runner with no shutdown policy does', async () => {
    const withPolicy = await runSignalled('SIGTERM', { group: false });
    const asOnMain = await runSignalled('SIGTERM', { group: false, install: false });
    expect(withPolicy.outcome).toEqual(asOnMain.outcome);
    expect(withPolicy.outcome).toMatchObject({ code: null, signal: 'SIGTERM' });
  });
});

// A fake child that closes at once with exit 0, recording the spawn options.
const recordingSpawn = (seen) => (_command, _args, options) => {
  seen.push(options);
  return {
    on: (event, cb) => event === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  };
};

// `process.once` is a shared resource: our handler must detach only itself when it
// re-raises, or it would silently disarm shutdown work owned by someone else.
describe('the shutdown policy is a good citizen on the signal', () => {
  // A fresh module instance per test: the install is once-per-process by design.
  const installFresh = async () => {
    vi.resetModules();
    return (await import('../cli/spawn.js')).installProcessGroupShutdown;
  };

  it('leaves a pre-existing listener on the signal in place', async () => {
    const install = await installFresh();
    const seen = [];
    const theirs = () => seen.push('theirs');
    const removed = [];
    let ourListener = null;
    install({
      onSignal: (handler) => {
        ourListener = () => handler('SIGTERM', ourListener);
      },
      reraise: (signal, listener) => removed.push([signal, listener]),
    });
    // Their listener is registered independently; ours re-raises with no live group.
    theirs();
    ourListener();
    expect(removed).toEqual([['SIGTERM', ourListener]]);
    expect(seen).toEqual(['theirs']);
  });

  it('detaches only its own listener when it re-raises', async () => {
    const install = await installFresh();
    const theirs = () => {};
    process.on('SIGTERM', theirs);
    try {
      let ourListener = null;
      install({
        onSignal: (handler) => {
          ourListener = () => handler('SIGTERM', ourListener);
          process.once('SIGTERM', ourListener);
        },
        // Stop short of actually signalling this test process.
        reraise: (signal, listener) => process.removeListener(signal, listener),
      });
      expect(process.listeners('SIGTERM')).toContain(ourListener);
      ourListener();
      expect(process.listeners('SIGTERM')).not.toContain(ourListener);
      expect(process.listeners('SIGTERM')).toContain(theirs);
    } finally {
      process.removeListener('SIGTERM', theirs);
    }
  });
});

describe('CLI process groups are opt-in', () => {
  it('spawns exactly as before unless a process group is requested', async () => {
    const seen = [];
    await runChild({ command: 'cli', args: [], spawnFn: recordingSpawn(seen) });
    await captureChild({ command: 'cli', args: [], spawnFn: recordingSpawn(seen) });
    for (const options of seen) expect(options).not.toHaveProperty('detached');
  });

  it('spawns a persona session as its own process group', async () => {
    const seen = [];
    await runChild({ command: 'cli', args: [], processGroup: true, spawnFn: recordingSpawn(seen) });
    expect(seen[0].detached).toBe(process.platform !== 'win32');
  });
});

// The CLI stand-in starts a grandchild that writes the sentinel only if it is
// still alive after the CLI is gone.
const processTreeCli = fileURLToPath(new URL('./fixtures/process-tree-cli.mjs', import.meta.url));

describe('a persona session process group', () => {
  const runTree = async (mode, extra) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentcore-process-tree-'));
    const readyPath = join(directory, 'ready');
    const sentinelPath = join(directory, 'sentinel');
    try {
      const result = runChild({
        command: process.execPath,
        args: [processTreeCli, mode, sentinelPath, readyPath],
        processGroup: true,
        ...extra,
      });
      await waitForFile(readyPath);
      const outcome = await result;
      // Past the grandchild's 1.8 s write delay.
      await delay(2000);
      return {
        outcome,
        sentinelWritten: await access(sentinelPath).then(
          () => true,
          () => false,
        ),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  it('kills a timed-out session before its grandchild can write', async () => {
    const { outcome, sentinelWritten } = await runTree('hang', { timeoutMs: 1000 });
    expect(outcome).toMatchObject({ timedOut: true });
    expect(sentinelWritten).toBe(false);
  });

  it('reaps the group when the session exits normally', async () => {
    const { outcome, sentinelWritten } = await runTree('exit', {});
    expect(outcome.exitCode).toBe(0);
    expect(sentinelWritten).toBe(false);
  });
});
