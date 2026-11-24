import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../native/aidlc-launcher.sh', import.meta.url));

let temp;
let bin;
let marker;

beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-workflow-launcher-')));
  bin = join(temp, 'bin');
  marker = join(temp, 'local-binary-arguments');
  await fs.mkdir(bin, { mode: 0o700 });
  // Stands in for the installed engine: records its arguments and exits 7.
  await fs.writeFile(
    join(bin, 'aidlc'),
    '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" > "$LOCAL_BINARY_MARKER"\necho local-binary\nexit 7\n',
    { mode: 0o755 },
  );
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

const launch = (args, { context = true, env = {} } = {}) => {
  const result = spawnSync('/bin/sh', [launcher, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      AIDLC_BIN_DIR: bin,
      LOCAL_BINARY_MARKER: marker,
      ...(context ? { NATIVE_WORKFLOW_CONTEXT: join(temp, 'context.json') } : {}),
      ...env,
    },
  });
  return result;
};
const localArguments = async () => {
  try {
    const [count, ...args] = (await fs.readFile(marker, 'utf8')).split('\n').slice(0, -1);
    expect(args).toHaveLength(Number(count));
    return args;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const reachesLocalBinary = async (args, options) => {
  const result = launch(args, options);
  expect(await localArguments()).toEqual(args);
  expect(result.status).toBe(7);
  expect(result.stdout).toBe('local-binary\n');
};
it.each(
  [
    ['next', 'Create', 'a', '3D', 'version', 'of', 'the', 'game'],
    ['new-command', '--flag', '', 'two words', '$literal'],
    ['engine', 'hook', 'guard-tool-call'],
    ['engine', 'workspace', 'project-description'],
    ['doctor'],
    ['use', '2.11.1'],
    [],
  ].map((args) => [args]),
)('passes every argument through and preserves exit status', async (args) => {
  await reachesLocalBinary(args);
});
it('fails when the selected installation is missing', () => {
  expect(launch(['next'], { env: { AIDLC_BIN_DIR: temp } }).status).toBe(127);
});
