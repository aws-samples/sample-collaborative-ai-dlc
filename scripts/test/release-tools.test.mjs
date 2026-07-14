import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = join(root, 'scripts/install.sh');
const inspector = join(root, 'scripts/inspect-terraform-plan.mjs');

const run = (file, args, options = {}) =>
  spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

test('release check accepts prerelease metadata but final mode requires a date', () => {
  const prepared = run('node', ['scripts/release.mjs', 'check', '2.0.0-preview0']);
  assert.equal(prepared.status, 0, prepared.stderr);

  const final = run('node', ['scripts/release.mjs', 'check', '2.0.0-preview0', '--final']);
  assert.equal(final.status, 1);
  assert.match(final.stderr, /still has a TBD date/);
});

test('release preparation promotes preview metadata without losing changelog notes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidlc-release-'));
  mkdirSync(join(fixture, 'scripts'));
  cpSync(join(root, 'scripts/release.mjs'), join(fixture, 'scripts/release.mjs'));
  writeJson(join(fixture, 'package.json'), {
    name: 'aidlc',
    version: '2.0.0-preview0',
    private: true,
  });
  writeJson(join(fixture, 'package-lock.json'), {
    name: 'aidlc',
    version: '2.0.0-preview0',
    lockfileVersion: 3,
    packages: { '': { name: 'aidlc', version: '2.0.0-preview0' } },
  });
  writeFileSync(
    join(fixture, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n## [2.0.0-preview0] - 2026-07-14\n\n- Preview notes.\n',
  );

  execFileSync('node', ['scripts/release.mjs', 'prepare', '2.0.0'], { cwd: fixture });

  assert.equal(JSON.parse(readFileSync(join(fixture, 'package.json'))).version, '2.0.0');
  const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[2\.0\.0\] - TBD\n\n- Preview notes\./);
  assert.doesNotMatch(changelog, /2\.0\.0-preview0/);
});

test('Terraform plan inspection rejects protected deletion and allows the retired agent pool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-plan-'));
  const protectedPlan = join(dir, 'protected.json');
  const retiredPlan = join(dir, 'retired.json');
  writeJson(protectedPlan, {
    resource_changes: [
      {
        address: 'module.auth.aws_cognito_user_pool.main',
        type: 'aws_cognito_user_pool',
        change: { actions: ['delete', 'create'] },
      },
    ],
  });
  writeJson(retiredPlan, {
    resource_changes: [
      {
        address: 'module.agents.aws_dynamodb_table.agent_pool',
        type: 'aws_dynamodb_table',
        change: { actions: ['delete'] },
      },
    ],
  });

  const rejected = run('node', [inspector, protectedPlan]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /protected persistent resources/);

  const accepted = run('node', [inspector, retiredPlan]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Allowed retired v1 resource removal/);
});

test('installer lists prereleases by default in SemVer order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-tags-'));
  const tags = join(dir, 'tags');
  writeFileSync(tags, 'v2.0.0-preview1\nv1.1.0\nv2.0.0-preview0\nv2.0.0\ninvalid\n');
  const listed = run('bash', [installer, 'versions'], { env: { AIDLC_TAGS_FILE: tags } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), '1.1.0\n2.0.0-preview0\n2.0.0-preview1\n2.0.0');

  const compatibilityFlag = run('bash', [installer, 'versions', '--include-prereleases'], {
    env: { AIDLC_TAGS_FILE: tags },
  });
  assert.equal(compatibilityFlag.status, 0, compatibilityFlag.stderr);
  assert.equal(compatibilityFlag.stdout, listed.stdout);
});

