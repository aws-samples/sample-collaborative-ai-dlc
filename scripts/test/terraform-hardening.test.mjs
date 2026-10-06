import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const resourceBlocks = (text, resourceType) => {
  const pattern = new RegExp(`resource "${resourceType}" "([^"]+)" \\{`, 'g');
  return [...text.matchAll(pattern)].map((match) => {
    let depth = 1;
    let escaped = false;
    let inString = false;
    let index = match.index + match[0].length;

    for (; index < text.length && depth > 0; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
      }
    }

    return { body: text.slice(match.index, index), name: match[1] };
  });
};
const moduleBlock = (text, moduleName) => {
  const block = text.match(new RegExp(`module "${moduleName}" \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(block, `missing module "${moduleName}"`);
  return block;
};
const lambdaModuleBlocks = (text) =>
  [...text.matchAll(/^module "([^"]+)" \{/gm)]
    .map((match) => moduleBlock(text, match[1]))
    .filter((block) => /source\s+= "terraform-aws-modules\/lambda\/aws"/.test(block));
const dynamodbCallerRoles = (text) =>
  [
    ...new Set(
      resourceBlocks(text, 'aws_iam_role_policy')
        .filter(({ body }) => body.includes('"dynamodb:'))
        .flatMap(({ body }) =>
          [...body.matchAll(/aws_iam_role\.([^.]+)\./g)].map((match) => match[1]),
        ),
    ),
  ].toSorted();
const kmsAuthorizedRoles = (text) =>
  [...moduleBlock(text, 'dynamodb_kms_runtime_access').matchAll(/=\s*aws_iam_role\.([^.]+)\.name/g)]
    .map((match) => match[1])
    .toSorted();

test('all DynamoDB tables support CMK encryption and durable tables are recoverable', () => {
  const applicationTables = read('terraform/modules/data/dynamodb/main.tf');
  assert.equal(count(applicationTables, /resource "aws_dynamodb_table"/g), 10);
  assert.equal(count(applicationTables, /server_side_encryption \{/g), 10);
  assert.equal(count(applicationTables, /deletion_protection_enabled/g), 8);
  assert.equal(count(applicationTables, /point_in_time_recovery/g), 8);

  const integrationTables = read('terraform/modules/git/main.tf');
  assert.equal(count(integrationTables, /resource "aws_dynamodb_table"/g), 4);
  assert.equal(count(integrationTables, /server_side_encryption \{/g), 4);
  assert.equal(count(integrationTables, /deletion_protection_enabled/g), 4);
  assert.equal(count(integrationTables, /point_in_time_recovery/g), 4);

  const agentcore = read('terraform/modules/compute/agentcore/main.tf');
  assert.match(
    agentcore,
    /resource "aws_dynamodb_table" "v2_executions"[\s\S]*?deletion_protection_enabled = var\.deletion_protection[\s\S]*?server_side_encryption \{[\s\S]*?point_in_time_recovery/,
  );
});

test('Neptune and production S3 resources resist accidental deletion', () => {
  const neptune = read('terraform/modules/data/neptune/main.tf');
  assert.match(neptune, /deletion_protection\s+= var\.deletion_protection/);
  assert.match(neptune, /backup_retention_period\s+= var\.backup_retention_period/);
  assert.match(neptune, /skip_final_snapshot\s+= var\.skip_final_snapshot/);
  assert.match(neptune, /resource "random_id" "final_snapshot_suffix"/);
  assert.match(
    neptune,
    /final_snapshot_identifier\s+= var\.skip_final_snapshot \? null : "\$\{trim\(substr\(var\.name_prefix, 0, 39\), "-"\)\}-neptune-final-\$\{random_id\.final_snapshot_suffix\[0\]\.hex\}"/,
  );
  assert.doesNotMatch(neptune, /storage_encrypted/);

  const s3 = read('terraform/modules/data/s3/main.tf');
  assert.equal(count(s3, /force_destroy = var\.environment != "prod"/g), 3);

  const frontend = read('terraform/modules/frontend/main.tf');
  assert.equal(count(frontend, /force_destroy = var\.environment != "prod"/g), 1);
});

test('root KMS configuration accepts existing keys without owning their lifecycle', () => {
  const rootVariables = read('terraform/variables.tf');
  assert.doesNotMatch(rootVariables, /variable "kms_mode"/);
  assert.match(rootVariables, /variable "kms_key_arn"[\s\S]*?default\s+= ""/);
  assert.match(rootVariables, /variable "skip_final_snapshot"[\s\S]*?default\s+= false/);

  const rootMain = read('terraform/main.tf');
  assert.doesNotMatch(rootMain, /module "data_kms"/);
  assert.doesNotMatch(rootMain, /resource "aws_kms_(key|alias)"/);
  assert.match(rootMain, /kms_key_arn\s+= var\.kms_key_arn/);
  assert.match(
    rootMain,
    /module "neptune"[\s\S]*?skip_final_snapshot\s+= var\.skip_final_snapshot/,
  );
  assert.match(rootMain, /condition\s+= var\.environment != "prod" \|\| !var\.skip_final_snapshot/);

  const example = read('terraform/environments/dev.tfvars.example');
  assert.doesNotMatch(example, /^kms_mode\s+=/m);
  assert.match(example, /^kms_key_arn\s+= ""$/m);
  assert.match(example, /^deletion_protection\s+= true$/m);
  assert.match(example, /^backup_retention_period\s+= 7$/m);
  assert.match(example, /^skip_final_snapshot\s+= false$/m);
});

test('lambda_vpc_scope all places every Lambda in private subnets', () => {
  const variables = read('terraform/variables.tf');
  assert.match(
    variables,
    /variable "lambda_vpc_scope"[\s\S]*?contains\(\["required", "public-egress", "all"\]/,
  );

  const rootMain = read('terraform/main.tf');
  for (const moduleName of ['auth', 'realtime', 'managed_environments']) {
    const block = moduleBlock(rootMain, moduleName);
    assert.match(block, /lambda_vpc_scope\s+= var\.lambda_vpc_scope/);
    assert.match(block, /module\.networking\.private_subnet_ids/);
    assert.match(block, /module\.networking\.default_security_group_id/);
  }

  for (const path of [
    'terraform/modules/api/lambda/main.tf',
    'terraform/modules/api/agents.tf',
    'terraform/modules/auth/main.tf',
    'terraform/modules/realtime/lambda.tf',
    'terraform/modules/compute/managed-environments/main.tf',
  ]) {
    const source = read(path);
    const modules = lambdaModuleBlocks(source);
    assert.ok(modules.length > 0, `${path} must contain Lambda modules`);
    for (const block of modules) {
      assert.match(block, /vpc_subnet_ids\s+=/, `${path} has a Lambda without VPC placement`);
      assert.match(
        block,
        /vpc_security_group_ids\s+=/,
        `${path} has a Lambda without VPC security groups`,
      );
    }

    const lambdaRoles = [
      ...new Set(
        modules.flatMap((block) =>
          [...block.matchAll(/lambda_role\s+= aws_iam_role\.([^.]+)\.arn/g)].map(
            (match) => match[1],
          ),
        ),
      ),
    ].toSorted();
    const vpcRoles = [
      ...new Set(
        resourceBlocks(source, 'aws_iam_role_policy_attachment')
          .filter(({ body }) => body.includes('AWSLambdaVPCAccessExecutionRole'))
          .flatMap(({ body }) =>
            [...body.matchAll(/role\s+= aws_iam_role\.([^.]+)\.name/g)].map((match) => match[1]),
          ),
      ),
    ].toSorted();
    assert.deepEqual(
      lambdaRoles.filter((role) => !vpcRoles.includes(role)),
      [],
      `${path} must grant VPC permissions to every custom Lambda role`,
    );
  }

  const lambdaMain = read('terraform/modules/api/lambda/main.tf');
  assert.match(
    lambdaMain,
    /enable_public_egress\s+= contains\(\["public-egress", "all"\], var\.lambda_vpc_scope\)/,
  );

  const deploy = read('scripts/deploy-terraform.sh');
  assert.match(
    deploy,
    /"\$lambda_vpc_scope" == "public-egress" \|\| "\$lambda_vpc_scope" == "all"/,
  );
});

test('optional WAF protects CloudFront, API Gateway, and Cognito', () => {
  const variables = read('terraform/variables.tf');
  assert.match(variables, /variable "enable_waf"[\s\S]*?default\s+= false/);

  const waf = read('terraform/modules/security/waf/main.tf');
  assert.match(
    waf,
    /resource "aws_wafv2_web_acl" "cloudfront"[\s\S]*?provider = aws\.us_east_1[\s\S]*?scope\s+= "CLOUDFRONT"/,
  );
  assert.match(waf, /resource "aws_wafv2_web_acl" "regional"[\s\S]*?scope\s+= "REGIONAL"/);
  for (const group of [
    'AWSManagedRulesAmazonIpReputationList',
    'AWSManagedRulesCommonRuleSet',
    'AWSManagedRulesKnownBadInputsRuleSet',
  ]) {
    assert.ok(waf.includes(group), `missing WAF managed rule group ${group}`);
  }
  assert.match(waf, /resource "aws_wafv2_ip_set" "cloudfront_allowlist"/);

  const root = read('terraform/main.tf');
  assert.match(
    moduleBlock(root, 'waf'),
    /source\s+= "\.\/modules\/security\/waf"[\s\S]*?aws\.us_east_1 = aws\.us_east_1[\s\S]*?enabled\s+= var\.enable_waf/,
  );
  assert.match(moduleBlock(root, 'auth'), /waf_enabled\s+= var\.enable_waf/);
  assert.match(moduleBlock(root, 'api'), /waf_enabled\s+= var\.enable_waf/);

  const frontend = read('terraform/modules/frontend/main.tf');
  assert.match(
    frontend,
    /resource "aws_cloudfront_distribution" "frontend" \{[\s\S]*?web_acl_id = var\.web_acl_arn/,
  );

  const api = read('terraform/modules/api/main.tf');
  assert.match(
    api,
    /resource "aws_wafv2_web_acl_association" "stage"[\s\S]*?count = var\.waf_enabled \? 1 : 0[\s\S]*?aws_api_gateway_stage\.main\.arn/,
  );

  const auth = read('terraform/modules/auth/main.tf');
  assert.match(
    auth,
    /resource "aws_wafv2_web_acl_association" "user_pool"[\s\S]*?count = var\.waf_enabled \? 1 : 0[\s\S]*?aws_cognito_user_pool\.main\.arn/,
  );

  const example = read('terraform/environments/dev.tfvars.example');
  assert.match(example, /^enable_waf\s+= false$/m);
});

test('DynamoDB CMK access covers deployment and every runtime caller', () => {
  const runtimePolicy = read('terraform/modules/security/dynamodb-kms-runtime-access/main.tf');
  for (const action of [
    'kms:DescribeKey',
    'kms:Decrypt',
    'kms:Encrypt',
    'kms:ReEncrypt*',
    'kms:GenerateDataKey*',
    'kms:CreateGrant',
  ]) {
    assert.ok(runtimePolicy.includes(`"${action}"`), `missing KMS action ${action}`);
  }
  assert.match(runtimePolicy, /Resource\s+= var\.kms_key_arn/);
  assert.match(runtimePolicy, /"kms:ViaService"\s+= "dynamodb\.\*\.\$\{var\.dns_suffix\}"/);
  assert.match(runtimePolicy, /"kms:GrantIsForAWSResource"\s+= "true"/);

  for (const path of [
    'terraform/modules/api/lambda/main.tf',
    'terraform/modules/realtime/lambda.tf',
    'terraform/modules/compute/managed-environments/main.tf',
    'terraform/modules/compute/agentcore/main.tf',
    'terraform/modules/realtime/yjs-server/scaling.tf',
  ]) {
    const source = read(path);
    assert.deepEqual(
      kmsAuthorizedRoles(source),
      dynamodbCallerRoles(source),
      `${path} must authorize every role whose policy calls DynamoDB`,
    );
  }

  const rootMain = read('terraform/main.tf');
  for (const moduleName of [
    'lambda',
    'realtime',
    'agentcore',
    'managed_environments',
    'yjs_server',
  ]) {
    assert.match(moduleBlock(rootMain, moduleName), /kms_key_arn\s+= var\.kms_key_arn/);
  }
  const yjsScaling = read('terraform/modules/realtime/yjs-server/scaling.tf');
  assert.match(
    moduleBlock(yjsScaling, 'dynamodb_kms_runtime_access'),
    /kms_key_arn\s+= var\.scaling\.cluster_enabled \? var\.kms_key_arn : ""/,
  );

  const prerequisites = read('docs/getting-started/prerequisites.md');
  assert.match(prerequisites, /deployment principal needs `kms:DescribeKey`/);
  assert.match(prerequisites, /`kms:CreateGrant` additionally restricted/);
  assert.match(prerequisites, /service-principal grant to DynamoDB alone is not sufficient/);
});

test('teardown covers every protected data store and cannot automate production', () => {
  const protectedResources = [
    ['terraform/modules/data/dynamodb/main.tf', 'module.dynamodb'],
    ['terraform/modules/git/main.tf', 'module.git'],
    ['terraform/modules/compute/agentcore/main.tf', 'module.agentcore'],
  ]
    .flatMap(([path, moduleAddress]) =>
      resourceBlocks(read(path), 'aws_dynamodb_table')
        .filter(({ body }) => body.includes('deletion_protection_enabled'))
        .map(({ name }) => `${moduleAddress}.aws_dynamodb_table.${name}`),
    )
    .concat('module.neptune.aws_neptune_cluster.main')
    .toSorted();

  const destroy = read('scripts/destroy.sh');
  const teardownTargets = [...destroy.matchAll(/^\s+-target=([^\s]+)$/gm)]
    .map((match) => match[1])
    .toSorted();
  assert.deepEqual(teardownTargets, protectedResources);
  assert.doesNotMatch(destroy, /cp "\$TF_DIR\/variables\.tf"/);
  assert.match(
    destroy,
    /terraform -chdir="\$TF_DIR" console[\s\S]*?-var-file="\$TFVARS_FILE"[\s\S]*?-var="deletion_protection=false"/,
  );
  assert.match(destroy, /unset TF_CLI_ARGS_console TF_CLI_ARGS_plan TF_CLI_ARGS_destroy/);
  assert.match(destroy, /STATE_RESOURCES="\$\(terraform -chdir="\$TF_DIR" state list\)"/);
  assert.match(
    destroy,
    /grep -Fqx "\$address"[\s\S]*?EXISTING_PROTECTION_TARGETS\+=\("\$target"\)/,
  );
  assert.match(
    destroy,
    /terraform -chdir="\$TF_DIR" plan[\s\S]*?"\$\{EXISTING_PROTECTION_TARGETS\[@\]\}"/,
  );
  assert.match(destroy, /--deletion-protection-only/);
  assert.match(destroy, /terraform -chdir="\$TF_DIR" apply -auto-approve "\$PREPARATION_PLAN"/);

  const installer = read('scripts/install.sh');
  assert.match(installer, /destroy_command\(\)[\s\S]*?\[\[ "\$ENVIRONMENT" == "prod" \]\]/);
});
