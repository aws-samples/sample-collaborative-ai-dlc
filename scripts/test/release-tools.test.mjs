import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = join(root, 'scripts/install.sh');
const inspector = join(root, 'scripts/inspect-terraform-plan.mjs');
const deployFrontend = join(root, 'scripts/deploy-frontend.sh');
const deployTerraform = join(root, 'scripts/deploy-terraform.sh');
const destroyTerraform = join(root, 'scripts/destroy.sh');
const generateEnv = join(root, 'scripts/generate-env.sh');
const releaseWorkflow = join(root, '.github/workflows/release.yml');
const demoWorkflow = join(root, '.github/workflows/deploy-demo.yml');

const run = (file, args, options = {}) =>
  spawnSync(file, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

test('current release metadata is internally consistent', () => {
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const checked = run('node', ['scripts/release.mjs', 'check', version]);
  assert.equal(checked.status, 0, checked.stderr);
});

test('release deployment uses the protected demo environment and GitHub OIDC', () => {
  const release = readFileSync(releaseWorkflow, 'utf8');
  const deployment = readFileSync(demoWorkflow, 'utf8');

  assert.match(release, /uses: \.\/\.github\/workflows\/deploy-demo\.yml/);
  assert.match(release, /ref: v\$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(release, /apply:/);

  assert.match(deployment, /name: demo/);
  assert.match(deployment, /id-token: write/);
  assert.match(deployment, /TF_ENVIRONMENT: prod/);
  assert.match(deployment, /TF_RECREATE_MISSING_LAMBDA_PACKAGE: 'false'/);
  assert.match(deployment, /role-to-assume: \$\{\{ vars\.AWS_ROLE_ARN \}\}/);
  assert.match(deployment, /TF_STATE_BUCKET: \$\{\{ vars\.TF_STATE_BUCKET \}\}/);
  assert.match(deployment, /docker\/setup-qemu-action@[0-9a-f]{40}/);
  assert.match(deployment, /platforms: arm64/);
  assert.match(deployment, /python3 "\$package_script" build --timestamp 0/);
  assert.match(deployment, /AIDLC_SKIP_NPM_CI: '1'/);
  assert.match(deployment, /deploy-terraform\.sh "\$TF_ENVIRONMENT"/);
  assert.match(deployment, /deploy-frontend\.sh "\$TF_ENVIRONMENT"/);
  assert.match(deployment, /git merge-base --is-ancestor "\$tag_commit" "\$main_commit"/);
  assert.equal(deployment.match(/--phase plan/g)?.length, 2);
  assert.doesNotMatch(deployment, /inputs\.apply|plan-only/);
  assert.doesNotMatch(deployment, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.ok(
    deployment.indexOf('git merge-base --is-ancestor') <
      deployment.indexOf('aws-actions/configure-aws-credentials'),
    'release ancestry must be verified before AWS credentials are configured',
  );
  assert.ok(
    deployment.indexOf('docker/setup-qemu-action') <
      deployment.indexOf('deploy-terraform.sh "$TF_ENVIRONMENT"'),
    'ARM64 emulation must be configured before Terraform builds the AgentCore image',
  );
  assert.ok(
    deployment.indexOf('- name: Prepare Lambda package plans') <
      deployment.indexOf('- name: Build Lambda packages') &&
      deployment.indexOf('- name: Build Lambda packages') <
        deployment.indexOf('- name: Plan infrastructure') &&
      deployment.indexOf('- name: Plan infrastructure') <
        deployment.indexOf('- name: Apply infrastructure'),
    'Lambda packages must be built before the final saved plan is applied',
  );
});

test('deployment scripts enforce locked dependencies without install hooks', () => {
  const terraformDeployment = readFileSync(deployTerraform, 'utf8');
  const frontendDeployment = readFileSync(deployFrontend, 'utf8');

  assert.match(terraformDeployment, /npm ci --ignore-scripts/);
  assert.match(terraformDeployment, /terraform init -lockfile=readonly/);
  assert.match(frontendDeployment, /npm ci --ignore-scripts/);
});

test('release check accepts prerelease metadata but final mode requires a date', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidlc-release-check-'));
  const version = '2.0.0-preview0';
  mkdirSync(join(fixture, 'scripts'));
  cpSync(join(root, 'scripts/release.mjs'), join(fixture, 'scripts/release.mjs'));
  writeJson(join(fixture, 'package.json'), { name: 'aidlc', version, private: true });
  writeJson(join(fixture, 'package-lock.json'), {
    name: 'aidlc',
    version,
    lockfileVersion: 3,
    packages: { '': { name: 'aidlc', version } },
  });
  writeFileSync(
    join(fixture, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - TBD\n`,
  );

  const prepared = run('node', ['scripts/release.mjs', 'check', version], { cwd: fixture });
  assert.equal(prepared.status, 0, prepared.stderr);

  const final = run('node', ['scripts/release.mjs', 'check', version, '--final'], { cwd: fixture });
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

test('frontend env generation requires a domain and uses application_url', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidlc-generate-env-'));
  const bin = join(fixture, 'bin');
  const script = join(fixture, 'scripts/generate-env.sh');
  const config = join(fixture, 'config');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'terraform'), { recursive: true });
  mkdirSync(join(fixture, 'frontend'), { recursive: true });
  mkdirSync(join(config, 'environments'), { recursive: true });
  cpSync(generateEnv, script);
  writeFileSync(join(config, 'environments/dev.tfvars'), 'environment = "dev"\n');
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
case "$*" in
  "output -raw environment") printf 'dev\\n' ;;
  "output -raw aws_region") printf 'eu-central-1\\n' ;;
  "output -raw user_pool_id") printf 'eu-central-1_pool-1\\n' ;;
  "output -raw user_pool_client_id") printf 'client-1\\n' ;;
  "output -raw application_url") printf '%s\\n' "\${AIDLC_FAKE_APP_URL:-}" ;;
  "output -raw application_domain") printf '%s\\n' "\${AIDLC_FAKE_APP_DOMAIN:-}" ;;
  "output -raw cloudfront_domain_name") printf '%s\\n' "\${AIDLC_FAKE_CLOUDFRONT_DOMAIN:-}" ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    AIDLC_CONFIG_DIR: config,
  };

  const missing = run('bash', [script, 'dev'], { cwd: fixture, env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Terraform application domain not available/);
  assert.equal(existsSync(join(fixture, 'frontend/.env')), false);

  const generated = run('bash', [script, 'dev'], {
    cwd: fixture,
    env: {
      ...env,
      AIDLC_FAKE_APP_DOMAIN: 'app.example.com',
      AIDLC_FAKE_APP_URL: 'https://canonical.example.com',
    },
  });
  assert.equal(generated.status, 0, generated.stderr);
  const contents = readFileSync(join(fixture, 'frontend/.env'), 'utf8');
  assert.match(contents, /^VITE_APP_ORIGIN="https:\/\/canonical\.example\.com"$/m);
  assert.match(contents, /^VITE_WEBSOCKET_URL=wss:\/\/app\.example\.com\/ws$/m);
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

test('standalone Terraform deployment ends with the application URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-summary-'));
  const bin = join(dir, 'bin');
  const config = join(dir, 'config/environments');
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, 'summary.tfvars'),
    'environment = "summary"\nproject_name = "aidlc"\naws_region = "eu-west-1"\n',
  );
  writeFileSync(join(config, 'summary.s3.tfbackend'), 'bucket = "state"\nkey = "state"\n');
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
case "$*" in
  *"plan "*)
    for arg in "$@"; do
      [[ "$arg" == -out=* ]] && : > "\${arg#-out=}"
    done
    ;;
  *"show -json "*) printf '{"resource_changes":[]}\\n' ;;
  *" output -raw application_url"*) printf 'https://app.example.invalid\\n' ;;
  *" output -raw aws_region"*) printf 'eu-west-1\\n' ;;
  *" output -raw environment"*) printf 'summary\\n' ;;
  *" output -raw seed_blocks_lambda_name"*) printf 'seed-summary\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
if [[ "$*" == *"ecs describe-clusters"* ]]; then
  printf 'None\\n'
  exit 0
fi
if [[ "$*" == *"lambda invoke"* ]]; then
  for arg in "$@"; do
    [[ "$arg" == */aidlc-seed.* ]] && printf '{}\\n' > "$arg"
  done
  printf 'None\\n'
fi
`,
    { mode: 0o755 },
  );

  const deployed = run(
    'bash',
    [deployTerraform, 'summary', '--plan-file', join(dir, 'summary.tfplan')],
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        AIDLC_CONFIG_DIR: join(dir, 'config'),
        AIDLC_SKIP_NPM_CI: '1',
      },
    },
  );

  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /Infrastructure deployment complete/);
  assert.match(deployed.stdout, /Environment:\s+summary/);
  assert.match(deployed.stdout, /Region:\s+eu-west-1/);
  assert.match(deployed.stdout, /Application URL:\s+https:\/\/app\.example\.invalid/);
  assert.match(deployed.stdout, /Next step:.*deploy-frontend\.sh summary/);
});

