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
  assert.match(destroy, /cp "\$TF_DIR\/variables\.tf" "\$TEMP_DIR\/variables\.tf"/);
  assert.match(destroy, /terraform -chdir="\$TEMP_DIR" console -var-file="\$TFVARS_FILE"/);
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