const createReleaseRepository = () => {
  const repository = mkdtempSync(join(tmpdir(), 'aidlc-releases-'));
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  mkdirSync(join(repository, 'terraform/environments'), { recursive: true });
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  mkdirSync(join(repository, 'frontend'), { recursive: true });
  writeJson(join(repository, 'frontend/package.json'), { name: 'frontend', private: true });
  writeFileSync(
    join(repository, 'terraform/environments/dev.tfvars.example'),
    'environment = "dev"\naws_region = "us-east-1"\n',
  );
  writeFileSync(join(repository, 'scripts/bootstrap.sh'), '#!/usr/bin/env bash\nexit 99\n', {
    mode: 0o755,
  });
  writeFileSync(join(repository, 'scripts/deploy-terraform.sh'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  writeFileSync(join(repository, 'scripts/deploy-frontend.sh'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  writeJson(join(repository, 'package.json'), { name: 'aidlc', private: true });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'v1'], { cwd: repository });
  execFileSync('git', ['tag', 'v1.1.0'], { cwd: repository });

  writeJson(join(repository, 'package.json'), { name: 'aidlc', version: '2.0.0', private: true });
  execFileSync('git', ['add', 'package.json'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'v2'], { cwd: repository });
  execFileSync('git', ['branch', 'aidlc-v2'], { cwd: repository });
  execFileSync('git', ['tag', 'v2.0.0'], { cwd: repository });
  execFileSync('git', ['tag', 'v2.0.1'], { cwd: repository });
  return repository;
};

const managedEnv = (dir, repository) => {
  const data = join(dir, 'data');
  const config = join(dir, 'config');
  mkdirSync(join(config, 'collaborative-ai-dlc/terraform/environments'), { recursive: true });
  writeFileSync(
    join(config, 'collaborative-ai-dlc/terraform/environments/dev.tfvars'),
    'environment = "dev"\naws_region = "us-east-1"\n',
  );
  writeFileSync(
    join(config, 'collaborative-ai-dlc/terraform/environments/dev.s3.tfbackend'),
    'bucket = "test"\n',
  );
  return {
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    AIDLC_REPOSITORY_URL: repository,
    AIDLC_TEST_MODE: '1',
    AIDLC_YES: '1',
    AIDLC_ADMIN_USERNAME: 'admin@example.com',
    AIDLC_ADMIN_PASSWORD: 'NotStored123!',
  };
};

test('installer selects a newer preview release by default', () => {
  const repository = createReleaseRepository();
  writeJson(join(repository, 'package.json'), {
    name: 'aidlc',
    version: '2.1.0-preview0',
    private: true,
  });
  execFileSync('git', ['add', 'package.json'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'v2.1 preview'], { cwd: repository });
  execFileSync('git', ['tag', 'v2.1.0-preview0'], { cwd: repository });

  const dir = mkdtempSync(join(tmpdir(), 'aidlc-preview-'));
  const env = managedEnv(dir, repository);
  const installed = run('bash', [installer, 'install'], { env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(
    readlinkSync(join(env.XDG_DATA_HOME, 'collaborative-ai-dlc/current')),
    /releases\/v2\.1\.0-preview0$/,
  );
});

test('installer supports fresh install, v1 adoption, v1-to-v2 update, and recovery', () => {
  const repository = createReleaseRepository();

  const freshDir = mkdtempSync(join(tmpdir(), 'aidlc-fresh-'));
  const freshEnv = managedEnv(freshDir, repository);
  const fresh = run('bash', [installer, 'install', '--version', '2.0.0'], { env: freshEnv });
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshCurrent = readlinkSync(join(freshEnv.XDG_DATA_HOME, 'collaborative-ai-dlc/current'));
  assert.match(freshCurrent, /releases\/v2\.0\.0$/);
  const configText = execFileSync(
    'cat',
    [join(freshEnv.XDG_CONFIG_HOME, 'collaborative-ai-dlc/install.conf')],
    { encoding: 'utf8' },
  );
  assert.doesNotMatch(configText, /NotStored123/);

  const adoptDir = mkdtempSync(join(tmpdir(), 'aidlc-adopt-'));
  const adoptEnv = managedEnv(adoptDir, repository);
  const source = join(adoptDir, 'source');
  mkdirSync(join(source, 'terraform/environments'), { recursive: true });
  cpSync(
    join(adoptEnv.XDG_CONFIG_HOME, 'collaborative-ai-dlc/terraform/environments/dev.tfvars'),
    join(source, 'terraform/environments/dev.tfvars'),
  );
  cpSync(
    join(adoptEnv.XDG_CONFIG_HOME, 'collaborative-ai-dlc/terraform/environments/dev.s3.tfbackend'),
    join(source, 'terraform/environments/dev.s3.tfbackend'),
  );
  const adopted = run('bash', [installer, 'adopt', '--source', source, '--version', '1.1.0'], {
    env: adoptEnv,
  });
  assert.equal(adopted.status, 0, adopted.stderr);

  const updated = run('bash', [installer, 'update', '--version', '2.0.0'], { env: adoptEnv });
  assert.equal(updated.status, 0, updated.stderr);
  const updatedCurrent = readlinkSync(join(adoptEnv.XDG_DATA_HOME, 'collaborative-ai-dlc/current'));
  assert.match(updatedCurrent, /releases\/v2\.0\.0$/);

  const failed = run('bash', [installer, 'update', '--version', '2.0.1'], { env: adoptEnv });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /contains package version 2\.0\.0/);
  assert.equal(
    readlinkSync(join(adoptEnv.XDG_DATA_HOME, 'collaborative-ai-dlc/current')),
    updatedCurrent,
  );
});

test('installer refuses downgrades unless explicitly overridden', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-downgrade-'));
  const env = managedEnv(dir, repository);
  const installed = run('bash', [installer, 'install', '--version', '2.0.0'], { env });
  assert.equal(installed.status, 0, installed.stderr);

  const downgrade = run('bash', [installer, 'update', '--version', '1.1.0'], { env });
  assert.equal(downgrade.status, 1);
  assert.match(downgrade.stderr, /Refusing downgrade/);
});

test('installer tracks an explicitly selected branch by immutable commit', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-ref-'));
  const env = managedEnv(dir, repository);

  const installed = run('bash', [installer, 'install', '--ref', 'aidlc-v2'], { env });
  assert.equal(installed.status, 0, installed.stderr);
  const currentLink = join(env.XDG_DATA_HOME, 'collaborative-ai-dlc/current');
  const firstCheckout = readlinkSync(currentLink);
  assert.match(firstCheckout, /checkouts\/[0-9a-f]{40}$/);

  writeFileSync(join(repository, 'branch-update.txt'), 'next\n');
  execFileSync('git', ['add', 'branch-update.txt'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'branch update'], { cwd: repository });
  execFileSync('git', ['branch', '-f', 'aidlc-v2', 'HEAD'], { cwd: repository });

  const updated = run('bash', [installer, 'update'], { env });
  assert.equal(updated.status, 0, updated.stderr);
  const secondCheckout = readlinkSync(currentLink);
  assert.notEqual(secondCheckout, firstCheckout);
  assert.match(secondCheckout, /checkouts\/[0-9a-f]{40}$/);

  const status = run('bash', [installer, 'status'], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Source:\s+aidlc-v2@[0-9a-f]{12} \(non-release\)/);
});

const mockedCommandEnv = (dir, repository) => {
  const env = managedEnv(dir, repository);
  const bin = join(dir, 'bin');
  const awsLog = join(dir, 'aws.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
case "$*" in
  *" show -json "*) printf '{"resource_changes":[]}\\n' ;;
  *" state pull"*) printf '{}\\n' ;;
  *" output -raw user_pool_id"*) printf 'pool-1\\n' ;;
  *" output -raw user_pool_client_id"*) printf 'client-1\\n' ;;
  *" output -raw cloudfront_domain_name"*) printf 'example.invalid\\n' ;;
  *" output -raw s3_bucket_name"*) printf 'bucket-1\\n' ;;
  *" output -raw cloudfront_distribution_id"*) printf 'distribution-1\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AIDLC_AWS_LOG"
