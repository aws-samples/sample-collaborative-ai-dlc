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

const releaseUrl = 'https://github.com/awslabs/aidlc-workflows/releases/download/v2.11.0';
const assets = {
  'aidlc-linux-arm64': {
    bytes: 85969192,
    sha256: '18e6fefcd3591aefd66d8a485fba5deaa870c6bbc6fd3e389d4b0b2032ce9f35',
  },
  'aidlc-runtime-2.11.0.tar.gz': {
    bytes: 19941355,
    sha256: '68906435223b47d6dfda59d79def78974d7b37e38b5649a56402a0007a41fad4',
  },
  'version.json': {
    bytes: 3660,
    sha256: '5711b7af08fc8c293576fdde9252b6b9fe13a7041f7db5f0dd33f6b56223c1e9',
  },
  'checksums.txt': {
    bytes: 926,
    sha256: 'c49098da9ce425afbc5c5beeaae395aa8480c6f887107b0b455cc1143cac2ac9',
  },
  'aidlc-release.intoto.jsonl': {
    bytes: 12672,
    sha256: '039d5043ab6fccd7fd6f436a6da5b3677f2a4a975ab1090bb86779a3b9b38e71',
  },
  'trusted-root.jsonl': {
    bytes: 34634,
    sha256: '65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c',
  },
};

async function verifyPinnedFiles(directory, pins) {
  for (const [name, pin] of Object.entries(pins)) {
    const path = join(directory, name);
    const stat = await fs.lstat(path);
    assert.ok(stat.isFile() && stat.size === pin.bytes, `Exact public fixture size: ${name}`);
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path))
        .digest('hex'),
      pin.sha256,
      `Exact public fixture digest: ${name}`,
    );
  }
}

export const verifyQualificationAssets = (directory) => verifyPinnedFiles(directory, assets);

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

export async function prepareQualificationPackage(root, source) {
  assert.ok(source, 'The installed tier requires attested release assets');
  await verifyQualificationAssets(source);
  const directory = `${root}/packages/2.11.0`;
  const tools = `${root}/tools`;
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  await fs.mkdir(tools);
  for (const name of Object.keys(assets).filter((name) => name !== 'trusted-root.jsonl'))
    await fs.copyFile(join(source, name), join(directory, name));
  const binaryPath = `${directory}/aidlc-linux-arm64`;
  await fs.chmod(binaryPath, 0o700);
  const gh = ['/usr/bin/gh', '/usr/local/bin/gh'].find(existsSync);
  assert.ok(gh, 'The immutable image must contain the installer verifier');
  // Both paths are fixed container paths, never user-supplied shell fragments.
  assert.equal(source, '/assets');
  await fs.writeFile(
    `${tools}/gh`,
    `#!/bin/sh\nexec ${gh} "$@" --custom-trusted-root /assets/trusted-root.jsonl\n`,
    { mode: 0o700 },
  );
  return { directory, binaryPath, tools, version: '2.11.0' };
}

async function prepareOpenCodeCache(cache) {
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Public artifacts only, bounded and verified before any installer uses them.
// A failed fetch never leaves a file that can masquerade as a completed input.
export async function downloadQualificationArtifact({ url, integrity, maxBytes, bytes }, path) {
  assert.ok(
    /^https:\/\/(?:github\.com\/awslabs\/aidlc-workflows\/releases\/download\/v2\.11\.0\/|registry\.npmjs\.org\/)/.test(
      url,
    ),
  );
  const [algorithm] = integrity.split('-');
  assert.ok(['sha256', 'sha512'].includes(algorithm));
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.ok, true, `Public fixture download failed: HTTP ${response.status}`);
  const file = await fs.open(path, 'wx', 0o600);
  try {
    const hash = createHash(algorithm);
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= maxBytes, 'Public fixture exceeds its byte bound');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes !== undefined) assert.equal(size, bytes, 'Public fixture exact byte count');
    assert.equal(`${algorithm}-${hash.digest('base64')}`, integrity, 'Public fixture integrity');
  } catch (error) {
    await fs.rm(path);
    throw error;
  } finally {
    await file.close();
  }
}

const linuxBindingName = '@rolldown/binding-linux-arm64-gnu';
// Exact unpacked files from the package-lock SHA-512 verified 1.1.5 archive.
// Reusing a prepared directory must verify executable bytes, not only its label.
const linuxBindingFiles = {
  'README.md': {
    bytes: 112,
    sha256: 'ac6d866d042c697683cb134124829f21b997f1dcf00dc69d33def096a3bb30b2',
  },
  'package.json': {
    bytes: 816,
    sha256: '6321e37fd886d191e1f0ce9e6478410b5c66a56a7594e0c063c7d6db4639523c',
  },
  'rolldown-binding.linux-arm64-gnu.node': {
    bytes: 17249480,
    sha256: '6755cfbd9ac1a01bf2c2bea157d0b477c5174e3991e2b2108053e30cdd5aa86c',
  },
};
async function linuxBindingPin() {
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url)));
  const pin = lock.packages[`node_modules/${linuxBindingName}`];
  assert.ok(
    pin?.integrity.startsWith('sha512-') && pin.resolved.startsWith('https://registry.npmjs.org/'),
  );
  assert.equal(pin.version, '1.1.5', 'Update verified fixture byte pins when the lock changes');
  return pin;
}

