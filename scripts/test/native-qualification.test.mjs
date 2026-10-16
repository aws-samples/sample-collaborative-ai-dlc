import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qualificationOptions,
  installedDockerArgs,
  installedStatus,
  linuxDockerArgs,
} from '../native-qualification-options.mjs';
import {
  prepareQualificationOpenCodeCache,
  verifyQualificationOpenCodeDependencies,
  downloadQualificationArtifact,
  prepareQualificationFixtures,
  verifyQualificationAssets,
  verifyQualificationLinuxBindings,
} from '../native-qualification-package.mjs';

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
    ['--opencode-cache', '/tmp/cache'],
    ['--linux-bindings', '/tmp/bindings'],
    ['--image', 'latest', '--assets', '/tmp/assets'],
    ['--image', image, '--assets', '/tmp/assets', '--cli', 'codex,codex'],
    ['--image', image, '--assets', '/tmp/assets', '--cli', 'unknown'],
  ])
    assert.throws(() => qualificationOptions(args));
});

test('Linux checks use the same offline container boundary and an explicit locked binding', () => {
  const args = linuxDockerArgs({
    image,
    assets: '/tmp/assets',
    root: '/checkout',
    linuxBindings: '/tmp/bindings',
    name: 'native-qualification-linux-fixture',
  });
  for (const [flag, value] of [
    ['--pull', 'never'],
    ['--network', 'none'],
    ['--user', 'node'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('type=bind,src=/tmp/bindings,dst=/linux-node-modules,readonly'));
  assert.ok(args.includes('NODE_PATH=/linux-node-modules'));
  assert.ok(args.includes('lambda/agentcore/test/native-command-runner.test.js'));
  assert.ok(args.includes('lambda/agentcore/test/native-session-recovery-files.test.js'));
  assert.ok(args.includes('--maxWorkers=2'));
});

test('explicit fixture preparation preserves nonempty cached inputs before any network access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-preparation-preserved-'));
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected fetch');
  });
  try {
    await writeFile(join(directory, 'cached'), 'immutable fixture');
    await assert.rejects(prepareQualificationFixtures(directory), /empty directory/);
    assert.equal(await readFile(join(directory, 'cached'), 'utf8'), 'immutable fixture');
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(verifyQualificationAssets(directory), { code: 'ENOENT' });
    await writeFile(join(directory, 'aidlc-linux-arm64'), 'truncated');
    await assert.rejects(verifyQualificationAssets(directory), /Exact public fixture size/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public artifact preparation binds exact bytes and integrity and removes rejected partial downloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-public-artifact-'));
  const bytes = Buffer.from('immutable public fixture');
  const pin = {
    url: 'https://registry.npmjs.org/fixture/fixture.tgz',
    integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    bytes: bytes.length,
    maxBytes: bytes.length,
  };
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  try {
    const destination = join(directory, 'artifact');
    await downloadQualificationArtifact(pin, destination);
    assert.deepEqual(await readFile(destination), bytes);
    await assert.rejects(downloadQualificationArtifact(pin, destination), { code: 'EEXIST' });
    assert.deepEqual(await readFile(destination), bytes, 'Never overwrite a cached artifact');
    await rm(destination);
    for (const [response, altered] of [
      [new Response(Buffer.from('x'.repeat(bytes.length))), pin],
      [new Response(Buffer.alloc(bytes.length + 1)), pin],
      [new Response(bytes.subarray(1)), pin],
      [new Response('', { status: 503 }), pin],
      [new Response(bytes), { ...pin, url: 'https://unapproved.invalid/artifact' }],
    ]) {
      fetch.mock.mockImplementation(async () => response);
      await assert.rejects(downloadQualificationArtifact(altered, destination));
      await assert.rejects(readFile(destination), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reused Linux bindings reject altered bytes even with the expected package name and version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-linux-binding-corrupt-'));
  const module = join(directory, '@rolldown/binding-linux-arm64-gnu');
  try {
    await mkdir(module, { recursive: true });
    await writeFile(join(module, 'README.md'), Buffer.alloc(112));
    await writeFile(
      join(module, 'package.json'),
      JSON.stringify({ name: '@rolldown/binding-linux-arm64-gnu', version: '1.1.5' }),
    );
    await writeFile(join(module, 'rolldown-binding.linux-arm64-gnu.node'), 'corrupt');
    await assert.rejects(
      verifyQualificationLinuxBindings(directory),
      /Exact public fixture digest/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('public dependency cache is read-only and only enters the selected OpenCode container', () => {
  const options = qualificationOptions([
    '--image',
    image,
    '--assets',
    '/tmp/assets',
    '--opencode-cache',
    '/tmp/cache',
  ]);
  for (const cli of ['claude', 'codex', 'opencode', 'kiro']) {
    const args = installedDockerArgs({ ...options, root: '/checkout', cli });
    assert.equal(
      args.includes('type=bind,src=/tmp/cache,dst=/opencode-cache,readonly'),
      cli === 'opencode',
    );
    assert.equal(
      args.includes('NATIVE_QUALIFICATION_OPENCODE_CACHE=/opencode-cache'),
      cli === 'opencode',
    );
  }
});
test('missing OpenCode cache cannot silently qualify a package-free workflow', async () => {
  await assert.rejects(prepareQualificationOpenCodeCache('/unused'), {
    code: 'native_qualification_opencode_cache_required',
  });
});
test('actual installer dependency closure rejects missing, extra or retargeted locked artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-opencode-lock-'));
  try {
    const expected = JSON.parse(
      await readFile(
        new URL('./fixtures/native-opencode-package-lock.json', import.meta.url),
        'utf8',
      ),
    );
    const project = join(directory, 'project');
    const config = join(directory, 'config');
    for (const path of [join(project, '.opencode'), join(config, 'opencode')]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'package-lock.json'), JSON.stringify(expected));
    }
    assert.equal(await verifyQualificationOpenCodeDependencies(project, config), 32);
    for (const change of [
      (lock) => {
        delete lock.packages['node_modules/zod'];
      },
      (lock) => {
        lock.packages['node_modules/zod'].integrity = `sha512-${'a'.repeat(88)}`;
      },
      (lock) => {
        lock.packages['node_modules/zod'].version = '0.0.0';
      },
      (lock) => {
        lock.packages['node_modules/unrequested'] = { version: '1.0.0' };
      },
    ]) {
      const altered = structuredClone(expected);
      change(altered);
      await writeFile(join(config, 'opencode/package-lock.json'), JSON.stringify(altered));
      await assert.rejects(verifyQualificationOpenCodeDependencies(project, config));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
