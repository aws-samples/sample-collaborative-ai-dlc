import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
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

describe('CLI child process shutdown', () => {
  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])('kills detached CLI process groups when the runner receives %s', async (signal, exitCode) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentcore-spawn-shutdown-'));
    const readyFile = join(directory, 'ready');
    const sentinelFile = join(directory, 'sentinel');
    // The runner and the orphan probe are checked-in fixture modules, and every
    // path they need travels in the environment. Building either script from a
    // value would make the test itself a code-construction sink.
    const runnerModule = fileURLToPath(
      new URL('./fixtures/spawn-shutdown-runner.mjs', import.meta.url),
    );
    const orphanModule = fileURLToPath(
      new URL('./fixtures/spawn-shutdown-orphan.mjs', import.meta.url),
    );
    let runner;
    try {
      runner = spawn(process.execPath, [runnerModule], {
        cwd: directory,
        stdio: 'ignore',
        env: {
          ...process.env,
          SPAWN_SHUTDOWN_READY: readyFile,
          SPAWN_SHUTDOWN_SENTINEL: sentinelFile,
          SPAWN_SHUTDOWN_ORPHAN: orphanModule,
        },
      });
      const closed = new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      await waitForFile(readyFile);
      runner.kill(signal);
      expect(await closed).toMatchObject({ code: exitCode, signal: null });
      await delay(700);

      await expect(access(sentinelFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
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