// Mocked terraform + aws for standalone deploy runs. Records every terraform
// invocation so argument passthrough can be asserted, and answers the outputs
// the deployment summary reads.
const standaloneDeployEnv = (dir, { customDomain = false } = {}) => {
  const bin = join(dir, 'bin');
  const config = join(dir, 'config/environments');
  const terraformLog = join(dir, 'terraform.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, 'summary.tfvars'),
    [
      'environment = "summary"',
      'project_name = "aidlc"',
      'aws_region = "eu-west-1"',
      'app_domain = ""',
      '',
    ].join('\n'),
  );
  writeFileSync(join(config, 'summary.s3.tfbackend'), 'bucket = "state"\nkey = "state"\n');
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AIDLC_TERRAFORM_LOG"
case "$*" in
  *"plan "*)
    for arg in "$@"; do
      [[ "$arg" == -out=* ]] && : > "\${arg#-out=}"
    done
    ;;
  *"show -json "*) printf '{"resource_changes":[]}\\n' ;;
  *" output -json application_aliases"*)
    printf '%s\\n' "\${AIDLC_FAKE_ALIASES:-[]}"
    ;;
  *" output -raw application_url"*) printf '%s\\n' "\${AIDLC_FAKE_APP_URL:-https://app.example.invalid}" ;;
  *" output -raw application_domain"*) printf '%s\\n' "\${AIDLC_FAKE_APP_DOMAIN:-app.example.invalid}" ;;
  *" output -raw custom_domain_enabled"*) printf '%s\\n' "\${AIDLC_FAKE_CUSTOM_DOMAIN:-false}" ;;
  *" output -raw dns_managed_by_terraform"*) printf '%s\\n' "\${AIDLC_FAKE_DNS_MANAGED:-false}" ;;
  *" output -raw dns_target"*) printf '%s\\n' "\${AIDLC_FAKE_DNS_TARGET:-d111111abcdef8.cloudfront.net}" ;;
  *" output -raw auth_mode"*) printf '%s\\n' "\${AIDLC_FAKE_AUTH_MODE:-local}" ;;
  *" output -json sso_providers"*) printf '%s\\n' "\${AIDLC_FAKE_SSO_PROVIDERS:-[]}" ;;
  *" output -raw oidc_idp_callback_url"*) printf 'https://broker.example.invalid/oauth2/idpresponse\\n' ;;
  *" output -raw saml_acs_url"*) printf 'https://broker.example.invalid/saml2/idpresponse\\n' ;;
  *" output -raw saml_entity_id"*) printf 'urn:amazon:cognito:sp:eu-west-1_pool\\n' ;;
  *" output -raw aws_region"*) printf 'eu-west-1\\n' ;;
  *" output -raw environment"*) printf 'summary\\n' ;;
  *" output -raw seed_blocks_lambda_name"*) printf 'seed-summary\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
if [[ "$*" == *"ecs describe-clusters"* ]]; then
  printf 'None\\n'
  exit 0
fi
if [[ "$*" == *"lambda invoke"* ]]; then
  for arg in "$@"; do
    [[ "$arg" == */aidlc-seed.* ]] && printf '{}\\n' > "$arg"
  done
  printf 'None\\n'
