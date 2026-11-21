import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
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
  for (const dir of ['shared', 'native-runtime-control']) mkdirSync(join(root, 'lambda', dir));
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
  return { root, query, receipt, write, json, run };
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
  ['lambda/shared/new-production-file', /runtime file set/],
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

test('source SHA-1 concatenates file hashes in Terraform path order', (t) => {
  const f = fixture(t);
  const ordered = [
    ['agentcore/Dockerfile', 'FROM scratch\n'],
    ['agentcore/\ue000', 'BMP'],
    ['agentcore/\u{10000}', 'supplementary'],
    ['native-runtime-control/nested with spaces/input', 'nested'],
    ['shared/.hidden', 'hidden'],
  ];
  for (const [path, bytes] of ordered.toReversed()) f.write(`lambda/${path}`, bytes);
  f.write('lambda/agentcore/nested/.build/api/index.mjs', 'generated');
  symlinkSync('missing', join(f.root, 'lambda/agentcore/nested/.build/broken'));
  const result = spawnSync(
    process.execPath,
    [join(repo, 'scripts/agentcore-source-inventory.mjs')],
    {
      input: JSON.stringify({ source_path: f.query.source_path }),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const expected = hash(ordered.map(([, bytes]) => hash(bytes, 'sha1')).join(''), 'sha1');
  assert.equal(JSON.parse(result.stdout).source_sha1, expected);
});

// Use just the production image-source module and a local consumer. The CI
// Terraform init supplies the locked external provider. No registry is needed.
const mirror = join(repo, 'terraform/.terraform/providers');
const skipTerraform =
  !existsSync(mirror) && 'Run terraform init in terraform/ for saved-plan tests';
function terraformFixture(t) {
  const f = fixture(t);
  const module = 'terraform/modules/compute/agentcore';
  const cwd = join(f.root, module);
  mkdirSync(cwd, { recursive: true });
  for (const file of [
    `${module}/image-source.tf`,
    `${module}/runtime-source`,
    'scripts/agentcore-source-inventory.mjs',
    'scripts/qualified-arm64-image.mjs',
  ]) {
    mkdirSync(dirname(join(f.root, file)), { recursive: true });
    cpSync(join(repo, file), join(f.root, file), { recursive: true });
  }
  const lock = readFileSync(join(repo, 'terraform/.terraform.lock.hcl'), 'utf8');
  f.write(
    `${module}/.terraform.lock.hcl`,
    lock.match(/provider "registry\.terraform\.io\/hashicorp\/external" \{[^}]+\}/)[0],
  );
  f.write(
    `${module}/fixture.tf`,
    `
variable "enable_native_interaction_probe" { default = true }
variable "docker_build_args" { default = {} }
variable "native_image_qualification" {
  type = object({ path = string, sha256 = string })
  default = null
}
resource "terraform_data" "image" {
  input = { sha = local.agentcore_files_sha, tag = local.agentcore_image_tag, qualified = one(data.external.qualified_arm64[*].result) }
}
`,
  );
  const env = {
    PATH: process.env.PATH,
    HOME: f.root,
    GIT_CONFIG_NOSYSTEM: '1',
    TF_DATA_DIR: join(cwd, '.terraform'),
    CHECKPOINT_DISABLE: '1',
    TF_CLI_CONFIG_FILE: join(f.root, 'terraformrc'),
  };
  f.write(
    'terraformrc',
    `disable_checkpoint = true\nprovider_installation { filesystem_mirror { path = ${JSON.stringify(mirror)} } }\n`,
  );
  const tf = (command, args = [], error) => {
    const result = spawnSync('terraform', [command, ...args], { cwd, env, encoding: 'utf8' });
    if (error) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
    } else assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  tf('init', ['-input=false', '-lockfile=readonly']);
  function plan(error) {
    tf('plan', ['-no-color', '-input=false', '-out=image.tfplan'], error);
    if (!error)
      return JSON.parse(tf('show', ['-json', 'image.tfplan'])).resource_changes.find(
        (r) => r.address === 'terraform_data.image',
      ).change;
  }
  const apply = (error) => tf('apply', ['-no-color', '-input=false', 'image.tfplan'], error);
  const qualify = () =>
    f.json(`${module}/qualification.auto.tfvars.json`, {
      native_image_qualification: { path: f.query.receipt, sha256: f.query.sha256 },
    });
  return { ...f, plan, apply, qualify, module };
}

for (const qualified of [false, true]) {
  test(
    `saved ${qualified ? 'qualified' : 'ordinary'} image plan tolerates ZIP packaging churn`,
    { skip: skipTerraform },
    (t) => {
      const f = terraformFixture(t);
      if (qualified) f.qualify();
      const first = f.plan();
      assert.deepEqual(first.after.input, {
        sha: f.query.source_sha,
        tag: f.query.source_tag,
        qualified: qualified ? JSON.parse(f.run().stdout) : null,
      });
      const output = 'lambda/native-runtime-control/.build/api/index.mjs';
      f.write(output, 'packaged api');
      f.apply();
      assert.deepEqual(f.plan().actions, ['no-op']);
      f.write(output, 'rebundled api');
      f.write('lambda/native-runtime-control/.build/worker/worker.mjs', 'packaged worker');
      f.apply();
      assert.deepEqual(f.plan().actions, ['no-op']);
      rmSync(join(f.root, 'lambda/native-runtime-control/.build'), { recursive: true });
      f.apply();
      assert.deepEqual(f.plan().actions, ['no-op']);
    },
  );
}

test(
  'saved image plans reject changed production inputs and old qualifications',
  { skip: skipTerraform },
  (t) => {
    const f = terraformFixture(t);
    const dockerfile = 'lambda/agentcore/Dockerfile';
    const changed = /AgentCore image inputs changed after planning/;
    const mismatch = /ARM64 qualification mismatch/;
    // The historical excludes match directories. A regular file called 'test'
    // is a source input, even in a new untracked, Git-ignored directory.
    const extra = 'lambda/shared/new-package/test';
    f.write('.gitignore', extra + '\n');
    f.plan();
    f.write(extra, Buffer.from([0, 128, 255]));
    f.apply(changed);
    const added = f.plan().after.input.tag;
    assert.notEqual(added, f.query.source_tag);
    f.qualify();
    f.plan(mismatch);
    rmSync(join(f.root, extra));
    f.plan();
    f.write(dockerfile, 'FROM changed');
    f.apply(changed);
    f.plan(mismatch);
    rmSync(join(f.root, `${f.module}/qualification.auto.tfvars.json`));
    const edited = f.plan().after.input.tag;
    assert.notEqual(edited, f.query.source_tag);
    rmSync(join(f.root, dockerfile));
    f.apply(changed);
    const removed = f.plan().after.input.tag;
    assert.notEqual(removed, edited);
    assert.notEqual(removed, f.query.source_tag);
    f.qualify();
    f.plan(mismatch);
    f.write(dockerfile, 'FROM scratch\n');
    f.plan();
    chmodSync(join(f.root, dockerfile), 0o755);
    f.apply(changed);
    f.plan(mismatch);
    chmodSync(join(f.root, dockerfile), 0o644);
    f.plan();
    f.write('lambda/agentcore/test/local-e2e-harness.mjs', 'changed harness');
    f.apply(changed);
    f.plan(mismatch);
    symlinkSync(join(f.root, 'qualification.json'), join(f.root, extra));
    f.plan(/Unexpected runtime source entry/);
  },
);
