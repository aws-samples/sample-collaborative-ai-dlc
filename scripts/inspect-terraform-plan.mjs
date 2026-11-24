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

// An old absolute Yjs context is a bridge for a no-op on persisted state.
// A real build must read this checkout, including when applying a saved plan.
const legacyYjsContext = plan.variables?.yjs_legacy_build_context?.value;
if (
  legacyYjsContext &&
  plan.resource_changes?.some(
    (change) =>
      change.address === 'module.yjs_server.module.yjs_docker_build.docker_image.this' &&
      change.change.actions.includes('create') &&
      change.change.after?.build?.some((build) => build.context === legacyYjsContext),
  )
) {
  console.error(
    'A Yjs build is required. Remove yjs_legacy_build_context and plan from the current checkout.',
  );
  process.exit(1);
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

const nativeRemovalVerified = (plan.resource_changes || []).some(
  (change) =>
    change.address === 'data.external.native_decommission[0]' &&
    change.change?.after?.result?.empty === 'true' &&
    change.change?.after?.result?.records === '0' &&
    change.change?.after?.query?.admissionClosed === 'true',
);
// The Lambda module replaces these local build helpers when package content
// changes. They do not remove resident services or retained run data. Keep the
// exception limited to known helper replacements and cleanup of their deposed
// instances; outright removal still needs the native decommission preflight.
const nativePackageHelpers = new Map([
  ['terraform_data', 'package_filename_for_hash'],
  ['null_resource', 'archive'],
  ['local_file', 'archive_plan'],
]);
const isNativePackageHelper = (change) =>
  nativePackageHelpers.has(change.type) && nativePackageHelpers.get(change.type) === change.name;
const replacesNativePackageHelper = (change) =>
  change.change?.actions?.includes('create') && isNativePackageHelper(change);
const currentChanges = new Map(
  (plan.resource_changes || [])
    .filter((change) => !change.deposed)
    .map((change) => [change.address, change]),
);
const removesDeposedPackageHelper = (change) => {
  if (
    !isNativePackageHelper(change) ||
    change.mode !== 'managed' ||
    typeof change.deposed !== 'string' ||
    change.deposed.length === 0 ||
    !isDeepStrictEqual(change.change?.actions, ['delete'])
  )
    return false;

  // Interrupted create-before-destroy applies can leave an old instance for a
  // later plan to delete. Require the same helper's current instance to survive.
  const current = currentChanges.get(change.address);
  return (
    current?.mode === 'managed' &&
    current.type === change.type &&
    current.name === change.name &&
    current.change?.after != null &&
    (current.change.actions.includes('create') ||
      isDeepStrictEqual(current.change.actions, ['no-op']) ||
      isDeepStrictEqual(current.change.actions, ['update']))
  );
};
// A method cutover retires only these dedicated engine resources. Retained
// runs still depend on the ordinary authority, storage and Git builder. A
// partial listing, service replacement or loss of the image policy is unsafe.
const retiredMethodResources = new Set([
  'aws_lambda_function.workflow_engine',
  'aws_cloudwatch_log_group.workflow_engine',
  'aws_iam_role.workflow_engine',
  'aws_iam_role_policy.workflow_engine',
  'aws_iam_role_policy_attachment.workflow_engine_basic',
  'aws_codebuild_project.workflow',
  'aws_iam_role.workflow_check',
  'aws_iam_role_policy.workflow_check',
  'aws_iam_policy.workflow_review_boundary',
]);
const nativePrefix = 'module.native_runs[0].';
const keepsNativeMethodConsumers = [
  'aws_dynamodb_table.bindings',
  'aws_s3_bucket.publications',
  'module.authority.aws_lambda_function.this[0]',
  'aws_lambda_function.git_result',
  'aws_ecr_repository_policy.git_result',
].every((suffix) => {
  const current = currentChanges.get(nativePrefix + suffix);
  return (
    current?.mode === 'managed' &&
    current.change.before &&
    current.change.after &&
    (isDeepStrictEqual(current.change.actions, ['no-op']) ||
      isDeepStrictEqual(current.change.actions, ['update']))
  );
});
const retiresMethodResource = (change) =>
  keepsNativeMethodConsumers &&
  change.mode === 'managed' &&
  change.address === nativePrefix + change.type + '.' + change.name &&
  retiredMethodResources.has(change.type + '.' + change.name) &&
  isDeepStrictEqual(change.change.actions, ['delete']);
const removesProtectedNativeService = (change) =>
  change.address.startsWith('module.native_runs[') &&
  !nativeRemovalVerified &&
  !retiresMethodResource(change) &&
  !replacesNativePackageHelper(change) &&
  !removesDeposedPackageHelper(change);

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