fi
`,
    { mode: 0o755 },
  );

  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      AIDLC_CONFIG_DIR: join(dir, 'config'),
      AIDLC_SKIP_NPM_CI: '1',
      AIDLC_TERRAFORM_LOG: terraformLog,
      ...(customDomain
        ? {
            AIDLC_FAKE_CUSTOM_DOMAIN: 'true',
            AIDLC_FAKE_APP_DOMAIN: 'aidlc.example.com',
            AIDLC_FAKE_APP_URL: 'https://aidlc.example.com',
            AIDLC_FAKE_ALIASES: '["aidlc.example.com","www.aidlc.example.com"]',
          }
        : {}),
    },
    terraformLog,
    planFile: join(dir, 'summary.tfplan'),
  };
};

test('standalone deployment forwards --var overrides to terraform plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-var-'));
  const { env, terraformLog, planFile } = standaloneDeployEnv(dir);

  const deployed = run(
    'bash',
    [
      deployTerraform,
      'summary',
      '--plan-file',
      planFile,
      '--var',
      'app_domain=aidlc.example.com',
      '--var',
      'route53_zone_id=Z1234567890ABC',
    ],
    { env },
  );
  assert.equal(deployed.status, 0, deployed.stderr);

  // -var must reach the plan; terraform ranks it above -var-file, which is why
  // it can override a key the tfvars already sets.
  const planLine = readFileSync(terraformLog, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('plan '));
  assert.ok(planLine, 'expected a terraform plan invocation');
  assert.match(planLine, /-var-file=\S+summary\.tfvars/);
  assert.match(planLine, /-var app_domain=aidlc\.example\.com/);
  assert.match(planLine, /-var route53_zone_id=Z1234567890ABC/);
});

test('standalone deployment omits --var entirely when none are given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-novar-'));
  const { env, terraformLog, planFile } = standaloneDeployEnv(dir);

  const deployed = run('bash', [deployTerraform, 'summary', '--plan-file', planFile], { env });
  assert.equal(deployed.status, 0, deployed.stderr);

  const planLine = readFileSync(terraformLog, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('plan '));
  assert.doesNotMatch(planLine, /-var /);
});

test('standalone deployment rejects malformed and misplaced --var', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-badvar-'));
  const { env, planFile } = standaloneDeployEnv(dir);

  const malformed = run('bash', [deployTerraform, 'summary', '--var', 'notakeyvalue'], { env });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /--var expects KEY=VALUE/);

  // A saved plan already has its variables baked in; terraform refuses -var there.
  const onApply = run(
    'bash',
    [
      deployTerraform,
      'summary',
      '--phase',
      'apply',
      '--plan-file',
      planFile,
      '--var',
      'app_domain=x',
    ],
    { env },
  );
  assert.equal(onApply.status, 2);
  assert.match(onApply.stderr, /--var applies at plan time/);
});

test('standalone deployment accepts SSO flags and embeds normalized providers in the plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-sso-'));
  const { env, terraformLog, planFile } = standaloneDeployEnv(dir);
  const ssoConfig = join(dir, 'sso.json');
  writeJson(ssoConfig, {
    providers: [
      {
        name: 'CorporateOIDC',
        displayName: 'Corporate identity',
        type: 'oidc',
        issuerUrl: 'https://idp.example.com',
        clientId: 'client-id',
        clientSecretArn: 'arn:aws:secretsmanager:eu-west-1:111122223333:secret:aidlc/oidc-AbCdEf',
        claims: { email: 'email', name: 'name', roles: 'groups' },
        roleMappings: { 'platform-admin': ['aidlc-admin'] },
        requiredClaimValues: ['aidlc-user'],
      },
    ],
  });

  const deployed = run(
    'bash',
    [
      deployTerraform,
      'summary',
      '--plan-file',
      planFile,
      '--auth-mode',
      'hybrid',
      '--sso-config',
      ssoConfig,
    ],
    {
      env: {
        ...env,
        AIDLC_FAKE_AUTH_MODE: 'hybrid',
        AIDLC_FAKE_SSO_PROVIDERS:
          '[{"name":"CorporateOIDC","displayName":"Corporate identity","type":"oidc"}]',
      },
    },
  );
  assert.equal(deployed.status, 0, deployed.stderr);

  const planLine = readFileSync(terraformLog, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('plan '));
  assert.match(planLine, /-var auth_mode=hybrid/);
  assert.match(planLine, /-var sso_providers=.*CorporateOIDC/);
  assert.match(planLine, /role_mappings.*platform-admin/);
  assert.match(deployed.stdout, /Authentication:\s+hybrid/);
  assert.match(deployed.stdout, /SSO providers:\s+Corporate identity/);
  assert.match(deployed.stdout, /OIDC callback:\s+https:\/\/broker\.example\.invalid/);
  assert.match(deployed.stdout, /SAML entity ID:\s+urn:amazon:cognito:sp:eu-west-1_pool/);
});

test('standalone deployment reads managed SSO tfvars and rejects SSO flags on saved-plan apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-sso-tfvars-'));
  const { env, terraformLog, planFile } = standaloneDeployEnv(dir);
  writeJson(join(dir, 'config/environments/summary.sso.tfvars.json'), {
    auth_mode: 'hybrid',
    sso_providers: {},
  });

  const planned = run(
    'bash',
    [deployTerraform, 'summary', '--phase', 'plan', '--plan-file', planFile],
    { env },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const planLine = readFileSync(terraformLog, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('plan '));
  assert.match(planLine, /-var-file=\S+summary\.sso\.tfvars\.json/);

  const rejected = run(
    'bash',
    [
      deployTerraform,
      'summary',
      '--phase',
      'apply',
      '--plan-file',
      planFile,
      '--auth-mode',
      'local',
    ],
    { env },
  );
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /apply at plan time/);
});

test('frontend environment generation preserves enterprise provider labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-generate-env-sso-'));
  const bin = join(dir, 'bin');
  const scripts = join(dir, 'scripts');
  const config = join(dir, 'config/environments');
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(join(dir, 'terraform'));
  mkdirSync(join(dir, 'frontend'));
  cpSync(generateEnv, join(scripts, 'generate-env.sh'));
  writeFileSync(join(config, 'summary.tfvars'), 'environment = "summary"\n');
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
case "$*" in
  *"output -raw environment"*) printf 'summary\\n' ;;
  *"output -raw aws_region"*) printf 'eu-west-1\\n' ;;
  *"output -raw user_pool_id"*) printf 'eu-west-1_pool\\n' ;;
  *"output -raw user_pool_client_id"*) printf 'client-id\\n' ;;
  *"output -raw auth_mode"*) printf 'hybrid\\n' ;;
  *"output -raw cognito_hosted_ui_domain"*) printf 'https://broker.example.invalid\\n' ;;
  *"output -raw auth_callback_url"*) printf 'https://app.example.invalid/auth/callback\\n' ;;
  *"output -json sso_providers"*) printf '%s\\n' "$AIDLC_FAKE_SSO_PROVIDERS" ;;
  *"output -raw application_domain"*) printf 'app.example.invalid\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  const providers = [
    {
      name: 'CorporateOIDC',
      displayName: "Company's identity",
      type: 'oidc',
    },
  ];

  const generated = run('bash', [join(scripts, 'generate-env.sh'), 'summary'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      AIDLC_CONFIG_DIR: join(dir, 'config'),
      AIDLC_FAKE_SSO_PROVIDERS: JSON.stringify(providers),
    },
  });
  assert.equal(generated.status, 0, generated.stderr);

  const envText = readFileSync(join(dir, 'frontend/.env'), 'utf8');
  const encoded = envText.match(/^VITE_SSO_PROVIDERS=(.+)$/m)?.[1];
  assert.ok(encoded?.startsWith('uri:'));
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded.slice(4))), providers);
  assert.match(envText, /^VITE_AUTH_MODE=hybrid$/m);
  assert.match(
    envText,
    /^VITE_AUTH_CALLBACK_URL="https:\/\/app\.example\.invalid\/auth\/callback"$/m,
  );
});

test('standalone deployment summary reports the custom domain and external DNS records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-domain-'));
  const { env, planFile } = standaloneDeployEnv(dir, { customDomain: true });

  const deployed = run('bash', [deployTerraform, 'summary', '--plan-file', planFile], { env });
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /Application URL:\s+https:\/\/aidlc\.example\.com/);
  assert.match(deployed.stdout, /Custom domain:\s+aidlc\.example\.com/);
  assert.match(deployed.stdout, /DNS is managed outside this deployment/);
  assert.match(deployed.stdout, /aidlc\.example\.com\s+A\s+-> d111111abcdef8\.cloudfront\.net/);
  assert.match(deployed.stdout, /aidlc\.example\.com\s+AAAA\s+-> d111111abcdef8\.cloudfront\.net/);
  assert.match(
    deployed.stdout,
    /www\.aidlc\.example\.com\s+A\s+-> d111111abcdef8\.cloudfront\.net/,
  );
});

test('standalone deployment summary stays quiet about DNS when Terraform manages it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-deploy-domain-r53-'));
  const { env, planFile } = standaloneDeployEnv(dir, { customDomain: true });

  const deployed = run('bash', [deployTerraform, 'summary', '--plan-file', planFile], {
    env: { ...env, AIDLC_FAKE_DNS_MANAGED: 'true' },
  });
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.match(deployed.stdout, /Custom domain:\s+aidlc\.example\.com/);
  assert.doesNotMatch(deployed.stdout, /DNS is managed outside/);
});

test('standalone destroy supports custom local environments and backs up state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-destroy-'));
  const bin = join(dir, 'bin');
  const config = join(dir, 'config/environments');
  const backups = join(dir, 'backups');
  const terraformLog = join(dir, 'terraform.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'local-test.tfvars'), 'environment = "local-test"\n');
  writeFileSync(
    join(config, 'local-test.s3.tfbackend'),
    'bucket = "local-test-state"\nkey = "state"\n',
  );
  writeFileSync(
    join(bin, 'terraform'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TERRAFORM_LOG"
[[ "$*" == *" state pull"* ]] && printf '{"version":4}\\n'
exit 0
`,
    { mode: 0o755 },
  );

  const destroyed = run('bash', [destroyTerraform, 'local-test', '--yes'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      AIDLC_CONFIG_DIR: join(dir, 'config'),
      AIDLC_BACKUP_DIR: backups,
      TERRAFORM_LOG: terraformLog,
    },
  });

  assert.equal(destroyed.status, 0, destroyed.stderr);
  assert.match(destroyed.stdout, /Environment destruction complete/);
  assert.match(destroyed.stdout, /State bucket:\s+s3:\/\/local-test-state \(retained\)/);
  assert.equal(readdirSync(backups).length, 1);
  assert.match(readFileSync(join(backups, readdirSync(backups)[0]), 'utf8'), /"version":4/);
  const commands = readFileSync(terraformLog, 'utf8');
  assert.match(commands, /init -reconfigure/);
  assert.match(commands, /state pull/);
  assert.match(commands, /destroy .*local-test\.tfvars -auto-approve/);
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

