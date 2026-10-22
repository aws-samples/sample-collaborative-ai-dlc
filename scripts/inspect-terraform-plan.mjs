#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const planPath = process.argv[2];
if (!planPath) {
  console.error(
    'Usage: inspect-terraform-plan.mjs <terraform-plan.json> [--deletion-protection-only]',
  );
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const mode = process.argv[3];
const deletionProtectionOnly = mode === '--deletion-protection-only';
if (mode && !deletionProtectionOnly) {
  console.error(`Unknown plan inspection mode: ${mode}`);
  process.exit(2);
}

const protectedTypes = new Set([
  'aws_cognito_user_pool',
  'aws_neptune_cluster',
  'aws_neptune_cluster_instance',
  'aws_s3_bucket',
  'aws_dynamodb_table',
]);

const expectedRetirement = (change) => {
  if (change.type !== 'aws_dynamodb_table') return false;
  return /agent[_-]?pool/i.test(change.address);
};

const destructive = (change) => change.change?.actions?.includes('delete');

// Attribute and enabled/disabled values per resource type. Cognito uses an
// ACTIVE/INACTIVE string rather than a boolean.
const protectionSettings = {
  aws_dynamodb_table: { attribute: 'deletion_protection_enabled', enabled: true, disabled: false },
  aws_neptune_cluster: { attribute: 'deletion_protection', enabled: true, disabled: false },
  aws_cognito_user_pool: {
    attribute: 'deletion_protection',
    enabled: 'ACTIVE',
    disabled: 'INACTIVE',
  },
};

const onlyDisablesDeletionProtection = (change) => {
  if (!isDeepStrictEqual(change.change?.actions, ['update'])) return false;

  const settings = protectionSettings[change.type];
  if (!settings) return false;
  const { attribute, enabled, disabled } = settings;
  const before = structuredClone(change.change.before);
  const after = structuredClone(change.change.after);
  if (before?.[attribute] !== enabled || after?.[attribute] !== disabled) return false;
  delete before[attribute];
  delete after[attribute];
  return isDeepStrictEqual(before, after);
};

if (deletionProtectionOnly) {
  const rejectedPreparationChanges = (plan.resource_changes || []).filter((change) => {
    const actions = change.change?.actions || [];
    if (actions.every((action) => action === 'no-op' || action === 'read')) return false;
    return !onlyDisablesDeletionProtection(change);
  });

  if (rejectedPreparationChanges.length) {
    console.error(
      'Refusing Terraform teardown preparation: plan contains changes other than disabling deletion protection on existing resources:',
    );
    for (const change of rejectedPreparationChanges) {
      console.error(`  - ${change.address} (${(change.change?.actions || []).join(', ')})`);
    }
    process.exit(1);
  }

  console.log('Terraform deletion-protection-only check passed.');
  process.exit(0);
}

const rejected = (plan.resource_changes || []).filter(
  (change) => destructive(change) && protectedTypes.has(change.type) && !expectedRetirement(change),
);
const expected = (plan.resource_changes || []).filter(
  (change) => destructive(change) && expectedRetirement(change),
);

for (const change of expected) {
  console.log(`Allowed retired v1 resource removal: ${change.address}`);
}
if (rejected.length) {
  console.error('Refusing Terraform plan: protected persistent resources would be destroyed:');
  for (const change of rejected) {
    console.error(`  - ${change.address} (${change.change.actions.join(', ')})`);
  }
  process.exit(1);
}

console.log('Terraform plan destruction check passed.');
