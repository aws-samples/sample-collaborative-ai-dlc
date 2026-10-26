import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { qualificationOptions, installedDockerArgs } from '../native-qualification-options.mjs';
import { stagePackagedQualification } from '../native-qualification-packaged.mjs';
import {
  qualificationProvider,
  qualificationPlanOfferCommand,
} from '../native-qualification-provider.mjs';

test('scripted proposal preserves the engine request and cannot emit an ask after a missing request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-proposal-contract-'));
  const log = join(root, 'calls.jsonl');
  try {
    await writeFile(
      join(root, 'aidlc'),
      `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(args)+'\\n');
console.log(JSON.stringify(args.includes('--propose')
  ? {kind:'ask',ask_type:'scope-confirm'}
  : {kind:'print',message:process.env.FIXTURE_MISSING?'No request':'Run next --propose <plan> --request abcdef12'}));
`,
      { mode: 0o700 },
    );
    const description = `Quoted 'task' with \`literal\` and $(literal)`;
    const command = qualificationPlanOfferCommand('2.11.1', 'bugfix', description);
    const env = {
      ...process.env,
      PATH: `${root}:${dirname(process.execPath)}:${process.env.PATH}`,
      FIXTURE_CALLS: log,
    };
    const result = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).kind, 'ask');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls, [
      ['engine', 'orchestrate', 'next', description],
      ['engine', 'orchestrate', 'next', '--propose', 'bugfix', '--request', 'abcdef12'],
    ]);
    await writeFile(log, '');
    const failed = spawnSync('/bin/sh', ['-c', command], {
      env: { ...env, FIXTURE_MISSING: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, '');
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scripted Codex cannot turn a failed or still-running tool into a successful question', async () => {
  for (const output of [
    'Process exited with code 0\n',
    'Process exited with code 127\n',
    'Process running with session ID 12\n',
  ]) {
    const provider = await qualificationProvider('codex');
    try {
      provider.begin({ turn: 1, command: 'inert-fixture' });
      const request = { tools: [{ name: 'exec_command' }], input: [] };
      const send = (body) =>
        fetch(`${provider.url}/v1/responses`, { method: 'POST', body: JSON.stringify(body) });
      const first = await (await send(request)).text();
      const call = first
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === 'response.output_item.done').item;
      const second = await send({
        ...request,
        input: [{ type: 'function_call_output', call_id: call.call_id, output }],
      });
      if (output.includes('code 0')) {
        assert.equal(second.status, 200);
        assert.match(await second.text(), /Fixture question 1/);
        assert.equal(provider.result().toolSent, true);
      } else {
        assert.equal(second.status, 400);
        assert.throws(() => provider.result(), /successful tool completion/);
      }
    } finally {
      await provider.close();
    }
  }
});
test('packaged mode admits immutable local content IDs and mounts tests without replacing production', async () => {
  const localImage = `sha256:${'b'.repeat(64)}`;
  const options = qualificationOptions([
    '--packaged-image',
    '--image',
    localImage,
    '--assets',
    '/tmp/assets',
  ]);
  assert.throws(() => qualificationOptions(['--image', localImage, '--assets', '/tmp/assets']));
  assert.throws(() =>
    qualificationOptions(['--packaged-image', '--image', 'latest', '--assets', '/tmp/assets']),
  );
  const args = installedDockerArgs({
    ...options,
    root: '/staged',
    dependenciesRoot: '/checkout',
    cli: 'claude',
  });
  assert.ok(args.includes('type=bind,src=/staged,dst=/fixture,readonly'));
  assert.ok(
    args.includes('type=bind,src=/checkout/node_modules,dst=/fixture/node_modules,readonly'),
  );
  assert.ok(args.includes('/fixture/scripts/native-qualification-packaged-audit.mjs'));
  assert.ok(!args.some((item) => /dst=\/opt/.test(item)));
  const root = await mkdtemp(join(tmpdir(), 'packaged-stage-test-'));
  let staged;
  try {
    for (const path of [
      'scripts',
      'test',
      'lambda/native-runtime-control',
      'lambda/agentcore/test',
      'lambda/shared/test',
    ])
      await mkdir(join(root, path), { recursive: true });
    for (const path of [
      'package.json',
      'package-lock.json',
      'vitest.native-foundation.config.js',
      'lambda/agentcore/owner.js',
      'lambda/shared/contract.js',
      'lambda/agentcore/test/fixture.js',
    ])
      await writeFile(join(root, path), path);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await mkdir(join(root, 'lambda/native-runtime-control/test'), { recursive: true });
    for (const path of [
      'execution-worker.js',
      'execution-api.js',
      'execution-runtime.js',
      'test/execution-fixtures.js',
      'test/memory-objects.js',
      'test/fixtures.js',
    ])
      await writeFile(join(root, 'lambda/native-runtime-control', path), 'export {};');
    await writeFile(join(root, 'scripts/native-installed-qualification.mjs'), 'export {};');
    await writeFile(
      join(root, 'scripts/native-workspace-qualification-driver.mjs'),
      "import {executionIdentity} from '../lambda/native-runtime-control/execution-runtime.js';",
    );
    staged = await stagePackagedQualification(root);
    assert.match(
      await readFile(
        join(staged.directory, 'scripts/native-workspace-qualification-driver.mjs'),
        'utf8',
      ),
      /from '..\/controller-qualification.mjs'/,
    );
    assert.equal(
      await readlink(join(staged.directory, 'lambda/agentcore/owner.js')),
      '/opt/agentcore/owner.js',
    );
    assert.equal(
      await readFile(join(staged.directory, 'lambda/agentcore/test/fixture.js'), 'utf8'),
      'lambda/agentcore/test/fixture.js',
    );
    const manifest = JSON.parse(await readFile(join(staged.directory, 'packaged-source.json')));
    assert.equal(manifest.length, 2);
    assert.ok(
      manifest.every(
        (entry) => entry.path.startsWith('/opt/') && /^[a-f0-9]{64}$/.test(entry.sha256),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    if (staged) await rm(staged.directory, { recursive: true, force: true });
  }
});