test('installer rejects --no-domain combined with domain configuration flags', () => {
  const certificate = 'arn:aws:acm:us-east-1:111122223333:certificate/abc-123';
  const conflicts = [
    ['--no-domain', '--certificate-arn', certificate],
    ['--domain', 'aidlc.example.com', '--hosted-zone-id', 'Z1', '--no-domain'],
  ];

  for (const args of conflicts) {
    const result = run('bash', [installer, 'install', ...args]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--no-domain cannot be combined/);
  }
});

const createReleaseRepository = () => {
  const repository = mkdtempSync(join(tmpdir(), 'aidlc-releases-'));
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  mkdirSync(join(repository, 'terraform/environments'), { recursive: true });
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  mkdirSync(join(repository, 'config'), { recursive: true });
  mkdirSync(join(repository, 'frontend'), { recursive: true });
  cpSync(join(root, 'scripts/sso-config.mjs'), join(repository, 'scripts/sso-config.mjs'));
  cpSync(join(root, 'config/platform-roles.json'), join(repository, 'config/platform-roles.json'));
  writeJson(join(repository, 'frontend/package.json'), { name: 'frontend', private: true });
  writeFileSync(
    join(repository, 'terraform/environments/dev.tfvars.example'),
    [
      'environment = "dev"',
      'aws_region = "us-east-1"',
      'app_domain          = ""',
      'app_domain_aliases  = []',
      'acm_certificate_arn = ""',
      'route53_zone_id     = ""',
      '',
    ].join('\n'),
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
  writeFileSync(
    join(repository, 'scripts/destroy.sh'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$AIDLC_DESTROY_LOG"\nexit "${AIDLC_DESTROY_EXIT:-0}"\n',
    { mode: 0o755 },
  );
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
  const configText = readFileSync(
    join(freshEnv.XDG_CONFIG_HOME, 'collaborative-ai-dlc/install.conf'),
    'utf8',
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
  "version -json") printf '{"terraform_version":"%s"}\\n' "\${AIDLC_FAKE_TERRAFORM_VERSION:-1.14.0}" ;;
  *" show -json "*) printf '{"resource_changes":[]}\\n' ;;
  *" state pull"*) printf '{}\\n' ;;
  *" output -raw application_url"*) printf 'https://example.invalid\\n' ;;
  *" output -raw user_pool_id"*) printf 'eu-central-1_pool-1\\n' ;;
  *" output -raw aws_region"*) printf 'eu-central-1\\n' ;;
  *" output -raw user_pool_client_id"*) printf 'client-1\\n' ;;
  *" output -raw cloudfront_domain_name"*) printf 'example.invalid\\n' ;;
  *" output -raw s3_bucket_name"*) printf 'bucket-1\\n' ;;
  *" output -raw cloudfront_distribution_id"*) printf 'distribution-1\\n' ;;
  *" output -raw application_domain"*) printf 'example.invalid\\n' ;;
  *" output -raw dns_target"*) printf 'd111111abcdef8.cloudfront.net\\n' ;;
  *" output -raw oidc_idp_callback_url"*) printf 'https://broker.example.invalid/oauth2/idpresponse\\n' ;;
  *" output -raw saml_acs_url"*) printf 'https://broker.example.invalid/saml2/idpresponse\\n' ;;
  *" output -raw saml_entity_id"*) printf 'urn:amazon:cognito:sp:eu-central-1_pool-1\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