[[ "$*" == *"admin-get-user"* ]] && exit 1
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return {
    ...env,
    PATH: `${bin}:${process.env.PATH}`,
    AIDLC_AWS_LOG: awsLog,
    AIDLC_TEST_MODE: '',
  };
};

test('installer creates permanent administrators with v1 and v2 roles', () => {
  const repository = createReleaseRepository();

  const v2Dir = mkdtempSync(join(tmpdir(), 'aidlc-v2-admin-'));
  const v2Env = mockedCommandEnv(v2Dir, repository);
  const v2 = run('bash', [installer, 'install', '--version', '2.0.0'], { env: v2Env });
  assert.equal(v2.status, 0, v2.stderr);
  const v2Aws = execFileSync('cat', [v2Env.AIDLC_AWS_LOG], { encoding: 'utf8' });
  assert.match(v2Aws, /admin-create-user/);
  assert.match(v2Aws, /admin-set-user-password.*--permanent/);
  assert.match(v2Aws, /admin-add-user-to-group.*--group-name platform-admin/);

  const upgradeDir = mkdtempSync(join(tmpdir(), 'aidlc-v1-admin-'));
  const upgradeEnv = mockedCommandEnv(upgradeDir, repository);
  const v1 = run('bash', [installer, 'install', '--version', '1.1.0'], { env: upgradeEnv });
  assert.equal(v1.status, 0, v1.stderr);
  let upgradeAws = execFileSync('cat', [upgradeEnv.AIDLC_AWS_LOG], { encoding: 'utf8' });
  assert.match(upgradeAws, /admin-add-user-to-group.*--group-name owner/);

  writeFileSync(upgradeEnv.AIDLC_AWS_LOG, '');
  const update = run('bash', [installer, 'update', '--version', '2.0.0'], { env: upgradeEnv });
  assert.equal(update.status, 0, update.stderr);
  upgradeAws = execFileSync('cat', [upgradeEnv.AIDLC_AWS_LOG], { encoding: 'utf8' });
  assert.match(upgradeAws, /admin-add-user-to-group.*--group-name platform-admin/);
  assert.doesNotMatch(upgradeAws, /admin-set-user-password/);
});
