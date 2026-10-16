import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qualificationOptions,
  installedDockerArgs,
  installedStatus,
} from '../native-qualification-options.mjs';

const image = `cached/native@sha256:${'a'.repeat(64)}`;
test('legacy invocation retains Claude; explicit selection has no missing-input fallback', () => {
  assert.equal(qualificationOptions([]).image, undefined);
  assert.deepEqual(qualificationOptions(['--image', image, '--assets', '/tmp/assets']).clis, [
    'claude',
  ]);
  assert.deepEqual(
    qualificationOptions(['--image', image, '--assets', '/tmp/assets', '--cli', 'all']).clis,
    ['claude', 'codex', 'opencode', 'kiro'],
  );
  for (const args of [
    ['--image', image],
    ['--assets', '/tmp/assets'],
    ['--cli', 'codex'],
    ['--installed-only'],
    ['--image', 'latest', '--assets', '/tmp/assets'],
    ['--image', image, '--assets', '/tmp/assets', '--cli', 'codex,codex'],
    ['--image', image, '--assets', '/tmp/assets', '--cli', 'unknown'],
  ])
    assert.throws(() => qualificationOptions(args));
});
test('installed Docker execution is immutable, isolated, read-only and credential-free', () => {
  const args = installedDockerArgs({
    image,
    assets: '/tmp/assets',
    root: '/checkout',
    cli: 'codex',
  });
  for (const [flag, value] of [
    ['--pull', 'never'],
    ['--network', 'none'],
    ['--user', 'node'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--init'));
  assert.ok(args.includes('type=bind,src=/checkout,dst=/fixture,readonly'));
  assert.ok(args.includes('type=bind,src=/tmp/assets,dst=/assets,readonly'));
  assert.deepEqual(
    args.filter((arg, i) => args[i - 1] === '-e'),
    ['NATIVE_QUALIFICATION_PACKAGE=/assets'],
  );
  assert.equal(args.at(-1), 'codex');
});
test('selected blocked, failed and missing executable statuses cannot become aggregate PASS', () => {
  assert.equal(installedStatus([0, 0]), 'PASS');
  assert.equal(installedStatus([0, 2]), 'BLOCKED');
  for (const status of [1, 125, 127, null]) assert.equal(installedStatus([0, 2, status]), 'FAIL');
});

test('matrix CLI continues after a selected gap, fails overall and cleans only its own containers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-matrix-command-'));
  try {
    // Host command contract only: this is a Docker transport stub, never
    // advertised as installed CLI evidence.
    await writeFile(
      join(directory, 'docker'),
      `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args)+'\\n');
if(args[0]==='run' && args.at(-1)==='kiro') process.exit(2);
`,
      { mode: 0o700 },
    );
    const log = join(directory, 'calls');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/native-qualification.mjs',
        '--installed-only',
        '--cli',
        'all',
        '--image',
        image,
        '--assets',
        directory,
      ],
      {
        cwd: new URL('../..', import.meta.url),
        env: { ...process.env, PATH: directory, FIXTURE_CALLS: log },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /Installed matrix: BLOCKED/);
    assert.doesNotMatch(result.stdout, /Offline native acceptance passed/);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    const runs = calls.filter((args) => args[0] === 'run');
    assert.equal(runs.length, 5); // Claude baseline plus the four selected journeys.
    assert.deepEqual(
      runs.slice(1).map((args) => args.at(-1)),
      ['claude', 'codex', 'opencode', 'kiro'],
    );
    assert.deepEqual(
      calls.filter((args) => args[0] === 'rm').map((args) => args.at(-1)),
      runs.map((args) => args[args.indexOf('--name') + 1]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