printf 'profile=%s region=%s %s\\n' "\${AWS_PROFILE:-}" "\${AWS_REGION:-}" "$*" >> "$AIDLC_AWS_LOG"
case "$*" in
  *"acm describe-certificate"*)
    printf '{"Certificate":{"Status":"%s","DomainName":"%s","SubjectAlternativeNames":%s}}\\n' \\
      "\${AIDLC_FAKE_CERT_STATUS:-ISSUED}" \\
      "\${AIDLC_FAKE_CERT_DOMAIN:-aidlc.example.com}" \\
      "\${AIDLC_FAKE_CERT_SANS:-[\\"aidlc.example.com\\"]}"
    exit 0
    ;;
  *"route53 get-hosted-zone"*) printf '%s\\n' "\${AIDLC_FAKE_ZONE_NAME:-example.com.}"; exit 0 ;;
  *"cloudfront list-distributions"*)
    printf '{"DistributionList":{"Items":%s}}\\n' "\${AIDLC_FAKE_DISTRIBUTIONS:-[]}"
    exit 0
    ;;
esac
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

test('installer rejects Terraform older than 1.4 during preflight', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-old-terraform-'));
  const env = mockedCommandEnv(dir, repository);
  const installed = run('bash', [installer, 'install', '--version', '2.0.0'], {
    env: { ...env, AIDLC_FAKE_TERRAFORM_VERSION: '1.3.9' },
  });

  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /Terraform 1\.4 or later is required; found 1\.3\.9/);
  assert.equal(existsSync(join(env.XDG_DATA_HOME, 'collaborative-ai-dlc/current')), false);
});

test('installer creates permanent administrators with v1 and v2 roles', () => {
  const repository = createReleaseRepository();

  const v2Dir = mkdtempSync(join(tmpdir(), 'aidlc-v2-admin-'));
  const v2Env = mockedCommandEnv(v2Dir, repository);
  const v2 = run('bash', [installer, 'install', '--version', '2.0.0'], { env: v2Env });
  assert.equal(v2.status, 0, v2.stderr);
  assert.match(v2.stdout, /Application URL:\s+https:\/\/example\.invalid/);
  const v2Aws = readFileSync(v2Env.AIDLC_AWS_LOG, 'utf8');
  assert.match(v2Aws, /admin-create-user/);
  assert.match(v2Aws, /admin-set-user-password.*--permanent/);
  assert.match(
    v2Aws,
    /admin-add-user-to-group.*--group-name platform-admin.*--region eu-central-1/,
  );

  const currentLink = join(v2Env.XDG_DATA_HOME, 'collaborative-ai-dlc/current');
  const destroyLog = join(v2Dir, 'destroy.log');
  const failedDestroy = run('bash', [installer, 'destroy', '--yes'], {
    env: { ...v2Env, AIDLC_DESTROY_LOG: destroyLog, AIDLC_DESTROY_EXIT: '1' },
  });
  assert.equal(failedDestroy.status, 1);
  assert.equal(existsSync(currentLink), true);

  const destroyed = run('bash', [installer, 'destroy', '--yes'], {
    env: { ...v2Env, AIDLC_DESTROY_LOG: destroyLog },
  });
  assert.equal(destroyed.status, 0, destroyed.stderr);
  assert.match(destroyed.stdout, /Managed environment destroyed/);
  assert.equal(existsSync(currentLink), false);
  assert.match(readFileSync(destroyLog, 'utf8'), /dev --yes/);

  const upgradeDir = mkdtempSync(join(tmpdir(), 'aidlc-v1-admin-'));
  const upgradeEnv = mockedCommandEnv(upgradeDir, repository);
  upgradeEnv.AIDLC_AWS_PROFILE = 'saved-profile';
  upgradeEnv.AIDLC_REGION = 'eu-central-1';
  const v1 = run('bash', [installer, 'install', '--version', '1.1.0'], { env: upgradeEnv });
  assert.equal(v1.status, 0, v1.stderr);
  let upgradeAws = readFileSync(upgradeEnv.AIDLC_AWS_LOG, 'utf8');

  writeFileSync(upgradeEnv.AIDLC_AWS_LOG, '');
  const update = run('bash', [installer, 'update', '--version', '2.0.0'], { env: upgradeEnv });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Application URL:\s+https:\/\/example\.invalid/);
  upgradeAws = readFileSync(upgradeEnv.AIDLC_AWS_LOG, 'utf8');
  assert.match(
    upgradeAws,
    /admin-add-user-to-group.*--group-name platform-admin.*--region eu-central-1/,
  );
  assert.doesNotMatch(upgradeAws, /admin-set-user-password/);

  execFileSync('git', ['checkout', '-q', 'aidlc-v2'], { cwd: repository });
  writeFileSync(join(repository, 'branch-update'), 'next\n');
  execFileSync('git', ['add', 'branch-update'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'advance branch'], { cwd: repository });

  writeFileSync(upgradeEnv.AIDLC_AWS_LOG, '');
  const ambientEnv = { ...upgradeEnv };
  delete ambientEnv.AIDLC_AWS_PROFILE;
  delete ambientEnv.AIDLC_REGION;
  const ambientOverride = run('bash', [installer, 'update', '--ref', 'aidlc-v2'], {
    env: {
      ...ambientEnv,
      AWS_PROFILE: 'wrong-ambient-profile',
      AWS_REGION: 'us-west-2',
    },
  });
  assert.equal(ambientOverride.status, 0, ambientOverride.stderr);
  upgradeAws = readFileSync(upgradeEnv.AIDLC_AWS_LOG, 'utf8');
  assert.match(upgradeAws, /--region eu-central-1/);
});

