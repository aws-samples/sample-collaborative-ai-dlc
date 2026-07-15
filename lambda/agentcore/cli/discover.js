// Discover which supported agent CLIs are actually installed in the image, by
// probing each driver's binary with `--version`. The image installs all of them;
// this lets selectCli pick from what's present (and lets a slimmer image work).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SUPPORTED_CLIS, getDriver } from './drivers.js';

const execFileAsync = promisify(execFile);

const probe = async (cli, exec = execFileAsync) => {
  const command = getDriver(cli).buildInvocation({ prompt: '', mcpConfigPath: '' }).command;
  try {
    await exec(command, ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

export const discoverInstalledClis = async ({ execFileFn = execFileAsync } = {}) => {
  const results = await Promise.all(
    SUPPORTED_CLIS.map(async (cli) => [cli, await probe(cli, execFileFn)]),
  );
  return results.filter(([, ok]) => ok).map(([cli]) => cli);
};
