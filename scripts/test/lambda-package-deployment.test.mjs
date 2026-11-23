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
  symlinkSync,
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
    'scripts/initialize-native-space-inventory.mjs',
    'scripts/lib/native-dependencies.mjs',
    'scripts/test/helpers/native-space-inventory.mjs',
    'lambda/shared/native-runtime-binding.js',
    'lambda/shared/native-space-inventory.js',
    'scripts/deploy-frontend.sh',
    'scripts/generate-env.sh',
    'scripts/inspect-terraform-plan.mjs',
    'scripts/check-active-executions.mjs',
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
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  env.NATIVE_FIXTURE_FILE = join(directory, 'native.json');
  write(env.NATIVE_FIXTURE_FILE, '{}');
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
if (process.env.EXPECTED_AWS_PROFILE) {
  assert.equal(process.env.AWS_PROFILE, process.env.EXPECTED_AWS_PROFILE);
}
if (command === 'output') {
  assert.ok(fs.existsSync(${JSON.stringify(join(directory, 'applied'))}));
  const outputs = { environment: 'prod', aws_region: 'eu-central-1',
    user_pool_id: 'test-pool', user_pool_client_id: 'test-client', auth_mode: 'local',
    application_url: 'https://test.example.invalid', application_domain: 'test.example.invalid',
    s3_bucket_name: 'test-frontend', cloudfront_distribution_id: 'test-distribution',
    v2_executions_table_name: 'test-inventory', seed_blocks_lambda_name: 'test-seed', sso_providers: '[]' };
  if (args[1] === '-json' && args.length === 2) {
    const selected = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, {value}]));
    selected.private_output = {sensitive: true, value: 'unrelated-output-canary'};
    if (process.env.NATIVE_OUTPUT === 'enabled') selected.native_runtime_bindings_table_name = {value: 'test-native-runs-prod'};
    if (process.env.NATIVE_OUTPUT === 'null') selected.native_runtime_bindings_table_name = {value: null};
    if (process.env.NATIVE_OUTPUT === 'wrong-environment') selected.environment.value = 'dev';
    if (process.env.NATIVE_OUTPUT === 'malformed') selected.native_runtime_bindings_table_name = {};
    process.stdout.write(JSON.stringify(selected));
    if (process.env.NATIVE_OUTPUT === 'denied') process.exit(42);
  } else process.stdout.write(outputs[args.at(-1)] || '');
  process.exit(0);
}
fs.appendFileSync(process.env.EVENTS, command + '\\n');
assert.notEqual(process.env.TF_RECREATE_MISSING_LAMBDA_PACKAGE, 'false');
assert.equal(process.env.TF_INPUT, 'false');
if (process.env.PLAN_ONLY_FIXTURE !== '1') {
  const config = JSON.parse(fs.readFileSync(process.env.DOCKER_CONFIG + '/config.json'));
  assert.ok(config.auths['public.ecr.aws'].auth);
}
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
if [[ "$1" == */initialize-native-space-inventory.mjs ]]; then
  exec '${process.execPath}' --import '${join(directory, 'scripts/test/helpers/native-space-inventory.mjs')}' "$@"
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
  const result = deploy(fixture, { NATIVE_OUTPUT: 'enabled' });
  assert.equal(result.status, 0, result.stderr);
  const actions = events(fixture).filter(
    (event) => !/^native (table|alias|owner|get|writer)$/.test(event),
  );
  assert.deepEqual(actions, [
    'root-ci',
    'init',
    'plan',
    'show',
    'apply',
    'inventory',
    'seed',
    'native drain',
    'native scan',
    'native ready',
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
    const result = deploy(fixture, { FAIL_PHASE: phase, NATIVE_OUTPUT: 'enabled' });
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

test('separate apply cleans up a deposed native package through the authenticated script', (t) => {
  const fixture = deploymentFixture(t);
  const helper = {
    address: 'module.native_runs[0].module.packages["api"].local_file.archive_plan[0]',
    mode: 'managed',
    type: 'local_file',
    name: 'archive_plan',
  };
  write(
    fixture.env.PLAN_JSON,
    JSON.stringify({
      resource_changes: [
        {
          ...helper,
          change: { actions: ['no-op'], before: { id: 'current' }, after: { id: 'current' } },
        },
        {
          ...helper,
          deposed: '517e965e',
          change: { actions: ['delete'], before: { id: 'old' }, after: null },
        },
      ],
    }),
  );
  write(fixture.env.AIDLC_PLAN_FILE, 'saved plan');
  const result = run(
    fixture,
    'scripts/deploy-terraform.sh prod --phase apply --skip-seed --plan-file "$AIDLC_PLAN_FILE"',
    {
      AIDLC_KEEP_PLAN: '1',
      AWS_PROFILE: 'deployment-profile',
      EXPECTED_AWS_PROFILE: 'deployment-profile',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events(fixture), ['show', 'apply', 'inventory']);
  assert.equal(readFileSync(fixture.env.AIDLC_PLAN_FILE, 'utf8'), 'saved plan');
  assert.equal(readFileSync(fixture.env.ECR_TEST_LOG, 'utf8').split('\n')[0], 'login');
});

const applyArgs =
  'scripts/deploy-terraform.sh prod --phase apply --skip-seed --plan-file "$AIDLC_PLAN_FILE"';
const retryArgs = 'node scripts/initialize-native-space-inventory.mjs --applied-environment prod';
const existingNative = (fixture, state) => {
  const plan = JSON.parse(readFileSync(fixture.env.PLAN_JSON, 'utf8'));
  plan.prior_state = {
    values: {
      outputs: {
        environment: { value: 'prod' },
        aws_region: { value: 'eu-central-1' },
        native_runtime_bindings_table_name: { value: 'test-native-runs-prod' },
      },
    },
  };
  write(fixture.env.PLAN_JSON, JSON.stringify(plan));
  write(fixture.env.NATIVE_FIXTURE_FILE, JSON.stringify(state));
};

test('existing native installation with skip-seed closes stale legacy readiness before apply and resumes only bootstrap', (t) => {
  const fixture = deploymentFixture(t);
  const env = { NATIVE_OUTPUT: 'enabled', AWS_REGION: 'us-west-1' };
  existingNative(fixture, {
    historical: true,
    fault: 'partial',
    receipt: { pk: 'NATIVE_SPACE_INVENTORY', sk: 'BINDINGS_V1', version: 1 },
  });
  const plan = run(
    fixture,
    'scripts/deploy-terraform.sh prod --phase plan --plan-file "$AIDLC_PLAN_FILE"',
    { ...env, PLAN_ONLY_FIXTURE: '1' },
  );
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(!events(fixture).some((event) => event.startsWith('native ')));
  const failed = run(fixture, applyArgs, env);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Retry only native inventory[\s\S]*--applied-environment prod/);
  assert.equal(existsSync(fixture.env.AIDLC_PLAN_FILE), false);
  const state = JSON.parse(readFileSync(fixture.env.NATIVE_FIXTURE_FILE, 'utf8'));
  assert.equal(state.receipt.version, 0);
  assert.ok(events(fixture).indexOf('native pending') < events(fixture).indexOf('apply'));
  assert.ok(!events(fixture).includes('seed'));
  delete state.fault;
  write(fixture.env.NATIVE_FIXTURE_FILE, JSON.stringify(state));
  const retry = run(fixture, retryArgs, env);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /"bindings":1/);
  assert.equal(events(fixture).filter((event) => event === 'apply').length, 1);
  assert.ok(!events(fixture).includes('seed'));
  write(fixture.env.AIDLC_PLAN_FILE, 'saved plan');
  const start = events(fixture).length;
  const second = run(fixture, applyArgs, env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"alreadyReady":true/);
  const repeated = events(fixture).slice(start);
  assert.ok(repeated.includes('apply'));
  assert.ok(
    !repeated.some((event) =>
      ['native pending', 'native drain', 'native scan', 'native ready', 'seed'].includes(event),
    ),
  );
});

test('applied output lookup skips absent and null native services, rejects failures privately and provides a seed-free retry', (t) => {
  for (const output of ['absent', 'null', 'denied', 'wrong-environment', 'malformed']) {
    const fixture = deploymentFixture(t);
    write(fixture.env.AIDLC_PLAN_FILE, 'saved plan');
    const result = run(fixture, applyArgs, { NATIVE_OUTPUT: output });
    assert.equal(result.status, ['absent', 'null'].includes(output) ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /unrelated-output-canary/);
    assert.equal(existsSync(fixture.env.AIDLC_PLAN_FILE), false);
    assert.ok(!events(fixture).some((event) => event.startsWith('native ') || event === 'seed'));
  }
});

test('native table and alias access failures after apply recover without replaying apply or the requested seed', (t) => {
  for (const fault of ['table', 'alias', 'lost-ack']) {
    const fixture = deploymentFixture(t);
    write(fixture.env.NATIVE_FIXTURE_FILE, JSON.stringify({ fault }));
    const env = { NATIVE_OUTPUT: 'enabled' };
    const failed = deploy(fixture, env);
    assert.equal(failed.status, 1, failed.stderr);
    assert.ok(!events(fixture).includes('frontend-ci'));
    const state = JSON.parse(readFileSync(fixture.env.NATIVE_FIXTURE_FILE, 'utf8'));
    delete state.fault;
    write(fixture.env.NATIVE_FIXTURE_FILE, JSON.stringify(state));
    const retry = run(fixture, retryArgs, env);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(events(fixture).filter((event) => event === 'apply').length, 1);
    assert.equal(events(fixture).filter((event) => event === 'seed').length, 1);
    assert.equal(events(fixture).filter((event) => event === 'native drain').length, 1);
  }
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