const tfvarsOf = (env, environment = 'dev') =>
  readFileSync(
    join(env.XDG_CONFIG_HOME, `collaborative-ai-dlc/terraform/environments/${environment}.tfvars`),
    'utf8',
  );

const configOf = (env) =>
  readFileSync(join(env.XDG_CONFIG_HOME, 'collaborative-ai-dlc/install.conf'), 'utf8');

const ssoTfvarsOf = (env, environment = 'dev') =>
  JSON.parse(
    readFileSync(
      join(
        env.XDG_CONFIG_HOME,
        `collaborative-ai-dlc/terraform/environments/${environment}.sso.tfvars.json`,
      ),
      'utf8',
    ),
  );

test('installer supports SSO-only and can create a local admin when reconfigured', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-installer-sso-'));
  const env = mockedCommandEnv(dir, repository);
  const ssoConfig = join(dir, 'sso.json');
  writeJson(ssoConfig, {
    providers: [
      {
        name: 'CorporateOIDC',
        displayName: 'Corporate identity',
        type: 'oidc',
        issuerUrl: 'https://idp.example.com',
        clientId: 'client-id',
        clientSecretArn:
          'arn:aws:secretsmanager:eu-central-1:111122223333:secret:aidlc/oidc-AbCdEf',
        claims: { email: 'email', name: 'name', roles: 'groups' },
        roleMappings: { 'platform-admin': ['aidlc-admin'] },
        requiredClaimValues: ['aidlc-user'],
      },
    ],
  });

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--auth-mode',
      'sso-only',
      '--sso-config',
      ssoConfig,
    ],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Authentication:\s+sso-only/);
  assert.match(installed.stdout, /SSO providers:\s+Corporate identity/);
  assert.match(installed.stdout, /OIDC callback:\s+https:\/\/broker\.example\.invalid/);
  assert.match(installed.stdout, /SAML entity ID:\s+urn:amazon:cognito:sp:eu-central-1_pool-1/);

  const authVars = ssoTfvarsOf(env);
  assert.equal(authVars.auth_mode, 'sso-only');
  assert.equal(authVars.sso_providers.CorporateOIDC.display_name, 'Corporate identity');
  assert.match(authVars.sso_providers.CorporateOIDC.client_secret_arn, /:secretsmanager:/);
  const initialAws = existsSync(env.AIDLC_AWS_LOG) ? readFileSync(env.AIDLC_AWS_LOG, 'utf8') : '';
  assert.doesNotMatch(initialAws, /admin-create-user|admin-add-user-to-group/);
  assert.doesNotMatch(configOf(env), /NotStored123/);

  const status = run('bash', [installer, 'status'], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Auth:\s+sso-only/);
  assert.match(status.stdout, /SSO:\s+Corporate identity/);
  assert.match(status.stdout, /OIDC callback:\s+https:\/\/broker\.example\.invalid/);

  if (existsSync(env.AIDLC_AWS_LOG)) writeFileSync(env.AIDLC_AWS_LOG, '');
  const local = run('bash', [installer, 'update', '--version', '2.0.0', '--no-sso'], { env });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(ssoTfvarsOf(env).auth_mode, 'local');
  assert.deepEqual(ssoTfvarsOf(env).sso_providers, {});
  const updateAws = readFileSync(env.AIDLC_AWS_LOG, 'utf8');
  assert.match(updateAws, /admin-create-user/);
  assert.match(updateAws, /admin-set-user-password.*--permanent/);
  assert.match(updateAws, /admin-add-user-to-group.*--group-name platform-admin/);
});

test('installer leaves the custom domain unset by default', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-nodomain-'));
  const env = managedEnv(dir, repository);
  const tfvarsPath = join(
    env.XDG_CONFIG_HOME,
    'collaborative-ai-dlc/terraform/environments/dev.tfvars',
  );
  // Fresh install: the tfvars is templated from dev.tfvars.example.
  rmSync(tfvarsPath);

  const installed = run('bash', [installer, 'install', '--version', '2.0.0'], { env });
  assert.equal(installed.status, 0, installed.stderr);

  const tfvars = tfvarsOf(env);
  assert.match(tfvars, /^app_domain = ""$/m);
  assert.match(tfvars, /^app_domain_aliases = \[\]$/m);
  assert.match(tfvars, /^acm_certificate_arn = ""$/m);
  assert.match(tfvars, /^route53_zone_id = ""$/m);

  const status = run('bash', [installer, 'status'], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Domain:\s+CloudFront default \(no custom domain\)/);
});