export async function verifyQualificationLinuxBindings(directory) {
  const pin = await linuxBindingPin();
  const module = join(directory, linuxBindingName);
  assert.ok((await fs.lstat(module)).isDirectory(), 'Real Linux binding directory');
  assert.deepEqual((await fs.readdir(module)).sort(), Object.keys(linuxBindingFiles).sort());
  await verifyPinnedFiles(module, linuxBindingFiles);
  const pkg = JSON.parse(await fs.readFile(join(module, 'package.json')));
  assert.equal(pkg.name, linuxBindingName);
  assert.equal(pkg.version, pin.version, 'Linux test binding matches the repository lock');
}

async function prepareLinuxBindings(root) {
  const pin = await linuxBindingPin();
  const archive = join(root, 'linux-binding.tgz');
  await downloadQualificationArtifact(
    { url: pin.resolved, integrity: pin.integrity, maxBytes: 64 * 1024 * 1024 },
    archive,
  );
  const install = join(root, 'linux-install');
  const config = join(root, 'linux.npmrc');
  await fs.writeFile(config, '');
  const result = spawnSync(
    'npm',
    [
      'install',
      '--prefix',
      install,
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      // The repository declares this platform binding optional. npm applies
      // target-platform selection to optional native packages on the host.
      '--save-optional',
      '--os=linux',
      '--cpu=arm64',
      '--libc=glibc',
      archive,
    ],
    {
      cwd: root,
      timeout: 120_000,
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        npm_config_cache: join(root, 'linux-npm-cache'),
        npm_config_userconfig: '/dev/null',
        npm_config_globalconfig: config,
        npm_config_update_notifier: 'false',
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `Offline Linux binding installation: ${result.error?.code ?? result.stderr?.toString().match(/npm error code ([A-Z_]+)/)?.[1] ?? 'failed'}`,
  );
  await fs.rename(join(install, 'node_modules'), join(root, 'linux-node-modules'));
  await verifyQualificationLinuxBindings(join(root, 'linux-node-modules'));
}

export async function verifyQualificationFixtures(root) {
  await verifyQualificationAssets(join(root, 'assets'));
  await verifyOpenCodeCache(join(root, 'opencode-cache'), await opencodeLock());
  await verifyQualificationLinuxBindings(join(root, 'linux-node-modules'));
}

export async function prepareQualificationFixtures(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false, 'Use a real fixture directory');
  assert.deepEqual(await fs.readdir(directory), [], 'Preparation requires an empty directory');
  const root = await fs.mkdtemp(join(directory, '.prepare-'));
  try {
    const target = join(root, 'assets');
    await fs.mkdir(target);
    for (const [name, pin] of Object.entries(assets)) {
      if (name === 'trusted-root.jsonl') {
        await fs.copyFile(
          new URL('./test/fixtures/native-qualification-trusted-root.jsonl', import.meta.url),
          join(target, name),
        );
      } else {
        await downloadQualificationArtifact(
          {
            url: `${releaseUrl}/${name}`,
            integrity: `sha256-${Buffer.from(pin.sha256, 'hex').toString('base64')}`,
            bytes: pin.bytes,
            maxBytes: pin.bytes,
          },
          join(target, name),
        );
      }
    }
    await verifyQualificationAssets(target);
    console.log(JSON.stringify({ preparation: 'public-release-assets', verifiedArtifacts: 6 }));
    await prepareOpenCodeCache(join(root, 'opencode-cache'));
    console.log(JSON.stringify({ preparation: 'opencode-cache', verifiedArtifacts: 32 }));
    await prepareLinuxBindings(root);
    await verifyQualificationFixtures(root);
    for (const name of ['assets', 'opencode-cache', 'linux-node-modules'])
      await fs.rename(join(root, name), join(directory, name));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Explicit preparation is the only path that fetches public fixtures. Offline
// verification and ordinary qualification never fetch or pull an image.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 4);
  const directory = resolve(process.argv[3]);
  if (process.argv[2] === '--prepare-opencode-cache') await prepareOpenCodeCache(directory);
  else if (process.argv[2] === '--prepare-fixtures') await prepareQualificationFixtures(directory);
  else {
    assert.equal(process.argv[2], '--verify-fixtures');
    await verifyQualificationFixtures(directory);
  }
  console.log(
    JSON.stringify({
      operation: process.argv[2],
      directory,
      node: process.version,
      ...(process.argv[2] === '--prepare-opencode-cache'
        ? {}
        : { aidlc: '2.11.0', linuxBinding: (await linuxBindingPin()).version }),
      opencode: '1.19.0',
      cachedPackages: 32,
    }),
  );
}
