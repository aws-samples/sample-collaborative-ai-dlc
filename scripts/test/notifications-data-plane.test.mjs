import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Static contract for the attention-notifications data plane (us-28). The
// table changes must stay in place on existing installs, and module outputs are
// a published contract for the downstream notification units.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

// Returns the text of `<kind> "<type>" "<name>" { ... }` with nested braces.
const block = (text, header) => {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated ${header}`);
};
const gsi = (table, name) => {
  const match = [...table.matchAll(/global_secondary_index \{/g)]
    .map((found) => block(table.slice(found.index), 'global_secondary_index {'))
    .find((body) => body.includes(name));
  assert.ok(match, `missing GSI ${name}`);
  return match;
};

const dynamodb = read('terraform/modules/data/dynamodb/main.tf');
const notificationsTable = block(dynamodb, 'resource "aws_dynamodb_table" "notifications"');

test('T8: notifications keeps its key schema and gains TTL plus two sparse GSIs', () => {
  assert.match(notificationsTable, /hash_key\s+= "userId"/);
  assert.match(notificationsTable, /range_key\s+= "timestamp"/);
  assert.match(
    notificationsTable,
    /name\s+= "\$\{var\.project_name\}-notifications-\$\{var\.environment\}"/,
  );
  assert.match(notificationsTable, /deletion_protection_enabled = var\.deletion_protection/);
  assert.match(notificationsTable, /point_in_time_recovery \{\s+enabled = true/);
  assert.match(notificationsTable, /ttl \{\s+attribute_name = "expiresAt"\s+enabled\s+= true/);
  assert.match(notificationsTable, /name = "sourceKey"\s+type = "S"/);
  assert.match(notificationsTable, /name = "digestBucket"\s+type = "S"/);
  assert.match(notificationsTable, /name = "timestamp"\s+type = "N"/);

  assert.match(dynamodb, /notifications_source_index = "SourceIndex"/);
  assert.match(dynamodb, /notifications_digest_index = "DigestIndex"/);
  const source = gsi(notificationsTable, 'local.notifications_source_index');
  assert.match(source, /projection_type = "KEYS_ONLY"/);
  assert.match(source, /attribute_name = "sourceKey"\s+key_type\s+= "HASH"/);
  assert.match(source, /attribute_name = "timestamp"\s+key_type\s+= "RANGE"/);
  const digest = gsi(notificationsTable, 'local.notifications_digest_index');
  assert.match(digest, /projection_type = "ALL"/);
  assert.match(digest, /attribute_name = "digestBucket"\s+key_type\s+= "HASH"/);
  assert.match(digest, /attribute_name = "userId"\s+key_type\s+= "RANGE"/);
});

test('T8: preferences is a durable scope/namespace table without TTL', () => {
  const preferences = block(dynamodb, 'resource "aws_dynamodb_table" "preferences"');
  assert.match(
    preferences,
    /name\s+= "\$\{var\.project_name\}-preferences-\$\{var\.environment\}"/,
  );
  assert.match(preferences, /hash_key\s+= "scope"/);
  assert.match(preferences, /range_key\s+= "namespace"/);
  assert.match(preferences, /deletion_protection_enabled = var\.deletion_protection/);
  assert.match(preferences, /point_in_time_recovery \{\s+enabled = true/);
  assert.match(preferences, /kms_key_arn = var\.kms_key_arn != "" \? var\.kms_key_arn : null/);
  assert.doesNotMatch(preferences, /ttl \{|global_secondary_index/);
});

test('T8: v2_executions streams NEW_AND_OLD_IMAGES and publishes the stream ARN', () => {
  const agentcore = read('terraform/modules/compute/agentcore/main.tf');
  const executions = block(agentcore, 'resource "aws_dynamodb_table" "v2_executions"');
  assert.match(executions, /hash_key\s+= "pk"/);
  assert.match(executions, /range_key\s+= "sk"/);
  assert.match(executions, /stream_enabled\s+= true/);
  assert.match(executions, /stream_view_type = "NEW_AND_OLD_IMAGES"/);
  assert.match(
    read('terraform/modules/compute/agentcore/outputs.tf'),
    /output "v2_executions_stream_arn" \{[\s\S]*?aws_dynamodb_table\.v2_executions\.stream_arn/,
  );
});

test('escalation and capture queues follow the queue rules', () => {
  const module = read('terraform/modules/notifications/main.tf');
  const escalation = block(module, 'resource "aws_sqs_queue" "escalation"');
  assert.match(module, /escalation_delay_seconds = 120/);
  assert.match(escalation, /delay_seconds\s+= local\.escalation_delay_seconds/);
  assert.match(
    escalation,
    /visibility_timeout_seconds = 6 \* var\.escalation_worker_timeout_seconds/,
  );
  assert.match(module, /escalation_retention_seconds = 345600/);
  assert.match(module, /escalation_max_receives\s+= 5/);
  assert.match(escalation, /deadLetterTargetArn = aws_sqs_queue\.escalation_dlq\.arn/);

  const allowPolicy = block(
    module,
    'resource "aws_sqs_queue_redrive_allow_policy" "escalation_dlq"',
  );
  assert.match(allowPolicy, /redrivePermission = "byQueue"/);
  assert.match(allowPolicy, /sourceQueueArns\s+= \[aws_sqs_queue\.escalation\.arn\]/);

  assert.match(module, /dlq_retention_seconds\s+= 1209600/);
  for (const name of ['escalation', 'escalation_dlq', 'capture_dlq']) {
    const queue = block(module, `resource "aws_sqs_queue" "${name}"`);
    assert.match(queue, /sqs_managed_sse_enabled\s+= true/, `${name} must use SSE-SQS`);
  }
  // Alarms belong to notification-observability, policies to the consumers.
  assert.doesNotMatch(module, /aws_cloudwatch_metric_alarm|aws_sqs_queue_policy|aws_iam_/);

  const variables = read('terraform/modules/notifications/variables.tf');
  assert.match(variables, /variable "escalation_worker_timeout_seconds" \{[\s\S]*?default\s+= 30/);
});

test('Terraform owns only the unsubscribe secret container, never its value', () => {
  const module = read('terraform/modules/notifications/main.tf');
  const secret = block(module, 'resource "aws_secretsmanager_secret" "unsubscribe_hmac"');
  assert.match(
    secret,
    /name_prefix = "\$\{var\.project_name\}-\$\{var\.environment\}-notifications-unsubscribe-hmac-"/,
  );
  assert.match(secret, /kms_key_id\s+= var\.kms_key_arn != "" \? var\.kms_key_arn : null/);
  assert.doesNotMatch(module, /aws_secretsmanager_secret_version|random_password|random_bytes/);
});

test('module outputs and root wiring publish the data-plane contract', () => {
  const dynamodbOutputs = read('terraform/modules/data/dynamodb/outputs.tf');
  for (const name of [
    'notifications_table_name',
    'notifications_table_arn',
    'notifications_source_index_name',
    'notifications_digest_index_name',
    'preferences_table_name',
    'preferences_table_arn',
  ]) {
    assert.match(dynamodbOutputs, new RegExp(`output "${name}"`));
  }
  const moduleOutputs = read('terraform/modules/notifications/outputs.tf');
  for (const name of [
    'escalation_queue_url',
    'escalation_queue_arn',
    'escalation_dlq_arn',
    'escalation_dlq_name',
    'capture_dlq_arn',
    'capture_dlq_name',
    'unsubscribe_secret_arn',
  ]) {
    assert.match(moduleOutputs, new RegExp(`output "${name}"`));
  }

  const rootMain = read('terraform/main.tf');
  const wiring = block(rootMain, 'module "notifications"');
  assert.match(wiring, /source = "\.\/modules\/notifications"/);
  assert.match(wiring, /v2_executions_stream_arn = module\.agentcore\.v2_executions_stream_arn/);
  assert.match(wiring, /preferences_table_arn\s+= module\.dynamodb\.preferences_table_arn/);

  const rootOutputs = read('terraform/outputs.tf');
  assert.match(rootOutputs, /output "notifications_table_name"/);
  assert.match(rootOutputs, /output "preferences_table_name"/);
  assert.match(
    rootOutputs,
    /output "notifications_unsubscribe_secret_arn" \{[\s\S]*?module\.notifications\.unsubscribe_secret_arn/,
  );
  assert.match(rootOutputs, /output "notifications_escalation_queue_url"/);
});

test('T7: the plan guard accepts the in-place update and refuses a table replacement', () => {
  const inspector = join(root, 'scripts/inspect-terraform-plan.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-notifications-plan-'));
  const address = 'module.dynamodb.aws_dynamodb_table.notifications';
  const planWith = (actions) => {
    const path = join(dir, `${actions.join('-')}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        resource_changes: [
          {
            address,
            type: 'aws_dynamodb_table',
            change: { actions, before: { name: 'n' }, after: { name: 'n' } },
          },
          {
            address: 'module.dynamodb.aws_dynamodb_table.preferences',
            type: 'aws_dynamodb_table',
            change: { actions: ['create'], before: null, after: { name: 'p' } },
          },
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, path], { encoding: 'utf8' });
  };
  try {
    const update = planWith(['update']);
    assert.equal(update.status, 0, update.stderr);

    for (const replace of [
      ['delete', 'create'],
      ['create', 'delete'],
    ]) {
      const refused = planWith(replace);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /protected persistent resources would be destroyed/);
      assert.match(refused.stderr, /aws_dynamodb_table\.notifications/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // No allow-list entry may exempt the notification tables from the guard.
  assert.doesNotMatch(read('scripts/inspect-terraform-plan.mjs'), /notifications|preferences/);
});

test('T11: the changelog carries the data-plane upgrade notes', () => {
  const changelog = read('CHANGELOG.md');
  const unreleased = changelog.slice(
    changelog.indexOf('## [Unreleased]'),
    changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1),
  );
  assert.match(unreleased, /### Upgrade notes — Attention Notifications data plane/);
  assert.match(unreleased, /in place/);
  assert.match(unreleased, /`preferences` table/);
  assert.match(unreleased, /NEW_AND_OLD_IMAGES/);
  assert.match(unreleased, /AIDLC_NOTIFICATIONS_PREFLIGHT=acknowledge-legacy/);
  assert.match(unreleased, /rotate/);
  assert.match(unreleased, /SES sandbox/);
});