test('installer leaves a domain-free tfvars untouched when no domain is requested', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-nodomain-legacy-'));
  // managedEnv seeds a tfvars predating the custom domain variables.
  const env = managedEnv(dir, repository);

  const installed = run('bash', [installer, 'install', '--version', '2.0.0'], { env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.doesNotMatch(tfvarsOf(env), /app_domain|acm_certificate_arn|route53_zone_id/);
});

test('installer records a custom domain with a supplied certificate', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-cert-'));
  const env = managedEnv(dir, repository);

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--domain-alias',
      'www.aidlc.example.com',
      '--domain-alias',
      'aidlc-alt.example.com',
      '--certificate-arn',
      'arn:aws:acm:us-east-1:111122223333:certificate/abc-123',
    ],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);

  const tfvars = tfvarsOf(env);
  assert.match(tfvars, /^app_domain = "aidlc\.example\.com"$/m);
  assert.match(
    tfvars,
    /^app_domain_aliases = \["www\.aidlc\.example\.com", "aidlc-alt\.example\.com"\]$/m,
  );
  assert.match(
    tfvars,
    /^acm_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate\/abc-123"$/m,
  );
  assert.match(tfvars, /^route53_zone_id = ""$/m);

  const config = configOf(env);
  assert.match(config, /AIDLC_APP_DOMAIN=aidlc\.example\.com/);
  // write_config shell-escapes values, so the separator may be quoted.
  assert.match(
    config,
    /AIDLC_APP_DOMAIN_ALIASES=www\.aidlc\.example\.com\\?,aidlc-alt\.example\.com/,
  );

  const status = run('bash', [installer, 'status'], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Domain:\s+aidlc\.example\.com/);
  assert.match(status.stdout, /Aliases:\s+www\.aidlc\.example\.com, aidlc-alt\.example\.com/);
  assert.match(status.stdout, /DNS:\s+managed externally/);
});

test('installer records a Route53-managed custom domain', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-zone-'));
  const env = managedEnv(dir, repository);

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--hosted-zone-id',
      'Z1234567890ABC',
    ],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(tfvarsOf(env), /^route53_zone_id = "Z1234567890ABC"$/m);

  const status = run('bash', [installer, 'status'], { env });
  assert.match(status.stdout, /DNS:\s+Route53 zone Z1234567890ABC \(managed by Terraform\)/);
});

test('installer rewrites existing custom domain assignments in place', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-rewrite-'));
  const env = managedEnv(dir, repository);
  const tfvarsPath = join(
    env.XDG_CONFIG_HOME,
    'collaborative-ai-dlc/terraform/environments/dev.tfvars',
  );
  writeFileSync(
    tfvarsPath,
    [
      'environment = "dev"',
      'aws_region = "us-east-1"',
      'app_domain          = "old.example.com"',
      'app_domain_aliases  = ["stale.example.com"]',
      'acm_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/old"',
      'route53_zone_id     = "ZOLD"',
      '',
    ].join('\n'),
  );

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'new.example.com',
      '--hosted-zone-id',
      'ZNEW',
    ],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);

  const tfvars = tfvarsOf(env);
  assert.match(tfvars, /^app_domain = "new\.example\.com"$/m);
  assert.match(tfvars, /^app_domain_aliases = \[\]$/m);
  assert.match(tfvars, /^acm_certificate_arn = ""$/m);
  assert.match(tfvars, /^route53_zone_id = "ZNEW"$/m);
  assert.doesNotMatch(tfvars, /old\.example\.com|stale\.example\.com|ZOLD/);
  // Substituted rather than appended, so each key appears exactly once.
  assert.equal(tfvars.match(/^app_domain = /gm).length, 1);
});

test('installer safely rewrites sed-sensitive managed tfvars values', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-tfvars-escaping-'));
  const env = managedEnv(dir, repository);
  const environment = String.raw`dev&blue\west`;
  const region = String.raw`us-east-1&edge\test|blue`;
  const environmentsDir = join(env.XDG_CONFIG_HOME, 'collaborative-ai-dlc/terraform/environments');
  const tfvarsPath = join(environmentsDir, `${environment}.tfvars`);
  writeFileSync(tfvarsPath, 'environment = "old"\naws_region = "old"\n');
  writeFileSync(join(environmentsDir, `${environment}.s3.tfbackend`), 'bucket = "test"\n');

  const installed = run(
    'bash',
    [installer, 'install', '--version', '2.0.0', '--environment', environment, '--region', region],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);

  const tfvars = readFileSync(tfvarsPath, 'utf8');
  assert.ok(tfvars.includes(`environment = ${JSON.stringify(environment)}`));
  assert.ok(tfvars.includes(`aws_region = ${JSON.stringify(region)}`));
  assert.match(installed.stderr, /updating 'environment'.*to match installer configuration/);
  assert.match(installed.stderr, /updating 'aws_region'.*to match installer configuration/);
  assert.equal(existsSync(`${tfvarsPath}.bak`), false);
});

test('installer carries the custom domain across an update and can remove it', () => {
  const repository = createReleaseRepository();
  writeJson(join(repository, 'package.json'), { name: 'aidlc', version: '2.2.0', private: true });
  execFileSync('git', ['add', 'package.json'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'v2.2'], { cwd: repository });
  execFileSync('git', ['tag', 'v2.2.0'], { cwd: repository });

  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-update-'));
  const env = managedEnv(dir, repository);

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--hosted-zone-id',
      'Z1234567890ABC',
    ],
    { env },
  );
  assert.equal(installed.status, 0, installed.stderr);

  // No domain flags: the persisted configuration must survive.
  const updated = run('bash', [installer, 'update', '--version', '2.2.0'], { env });
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(tfvarsOf(env), /^app_domain = "aidlc\.example\.com"$/m);
  assert.match(configOf(env), /AIDLC_ROUTE53_ZONE_ID=Z1234567890ABC/);

  const removed = run(
    'bash',
    [installer, 'update', '--version', '2.0.0', '--allow-downgrade', '--no-domain'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);

  const tfvars = tfvarsOf(env);
  assert.match(tfvars, /^app_domain = ""$/m);
  assert.match(tfvars, /^app_domain_aliases = \[\]$/m);
  assert.match(tfvars, /^route53_zone_id = ""$/m);
  assert.match(configOf(env), /AIDLC_APP_DOMAIN=''/);

  const status = run('bash', [installer, 'status'], { env });
  assert.match(status.stdout, /Domain:\s+CloudFront default/);
});

