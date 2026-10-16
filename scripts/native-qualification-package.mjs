// Public, attested fixture assets only. The real pinned installer performs its
// signature/issuer/repository/ref checks; this helper supplies offline roots.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const opencodeLock = async () =>
  JSON.parse(
    await fs.readFile(
      new URL('./test/fixtures/native-opencode-package-lock.json', import.meta.url),
      'utf8',
    ),
  );

async function verifyOpenCodeCache(cache, lock) {
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path) continue;
    const hex = Buffer.from(item.integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
    const content = join(
      cache,
      '_cacache/content-v2/sha512',
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    const stat = await fs.lstat(content);
    assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, 'Bounded pinned dependency artifact');
    const bytes = await fs.readFile(content);
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      item.integrity,
      'Public dependency artifact integrity',
    );
  }
}

export async function prepareQualificationOpenCodeCache(root, cache) {
  if (!cache)
    throw Object.assign(new Error('Supply --opencode-cache'), {
      code: 'native_qualification_opencode_cache_required',
    });
  assert.equal(cache, '/opencode-cache');
  await verifyOpenCodeCache(cache, await opencodeLock());
  const target = join(root, 'opencode-npm-cache');
  await fs.cp(cache, target, { recursive: true });
  const config = join(root, 'tools/empty.npmrc');
  await fs.writeFile(config, '', { mode: 0o600 });
  return {
    npm_config_cache: target,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: config,
  };
}

export async function verifyQualificationOpenCodeDependencies(project, homeConfig) {
  const expected = await opencodeLock();
  const entries = (lock) =>
    Object.fromEntries(
      Object.entries(lock.packages)
        .filter(([path]) => path)
        .map(([path, item]) => [path, { version: item.version, integrity: item.integrity }]),
    );
  for (const directory of [join(project, '.opencode'), join(homeConfig, 'opencode')]) {
    const actual = JSON.parse(await fs.readFile(join(directory, 'package-lock.json'), 'utf8'));
    assert.deepEqual(actual.packages[''].dependencies, expected.packages[''].dependencies);
    assert.deepEqual(
      entries(actual),
      entries(expected),
      'Installed dependency versions/integrities match the frozen fixture',
    );
  }
  return Object.keys(expected.packages).length - 1;
}

export async function prepareQualificationPackage(root, assets) {
  assert.ok(assets, 'The installed tier requires attested release assets');
  const pins = {
    'aidlc-linux-arm64': '18e6fefcd3591aefd66d8a485fba5deaa870c6bbc6fd3e389d4b0b2032ce9f35',
    'aidlc-runtime-2.11.0.tar.gz':
      '68906435223b47d6dfda59d79def78974d7b37e38b5649a56402a0007a41fad4',
    'version.json': '5711b7af08fc8c293576fdde9252b6b9fe13a7041f7db5f0dd33f6b56223c1e9',
    'checksums.txt': 'c49098da9ce425afbc5c5beeaae395aa8480c6f887107b0b455cc1143cac2ac9',
  };
  const directory = `${root}/packages/2.11.0`;
  const tools = `${root}/tools`;
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  await fs.mkdir(tools);
  for (const [name, hash] of Object.entries(pins)) {
    const bytes = await fs.readFile(`${assets}/${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
    await fs.writeFile(`${directory}/${name}`, bytes);
  }
  await fs.copyFile(
    `${assets}/aidlc-release.intoto.jsonl`,
    `${directory}/aidlc-release.intoto.jsonl`,
  );
  const binaryPath = `${directory}/aidlc-linux-arm64`;
  await fs.chmod(binaryPath, 0o700);
  const gh = ['/usr/bin/gh', '/usr/local/bin/gh'].find(existsSync);
  assert.ok(gh, 'The immutable image must contain the installer verifier');
  // Both paths are fixed container paths, never user-supplied shell fragments.
  assert.equal(assets, '/assets');
  await fs.writeFile(
    `${tools}/gh`,
    `#!/bin/sh\nexec ${gh} "$@" --custom-trusted-root /assets/trusted-root.jsonl\n`,
    { mode: 0o700 },
  );
  return { directory, binaryPath, tools, version: '2.11.0' };
}

// Explicit public-asset preparation only. Ordinary qualification never fetches.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], '--prepare-opencode-cache');
  assert.equal(process.argv.length, 4);
  const cache = resolve(process.argv[3]);
  assert.notEqual(cache, '/');
  const root = await fs.mkdtemp(join(tmpdir(), 'native-opencode-cache-'));
  try {
    const config = join(root, 'global.npmrc');
    await fs.writeFile(config, '');
    const lock = await opencodeLock();
    const specs = Object.entries(lock.packages)
      .filter(([path]) => path)
      .map(([path, item]) => {
        assert.ok(item.resolved.startsWith('https://registry.npmjs.org/'));
        assert.ok(item.integrity.startsWith('sha512-'));
        return `${path.replace(/^node_modules\//, '')}@${item.version}`;
      });
    const result = spawnSync(
      'npm',
      ['cache', 'add', ...specs, '--cache', cache, '--ignore-scripts'],
      {
        cwd: root,
        timeout: 120_000,
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          npm_config_userconfig: '/dev/null',
          npm_config_globalconfig: config,
          npm_config_registry: 'https://registry.npmjs.org',
          npm_config_update_notifier: 'false',
          npm_config_maxsockets: '2',
        },
      },
    );
    assert.equal(result.status, 0, 'Pinned public cache preparation');
    await verifyOpenCodeCache(cache, lock);
    console.log(JSON.stringify({ opencode: '1.19.0', cachedPackages: specs.length }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
