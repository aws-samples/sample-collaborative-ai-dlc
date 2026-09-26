import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const spawnModule = new URL('../cli/spawn.js', import.meta.url).href;
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinelFile)}, 'orphan'), 500)`;
    const runnerScript = `
      import { writeFileSync } from 'node:fs';
      import { runChild } from ${JSON.stringify(spawnModule)};
      const child = runChild({ command: process.execPath, args: ['-e', ${JSON.stringify(childScript)}] });
      writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      await child;
    `;
    let runner;
    try {
      runner = spawn(process.execPath, ['--input-type=module', '-e', runnerScript], {
        cwd: directory,
        stdio: 'ignore',
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