test('installer rejects unusable custom domain configurations', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-invalid-'));
  const env = managedEnv(dir, repository);

  const noCertificate = run(
    'bash',
    [installer, 'install', '--version', '2.0.0', '--domain', 'aidlc.example.com'],
    { env },
  );
  assert.equal(noCertificate.status, 2);
  assert.match(noCertificate.stderr, /needs a certificate/);
  assert.match(noCertificate.stderr, /--certificate-arn/);
  assert.match(noCertificate.stderr, /--hosted-zone-id/);

  const withScheme = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'https://aidlc.example.com',
      '--hosted-zone-id',
      'Z1',
    ],
    { env },
  );
  assert.equal(withScheme.status, 2);
  assert.match(withScheme.stderr, /Invalid hostname/);

  const badAlias = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--domain-alias',
      'WWW.example.com',
      '--hosted-zone-id',
      'Z1',
    ],
    { env },
  );
  assert.equal(badAlias.status, 2);
  assert.match(badAlias.stderr, /Invalid hostname 'WWW\.example\.com'/);

  const onV1 = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '1.1.0',
      '--domain',
      'aidlc.example.com',
      '--hosted-zone-id',
      'Z1',
    ],
    { env },
  );
  assert.equal(onV1.status, 2);
  assert.match(onV1.stderr, /require AI-DLC v2 or newer/);

  // A failed preflight must not leave a managed installation behind.
  assert.equal(existsSync(join(env.XDG_DATA_HOME, 'collaborative-ai-dlc/current')), false);
});

test('installer preflight validates the certificate, zone and hostname availability', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-preflight-'));
  const env = mockedCommandEnv(dir, repository);
  const domainArgs = [
    '--domain',
    'aidlc.example.com',
    '--certificate-arn',
    'arn:aws:acm:us-east-1:111122223333:certificate/abc-123',
    '--hosted-zone-id',
    'Z1234567890ABC',
  ];

  const wrongRegion = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--certificate-arn',
      'arn:aws:acm:eu-west-1:111122223333:certificate/abc-123',
    ],
    { env },
  );
  assert.equal(wrongRegion.status, 2);
  assert.match(wrongRegion.stderr, /not in us-east-1/);

  const pending = run('bash', [installer, 'install', '--version', '2.0.0', ...domainArgs], {
    env: { ...env, AIDLC_FAKE_CERT_STATUS: 'PENDING_VALIDATION' },
  });
  assert.equal(pending.status, 2);
  assert.match(pending.stderr, /is PENDING_VALIDATION, not ISSUED/);

  const notCovered = run('bash', [installer, 'install', '--version', '2.0.0', ...domainArgs], {
    env: {
      ...env,
      AIDLC_FAKE_CERT_DOMAIN: 'other.example.com',
      AIDLC_FAKE_CERT_SANS: '["other.example.com"]',
    },
  });
  assert.equal(notCovered.status, 2);
  assert.match(notCovered.stderr, /does not cover 'aidlc\.example\.com'/);

  const outsideZone = run('bash', [installer, 'install', '--version', '2.0.0', ...domainArgs], {
    env: { ...env, AIDLC_FAKE_ZONE_NAME: 'elsewhere.test.' },
  });
  assert.equal(outsideZone.status, 2);
  assert.match(outsideZone.stderr, /is not inside hosted zone 'elsewhere\.test'/);

  const taken = run('bash', [installer, 'install', '--version', '2.0.0', ...domainArgs], {
    env: {
      ...env,
      AIDLC_FAKE_DISTRIBUTIONS: '[{"Id":"OTHERDIST","Aliases":{"Items":["aidlc.example.com"]}}]',
    },
  });
  assert.equal(taken.status, 2);
  assert.match(taken.stderr, /already an alias of CloudFront distribution OTHERDIST/);

  // Nothing was installed while the preflight kept rejecting.
  assert.equal(existsSync(join(env.XDG_DATA_HOME, 'collaborative-ai-dlc/current')), false);

  // A wildcard certificate covers the hostname.
  const wildcardEnv = {
    ...env,
    AIDLC_FAKE_CERT_DOMAIN: '*.example.com',
    AIDLC_FAKE_CERT_SANS: '["*.example.com"]',
  };
  const accepted = run('bash', [installer, 'install', '--version', '2.0.0', ...domainArgs], {
    env: wildcardEnv,
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Custom domain:\s+aidlc\.example\.com/);

  // Re-running against the deployment's own distribution is not a collision.
  const readopted = run('bash', [installer, 'update', '--ref', 'aidlc-v2'], {
    env: {
      ...wildcardEnv,
      AIDLC_FAKE_DISTRIBUTIONS:
        '[{"Id":"distribution-1","Aliases":{"Items":["aidlc.example.com"]}}]',
    },
  });
  assert.equal(readopted.status, 0, readopted.stderr);
});

test('installer prints external DNS records when Route53 is not managed', () => {
  const repository = createReleaseRepository();
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-domain-dns-'));
  const env = mockedCommandEnv(dir, repository);

  const installed = run(
    'bash',
    [
      installer,
      'install',
      '--version',
      '2.0.0',
      '--domain',
      'aidlc.example.com',
      '--domain-alias',
      'www.aidlc.example.com',
      '--certificate-arn',
      'arn:aws:acm:us-east-1:111122223333:certificate/abc-123',
    ],
    {
      env: {
        ...env,
        AIDLC_FAKE_CERT_DOMAIN: '*.example.com',
        AIDLC_FAKE_CERT_SANS: '["*.example.com","*.aidlc.example.com"]',
      },
    },
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /DNS is managed outside this deployment/);
  assert.match(installed.stdout, /aidlc\.example\.com\s+A\s+-> d111111abcdef8\.cloudfront\.net/);
  assert.match(installed.stdout, /aidlc\.example\.com\s+AAAA\s+-> d111111abcdef8\.cloudfront\.net/);
  assert.match(
    installed.stdout,
    /www\.aidlc\.example\.com\s+A\s+-> d111111abcdef8\.cloudfront\.net/,
  );
});
