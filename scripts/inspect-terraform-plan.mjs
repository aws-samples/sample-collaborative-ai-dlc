#!/usr/bin/env node

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const planPath = process.argv[2];
if (!planPath) {
  console.error(
    'Usage: inspect-terraform-plan.mjs <terraform-plan.json> [--deletion-protection-only|--require-lambda-packages]',
  );
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const mode = process.argv[3];
const deletionProtectionOnly = mode === '--deletion-protection-only';
const requireLambdaPackages = mode === '--require-lambda-packages';
if (mode && !deletionProtectionOnly && !requireLambdaPackages) {
  console.error(`Unknown plan inspection mode: ${mode}`);
  process.exit(2);
}

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

const protectionAttribute = (change) => {
  if (change.type === 'aws_dynamodb_table') return 'deletion_protection_enabled';
  if (change.type === 'aws_neptune_cluster') return 'deletion_protection';
  return undefined;
};

const onlyDisablesDeletionProtection = (change) => {
  if (!isDeepStrictEqual(change.change?.actions, ['update'])) return false;

  const attribute = protectionAttribute(change);
  if (!attribute) return false;
  const before = structuredClone(change.change.before);
  const after = structuredClone(change.change.after);
  if (before?.[attribute] !== true || after?.[attribute] !== false) return false;
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

const nativeRemovalVerified = (plan.resource_changes || []).some(
  (change) =>
    change.address === 'data.external.native_decommission[0]' &&
    change.change?.after?.result?.empty === 'true' &&
    change.change?.after?.result?.records === '0' &&
    change.change?.after?.query?.admissionClosed === 'true',
);
// The Lambda module replaces these local build helpers when package content
// changes. They do not remove resident services or retained run data. Keep the
// exception limited to known helper replacements; outright removal still needs
// the native decommission preflight.
const nativePackageHelpers = new Map([
  ['terraform_data', 'package_filename_for_hash'],
  ['null_resource', 'archive'],
  ['local_file', 'archive_plan'],
]);
const replacesNativePackageHelper = (change) =>
  change.change?.actions?.includes('create') &&
  nativePackageHelpers.has(change.type) &&
  nativePackageHelpers.get(change.type) === change.name;
const removesProtectedNativeService = (change) =>
  change.address.startsWith('module.native_runs[') &&
  !nativeRemovalVerified &&
  !replacesNativePackageHelper(change);

const rejected = (plan.resource_changes || []).filter(
  (change) =>
    destructive(change) &&
    ((protectedTypes.has(change.type) && !expectedRetirement(change)) ||
      deletesPinnedRuntimeImage(change) ||
      removesProtectedNativeService(change)),
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

if (requireLambdaPackages) {
  // Match the AWS provider's needsFunctionCodeUpdate inputs. Configuration-only
  // updates do not read the local ZIP; creates, replacements and code updates do.
  const codeAttributes = [
    'filename',
    'code_sha256',
    'source_code_hash',
    's3_bucket',
    's3_key',
    's3_object_version',
    'source_kms_key_arn',
    'image_uri',
    'architectures',
  ];
  const hasUnknownValue = (value) =>
    value === true ||
    (value !== null && typeof value === 'object' && Object.values(value).some(hasUnknownValue));
  const unavailable = [];
  let checked = 0;
  for (const resource of plan.resource_changes || []) {
    if (resource.type !== 'aws_lambda_function' || resource.mode === 'data') continue;
    const { actions = [], before, after, after_unknown: unknown = {} } = resource.change ?? {};
    const needsArchive =
      actions.includes('create') ||
      (actions.includes('update') &&
        codeAttributes.some(
          (key) => hasUnknownValue(unknown[key]) || !isDeepStrictEqual(before?.[key], after?.[key]),
        ));
    if (!needsArchive) continue;
    if (unknown.filename) {
      unavailable.push(`${resource.address}: local package filename is not known in the plan`);
      continue;
    }
    // S3 and container-image delivery have no local filename to check.
    if (!after?.filename) continue;
    try {
      const file = statSync(after.filename);
      if (!file.isFile() || file.size === 0) throw new Error('archive is empty or not a file');
      accessSync(after.filename, constants.R_OK);
      checked += 1;
    } catch (error) {
      unavailable.push(`${resource.address}: ${after.filename} (${error.message})`);
    }
  }
  if (unavailable.length) {
    console.error('Refusing Terraform apply: required local Lambda packages are unavailable:');
    for (const message of unavailable) console.error(`  - ${message}`);
    console.error('Build the Lambda packages and regenerate the final saved plan before applying.');
    process.exit(1);
  }
  console.log(`Terraform Lambda package check passed (${checked} local archives).`);
}
