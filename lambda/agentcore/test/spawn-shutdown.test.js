import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

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
