#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const planPath = process.argv[2];
if (!planPath) {
  console.error('Usage: inspect-terraform-plan.mjs <terraform-plan.json>');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const protectedTypes = new Set([
  'aws_cognito_user_pool',
  'aws_neptune_cluster',
  'aws_neptune_cluster_instance',
  'aws_s3_bucket',
  'aws_dynamodb_table',
  'aws_efs_file_system',
  // Retained native runs pin immutable digests in this repository; dev uses
  // force_delete, so destroying it would delete every still-required image.
  'aws_ecr_repository',
]);

const expectedRetirement = (change) => {
  if (change.type !== 'aws_dynamodb_table') return false;
  return /agent[_-]?pool/i.test(change.address);
};

const destructive = (change) => change.change?.actions?.includes('delete');
// Image replacements destroy using the BEFORE state. Setting keep_remotely on
// only the replacement does not preserve an image that active runs still pin.
const deletesPinnedRuntimeImage = (change) =>
  change.type === 'docker_registry_image' &&
  change.address.startsWith('module.agentcore.') &&
  change.change?.before?.keep_remotely !== true;
const rejected = (plan.resource_changes || []).filter(
  (change) =>
    destructive(change) &&
    ((protectedTypes.has(change.type) && !expectedRetirement(change)) ||
      deletesPinnedRuntimeImage(change)),
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
