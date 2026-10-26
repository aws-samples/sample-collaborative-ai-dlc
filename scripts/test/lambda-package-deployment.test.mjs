import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stubPublicEcr } from './helpers/public-ecr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(join(root, '.github/workflows/deploy-demo.yml'), 'utf8');
const stepSource = (name) => workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
const step = (name) => {
  const source = stepSource(name);
  assert.ok(source, `Missing workflow step: ${name}`);
  const block = source.split('        run: |\n')[1];
  return block ? block.replace(/^          /gm, '') : source.split('        run: ')[1].trim();
};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o755 });
};
const temporary = (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aidlc deployment ')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const git = (directory, ...args) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const deploymentFixture = (t) => {
  const directory = temporary(t);
  for (const path of ['terraform', 'frontend', 'bin', 'tmp']) {
    mkdirSync(join(directory, path));
  }
  for (const file of [
    'scripts/deploy-terraform.sh',
    'scripts/deploy-frontend.sh',
    'scripts/generate-env.sh',
    'scripts/inspect-terraform-plan.mjs',
    'scripts/with-public-ecr-auth.mjs',
    'scripts/docker-proxy-build-args.mjs',
    'lambda/agentcore/Dockerfile',
    'lambda/yjs-server/Dockerfile',
  ]) {
    write(join(directory, file), readFileSync(join(root, file)));
  }
  write(
    join(directory, 'config/environments/prod.tfvars'),
    'environment = "prod"\nproject_name = "test"\naws_region = "eu-central-1"\n',
  );
  write(
    join(directory, 'config/environments/prod.s3.tfbackend'),
    'bucket = "test-state"\nkey = "main"\n',
  );
  const env = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    AIDLC_CONFIG_DIR: join(directory, 'config'),
    AIDLC_PLAN_FILE: join(directory, 'tmp/saved.tfplan'),
    RUNNER_TEMP: join(directory, 'tmp'),
    TF_ENVIRONMENT: 'prod',
    TF_INPUT: 'false',
    TF_IN_AUTOMATION: 'true',
    TF_VAR_docker_build_args: '{}',
    DEPLOY_REF_TYPE: 'commit',
    DOCKER_CONFIG: join(directory, 'docker'),
    DOCKER_BUILDKIT: '1',
    ECR_TEST_LOG: join(directory, 'auth-events'),
    EVENTS: join(directory, 'events'),
    PLAN_JSON: join(directory, 'plan.json'),
  };
  delete env.TF_RECREATE_MISSING_LAMBDA_PACKAGE;
  delete env.AIDLC_SKIP_NPM_CI;
  delete env.AIDLC_PUBLIC_ECR_AUTH_WRAPPED;
  write(
    env.PLAN_JSON,
    JSON.stringify({
      resource_changes: [
        {
          address: 'module.lambda.module.workflows_lambda.aws_lambda_function.this[0]',
          type: 'aws_lambda_function',
          change: {
            actions: ['update'],
            before: { filename: 'builds/old.zip' },
            after: {},
            // Real Terraform reproduction: a module-wide dependency defers archive_prepare.
            after_unknown: { filename: true, source_code_hash: true },
          },
        },
      ],
    }),
  );
  write(
    join(directory, 'bin/terraform'),
    `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
let args = process.argv.slice(2);
if (args[0].startsWith('-chdir=')) process.chdir(args.shift().slice(7));
const command = args[0];
assert.equal(process.cwd(), ${JSON.stringify(join(directory, 'terraform'))});
if (command === 'output') {
  assert.ok(fs.existsSync(${JSON.stringify(join(directory, 'applied'))}));
  const outputs = { environment: 'prod', aws_region: 'eu-central-1',
    user_pool_id: 'test-pool', user_pool_client_id: 'test-client', auth_mode: 'local',
    application_url: 'https://test.example.invalid', application_domain: 'test.example.invalid',
    s3_bucket_name: 'test-frontend', cloudfront_distribution_id: 'test-distribution',
    v2_executions_table_name: 'test-inventory', seed_blocks_lambda_name: 'test-seed', sso_providers: '[]' };
  process.stdout.write(outputs[args.at(-1)] || '');
  process.exit(0);
}
fs.appendFileSync(process.env.EVENTS, command + '\\n');
assert.notEqual(process.env.TF_RECREATE_MISSING_LAMBDA_PACKAGE, 'false');
assert.equal(process.env.TF_INPUT, 'false');
const config = JSON.parse(fs.readFileSync(process.env.DOCKER_CONFIG + '/config.json'));
assert.ok(config.auths['public.ecr.aws'].auth);
if (process.env.FAIL_PHASE === command) process.exit(42);
if (command === 'init') assert.ok(args.includes('-backend-config=' + process.env.AIDLC_CONFIG_DIR + '/environments/prod.s3.tfbackend'));
else if (command === 'plan') {
  assert.ok(args.includes('-var-file=' + process.env.AIDLC_CONFIG_DIR + '/environments/prod.tfvars'));
  assert.ok(args.includes('-out=' + process.env.AIDLC_PLAN_FILE));
  fs.writeFileSync(process.env.AIDLC_PLAN_FILE, 'saved plan');
} else if (command === 'show') {
  assert.deepEqual(args.slice(1), ['-json', process.env.AIDLC_PLAN_FILE]);
  process.stdout.write(fs.readFileSync(process.env.PLAN_JSON));
} else if (command === 'apply') {
  assert.deepEqual(args.slice(1), [process.env.AIDLC_PLAN_FILE]);
  assert.equal(fs.readFileSync(args[1], 'utf8'), 'saved plan');
  fs.writeFileSync(${JSON.stringify(join(directory, 'applied'))}, 'applied');
} else process.exit(98);
`,
  );
  write(
    join(directory, 'bin/npm'),
    `#!/bin/bash
set -eu
if [[ "$*" == 'ci --ignore-scripts' ]]; then
  [[ "$PWD" == */frontend ]] && echo frontend-ci >> "$EVENTS" || echo root-ci >> "$EVENTS"
elif [[ "$PWD" == */frontend && "$*" == 'run build' ]]; then
  [[ -f .env ]]
  echo frontend-build >> "$EVENTS"
  mkdir -p dist/assets
else exit 98
fi
`,
  );
  write(
    join(directory, 'bin/node'),
    `#!/bin/bash
if [[ "$1" == */initialize-agent-auth-inventory.mjs ]]; then
  echo inventory >> "$EVENTS"
  exit 0
fi
exec '${process.execPath}' "$@"
`,
  );
  write(
    join(directory, 'bin/aws'),
    `#!/bin/bash
set -eu
case "$1 $2" in
  'ecs describe-clusters') echo None ;;
  'lambda invoke') echo seed >> "$EVENTS"; echo None ;;
  's3 sync') [[ -d "$3" ]]; echo "upload $4" >> "$EVENTS" ;;
  'cloudfront create-invalidation') echo invalidate >> "$EVENTS" ;;
  *) exit 98 ;;
esac
`,
  );
  stubPublicEcr(join(directory, 'bin'));
  return { directory, env };
};
const run = ({ directory, env }, source, extraEnv = {}) =>
  spawnSync('bash', ['-e', '-c', source], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
const deploy = (fixture, env) =>
  run(fixture, `${step('Deploy infrastructure')}\n${step('Deploy frontend')}`, env);
const events = ({ env }) =>
  existsSync(env.EVENTS) ? readFileSync(env.EVENTS, 'utf8').trim().split('\n') : [];

test('MAIN runs one saved plan/apply through the scripts and hands outputs to the frontend', (t) => {
  const fixture = deploymentFixture(t);
  const result = deploy(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(fixture), [
    'root-ci',
    'init',
    'plan',
    'show',
    'apply',
    'inventory',
    'seed',
    'frontend-ci',
    'frontend-build',
    'upload s3://test-frontend/assets/',
    'upload s3://test-frontend',
    'invalidate',
  ]);
  assert.match(
    readFileSync(join(fixture.directory, 'frontend/.env'), 'utf8'),
    /VITE_API_BASE_URL="https:\/\/test.example.invalid\/api"/,
  );
  assert.equal(existsSync(fixture.env.AIDLC_PLAN_FILE), false);
  assert.equal(
    readFileSync(fixture.env.ECR_TEST_LOG, 'utf8')
      .split('\n')
      .filter((line) => line === 'login').length,
    1,
  );
});

test('plan/apply failures stop the two-command deployment before frontend publication', (t) => {
  for (const phase of ['plan', 'apply']) {
    const fixture = deploymentFixture(t);
    const result = deploy(fixture, { FAIL_PHASE: phase });
    assert.equal(result.status, 42, result.stderr);
    assert.equal(events(fixture).at(-1), phase);
    assert.equal(existsSync(join(fixture.directory, 'frontend/.env')), false);
  }
});

test('the script retains protected-resource destruction rejection before apply', (t) => {
  const fixture = deploymentFixture(t);
  write(
    fixture.env.PLAN_JSON,
    JSON.stringify({
      resource_changes: [
        {
          type: 'aws_dynamodb_table',
          address: 'aws_dynamodb_table.executions',
          change: { actions: ['delete'] },
        },
      ],
    }),
  );
  const result = deploy(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected persistent resources would be destroyed/);
  assert.equal(events(fixture).includes('apply'), false);
});

const olderRelease = (t) => {
  const fixture = deploymentFixture(t);
  const { directory, env } = fixture;
  const origin = temporary(t);
  const relativeInspector = 'scripts/inspect-terraform-plan.mjs';
  const deployPath = join(directory, 'scripts/deploy-terraform.sh');
  // Emulate a release that has the ordinary destruction guard but no auth wrapper.
  write(
    deployPath,
    readFileSync(deployPath, 'utf8').replace(/if \[\[ "\$PHASE" != "plan" &&[\s\S]*?\nfi\n/, ''),
  );
  rmSync(join(directory, 'scripts/with-public-ecr-auth.mjs'));
  copyFileSync(
    join(root, 'scripts/test/fixtures/inspect-terraform-plan-v2.2.0.mjs'),
    join(directory, relativeInspector),
  );
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Deployment test');
  git(directory, 'config', 'user.email', 'deployment-test@example.com');
  const commit = (cwd, message) => {
    git(cwd, 'add', 'scripts', 'lambda');
    git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const releaseSha = commit(directory, 'Older release');
  git(origin, 'clone', '--bare', directory, '.');
  git(directory, 'remote', 'add', 'origin', origin);
  write(
    join(directory, 'scripts/with-public-ecr-auth.mjs'),
    readFileSync(join(root, 'scripts/with-public-ecr-auth.mjs')),
  );
  const workflowSha = commit(directory, 'Workflow auth helper');
  write(
    join(directory, 'scripts/with-public-ecr-auth.mjs'),
    'throw new Error("Loaded mutable main");\n',
  );
  commit(directory, 'Newer main');
  git(directory, 'push', 'origin', 'main');
  git(directory, 'checkout', '--detach', releaseSha);
  env.WORKFLOW_SHA = workflowSha;
  env.DEPLOY_REF_TYPE = 'release-tag';
  env.GITHUB_SHA = releaseSha;
  assert.match(
    stepSource('Load release build authentication'),
    /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/,
  );
  assert.match(stepSource('Load release build authentication'), /if: .*release-tag/);
  const loaded = run(fixture, step('Load release build authentication'));
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(git(directory, 'rev-parse', 'HEAD'), releaseSha);
  assert.equal(git(directory, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(existsSync(join(directory, 'scripts/with-public-ecr-auth.mjs')), false);
  return fixture;
};

test('older releases use immutable workflow auth and their own ordinary plan inspector', (t) => {
  const fixture = olderRelease(t);
  const result = deploy(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(events(fixture).filter((event) => event === 'plan').length, 1);
  assert.equal(events(fixture).at(-1), 'invalidate');
});

test('older release auth failure stops before planning or applying', (t) => {
  for (const failure of [{ ECR_TEST_LOGIN_FAIL: '1' }, { ECR_TEST_HTTP_STATUS: '429' }]) {
    const fixture = olderRelease(t);
    const result = deploy(fixture, failure);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Public ECR (login failed|manifest check failed)/);
    assert.deepEqual(events(fixture), []);
  }
});
