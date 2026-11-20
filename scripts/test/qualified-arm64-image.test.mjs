import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const verifier = fileURLToPath(new URL('../qualified-arm64-image.mjs', import.meta.url));
const inspector = fileURLToPath(new URL('../inspect-terraform-plan.mjs', import.meta.url));
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qualified-arm64-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(path, text) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, { mode: 0o644 });
    return hash(text);
  }
  const json = (path, object) => write(path, JSON.stringify(object));
  for (const name of ['local-e2e-config.js', 'local-e2e-harness.mjs', 'helpers/v2-table.js']) {
    write(`lambda/agentcore/test/${name}`, 'harness');
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'lambda');
  const commit = git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    git('write-tree'),
    '-m',
    'fixture',
  );
  const path = 'lambda/agentcore/Dockerfile';
  const contents = 'FROM scratch\n';
  const file = { path, bytes: contents.length, mode: 0o644, sha256: write(path, contents) };
  const args = { ENABLE_NATIVE_INTERACTION_PROBE: 'true' };
  const source = hash(hash(contents, 'sha1'), 'sha1');
  const tag = hash(`${source}:true`, 'sha1').slice(0, 16);
  const manifest = {
    commit,
    builder: 'default',
    platform: 'linux/arm64',
    sourceTag: tag,
    runtimeSourceSha1: source,
    buildArgs: args,
    runtimeFiles: [file],
  };
  const manifestSha256 = json('image-qualification/runtime-source-manifest.json', manifest);
  const platform = { os: 'linux', architecture: 'arm64' };
  const configDigest = 'sha256:' + json('oci-identity/qualified-config.json', platform);
  const platformManifestDigest =
    'sha256:' +
    json('oci-identity/qualified-platform-manifest.json', { config: { digest: configDigest } });
  const localImageId =
    'sha256:' +
    json('oci-identity/qualified-index.json', {
      manifests: [{ platform, digest: platformManifestDigest }],
    });
  const receipt = {
    status: 'PASS_LOCAL_INSTALLED_ARM64',
    sourceCommit: commit,
    build: {
      args,
      exitCode: 0,
      observedCommit: commit,
      installed: { status: 'passed', sourceCommit: commit, files: 1, runtimeSource: source },
      sourceTag: tag,
      runtimeSourceSha1: source,
      manifestSha256,
      buildkitMetadataSha256: json('image-qualification/build/metadata.json', {
        'containerimage.digest': localImageId,
      }),
      inputs: { 'lambda/.dockerignore': write('lambda/.dockerignore', 'node_modules') },
    },
    qualification: { installedMatrix: 'passed' },
    image: {
      tag: `fixture:${tag}`,
      platform: 'linux/arm64',
      localImageId,
      platformManifestDigest,
      configDigest,
    },
  };
  const query = {
    receipt: join(root, 'qualification.json'),
    sha256: json('qualification.json', receipt),
    source_path: join(root, 'lambda'),
    source_sha: source,
    source_tag: tag,
  };
  const run = () =>
    spawnSync(process.execPath, [verifier], { input: JSON.stringify(query), encoding: 'utf8' });
  return { query, receipt, write, json, run };
}

test('only the reviewed installed build and its captured OCI chain can supply the publisher', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tag: f.receipt.image.tag,
    index: f.receipt.image.localImageId,
    arm64: f.receipt.image.platformManifestDigest,
  });
  f.receipt.image.localImageId = f.receipt.image.configDigest;
  f.json('qualification.json', f.receipt);
  assert.match(f.run().stderr, /qualification.json/);
  f.query.sha256 = f.json('qualification.json', f.receipt);
  assert.match(f.run().stderr, /BuildKit output index/);
});

for (const [file, error] of [
  ['lambda/agentcore/Dockerfile', /agentcore\/Dockerfile/],
  ['lambda/agentcore/test/helpers/v2-table.js', /helpers\/v2-table.js/],
  ['lambda/.dockerignore', /Docker context exclusions/],
  ['oci-identity/qualified-platform-manifest.json', /qualified-platform-manifest.json/],
]) {
  test(`refuses changed input ${file}`, (t) => {
    const f = fixture(t);
    f.write(file, 'changed');
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, '');
  });
}

test('a saved plan may use the legacy Yjs path only while its local build is a no-op', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'yjs-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'plan.json');
  const inspect = (actions, context) => {
    writeFileSync(
      file,
      JSON.stringify({
        variables: { yjs_legacy_build_context: { value: '/old/lambda/yjs-server' } },
        resource_changes: [
          {
            address: 'module.yjs_server.module.yjs_docker_build.docker_image.this',
            type: 'docker_image',
            change: { actions, after: { build: [{ context }] } },
          },
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, file], { encoding: 'utf8' });
  };
  assert.equal(inspect(['no-op'], '/old/lambda/yjs-server').status, 0);
  assert.match(
    inspect(['delete', 'create'], '/old/lambda/yjs-server').stderr,
    /Remove yjs_legacy_build_context/,
  );
  assert.equal(inspect(['delete', 'create'], '../lambda/yjs-server').status, 0);
});
