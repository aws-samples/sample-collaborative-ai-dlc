import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import express from 'express';
import { Hono } from 'hono';
import { parseBody } from 'hono/utils/body';
import yaml from 'js-yaml';
import qs from 'qs';

const require = createRequire(import.meta.url);

test('js-yaml preserves ordinary merges and counts empty merge sources against the budget', () => {
  assert.deepEqual(yaml.load('defaults: &d {enabled: true}\nitem: {<<: *d, name: ok}').item, {
    enabled: true,
    name: 'ok',
  });
  assert.throws(
    () => yaml.load('a: &a [{}, {}, {}]\nb: {<<: *a}', { maxTotalMergeKeys: 2 }),
    /merge/i,
  );
});

// Resolve through the two consumers so both installed major versions are tested.
const legacyMinimatch = createRequire(require.resolve('readdir-glob')).resolve('minimatch');
const expandLegacy = createRequire(legacyMinimatch)('brace-expansion');
const { expand: expandModern } = createRequire(require.resolve('minimatch'))('brace-expansion');

for (const [name, expand] of [
  ['legacy', expandLegacy],
  ['modern', expandModern],
]) {
  test(`brace-expansion ${name} preserves normal globs and bounds alternatives and padded ranges`, () => {
    assert.deepEqual(expand('file-{a,b}.{js,ts}'), [
      'file-a.js',
      'file-a.ts',
      'file-b.js',
      'file-b.ts',
    ]);
    assert.deepEqual(expand('{aaaa,bbbb,cccc}', { max: 100, maxLength: 10 }), ['aaaa', 'bbbb']);
    assert.deepEqual(expand('{000001..000020}', { max: 100, maxLength: 10 }), ['000001']);
  });
}

test('archiver exports the expected files through its glob consumers', async () => {
  const archiver = require('archiver');
  const fixture = mkdtempSync(join(tmpdir(), 'aidlc-archive-deps-'));
  try {
    mkdirSync(join(fixture, 'nested'));
    writeFileSync(join(fixture, 'one.js'), 'export const one = 1;\n');
    writeFileSync(join(fixture, 'nested/two.ts'), 'export const two = 2;\n');
    writeFileSync(join(fixture, 'excluded.txt'), 'excluded\n');
    const archive = archiver('zip');
    const entries = [];
    const chunks = [];
    archive.on('entry', (entry) => entries.push(entry.name));
    archive.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
      archive.on('warning', reject);
    });
    archive.glob('**/*.{js,ts}', { cwd: fixture });
    await archive.finalize();
    await finished;
    assert.deepEqual(entries.toSorted(), ['nested/two.ts', 'one.js']);
    assert.equal(Buffer.concat(chunks).readUInt32LE(0), 0x04034b50);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Hono parses normal queries without accepting parameters inside URL fragments', async () => {
  const app = new Hono();
  app.get('/query', (context) => context.json(context.req.query()));
  assert.deepEqual(await (await app.request('/query?name=ok')).json(), { name: 'ok' });
  assert.deepEqual(await (await app.request('/query#fragment?admin=true')).json(), {});
});

test('Hono parses normal dotted form fields and rejects excessive nesting', async () => {
  const request = (key) =>
    new Request('http://localhost/form', {
      method: 'POST',
      body: new URLSearchParams({ [key]: 'value' }),
    });
  const normal = await parseBody(request('user.name'), { dot: true });
  assert.equal(normal.user.name, 'value');
  await assert.rejects(
    parseBody(request(`${'a.'.repeat(34)}value`), { dot: true }),
    /Nesting limit/,
  );
});

test('qs preserves nested values and safely handles attacker-controlled constructor keys', () => {
  const value = { user: { name: 'hello world' }, tags: ['a', 'b'] };
  assert.deepEqual(qs.parse(qs.stringify(value)), value);
  const query = 'x%5Bconstructor%5D%5BisBuffer%5D=y';
  assert.equal(qs.stringify(qs.parse(query, { plainObjects: true })), query);
  assert.throws(
    () => qs.parse('a[]=1,2,3', { comma: true, arrayLimit: 2, throwOnLimitExceeded: true }),
    /Array limit exceeded/i,
  );
});

test('qs remains compatible with the MCP SDK Express form parser', async () => {
  const app = createMcpExpressApp();
  app.post('/form', express.urlencoded({ extended: true }), (request, response) => {
    response.json(request.body);
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/form`, {
      method: 'POST',
      body: new URLSearchParams({ 'user[name]': 'Ada', 'tags[]': 'code' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: { name: 'Ada' }, tags: ['code'] });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Nano ID preserves normal IDs and terminates zero-size custom generators', () => {
  // A regressed infinite loop must fail in a bounded child process, not hang CI.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        import { dirname, join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const require = createRequire(join(process.cwd(), 'package.json'));
        const packageDir = dirname(require.resolve('nanoid/package.json'));
        for (const entry of ['index.js', 'index.cjs', 'index.browser.js', 'async/index.browser.js']) {
          const nanoid = await import(pathToFileURL(join(packageDir, entry)));
          assert.equal((await nanoid.nanoid(21)).length, 21);
          assert.match(await nanoid.customAlphabet('abc', 12)(), /^[abc]{12}$/);
          assert.equal(await nanoid.customAlphabet('abc', 0)(), '');
          assert.equal(await nanoid.customAlphabet('abc', 12)(0), '');
          if (nanoid.customRandom) {
            assert.equal(nanoid.customRandom('abc', 0, size => new Uint8Array(size))(), '');
          }
        }
      `,
    ],
    { timeout: 5_000, stdio: 'pipe' },
  );
});
