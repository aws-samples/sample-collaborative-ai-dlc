import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const inspector = fileURLToPath(new URL('../inspect-terraform-plan.mjs', import.meta.url));

function inspect(
  actions,
  {
    type = 'aws_efs_file_system',
    address = 'module.native_runs[0].aws_efs_file_system.runs',
    name = address.split('.').at(-1).replace(/\[.*$/, ''),
    proof,
    additionalChanges = [],
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc-efs-retention-'));
  try {
    const plan = join(directory, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        resource_changes: [
          {
            address,
            type,
            name,
            change: { actions },
          },
          ...additionalChanges,
          ...(proof
            ? [
                {
                  address: 'data.external.native_decommission[0]',
                  type: 'external',
                  change: { actions: ['read'], after: proof },
                },
              ]
            : []),
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, plan], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('rejects removing or replacing native working files even when the pilot is disabled', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    const result = inspect(actions);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /aws_efs_file_system\.runs/);
  }
});

test('allows creating, updating or retaining the native filesystem', () => {
  for (const actions of [['create'], ['update'], ['no-op']]) {
    const result = inspect(actions);
    assert.equal(result.status, 0, result.stderr);
  }
});

const packageHelpers = [
  {
    type: 'terraform_data',
    address: 'module.native_runs[0].module.api.terraform_data.package_filename_for_hash[0]',
  },
  {
    type: 'null_resource',
    address: 'module.native_runs[0].module.packages["api"].null_resource.archive[0]',
  },
  {
    type: 'local_file',
    address: 'module.native_runs[0].module.packages["api"].local_file.archive_plan[0]',
  },
];

test('allows native Lambda package helper replacements for either lifecycle order', () => {
  for (const helper of packageHelpers) {
    for (const actions of [
      ['delete', 'create'],
      ['create', 'delete'],
    ]) {
      const result = inspect(actions, helper);
      assert.equal(result.status, 0, `${helper.address}: ${result.stderr}`);
    }
  }
});

test('native package helper removal still requires the decommission preflight', () => {
  for (const helper of packageHelpers) {
    const result = inspect(['delete'], helper);
    assert.equal(result.status, 1, helper.address);
  }
});

test('unrelated local helpers and resident service replacements remain protected', () => {
  for (const resource of [
    {
      type: 'terraform_data',
      address: 'module.native_runs[0].terraform_data.runtime_dependencies',
    },
    {
      type: 'null_resource',
      address: 'module.native_runs[0].null_resource.runtime_cleanup',
    },
    {
      type: 'local_file',
      address: 'module.native_runs[0].local_file.retained_manifest',
    },
    {
      type: 'aws_lambda_function',
      address: 'module.native_runs[0].module.api.aws_lambda_function.this[0]',
    },
    {
      type: 'aws_sqs_queue',
      address: 'module.native_runs[0].aws_sqs_queue.archive',
    },
  ]) {
    for (const actions of [
      ['delete', 'create'],
      ['create', 'delete'],
    ]) {
      const result = inspect(actions, resource);
      assert.equal(result.status, 1, resource.address);
    }
  }
});

test('package rebuilds do not permit protected storage deletion in the same plan', () => {
  const address = 'module.native_runs[0].aws_s3_bucket.publications';
  const result = inspect(['create', 'delete'], {
    ...packageHelpers[0],
    additionalChanges: [
      {
        address,
        type: 'aws_s3_bucket',
        name: 'publications',
        change: { actions: ['delete'] },
      },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /aws_s3_bucket\.publications/);
  assert.doesNotMatch(result.stderr, /package_filename_for_hash/);
});

test('native service removal requires an evaluated empty protected inventory and closed admission', () => {
  const service = {
    type: 'aws_lambda_function',
    address: 'module.native_runs[0].module.execution_worker[0].aws_lambda_function.this[0]',
  };
  for (const proof of [
    undefined,
    { result: { empty: 'true', records: '1' }, query: { admissionClosed: 'true' } },
    { result: { empty: 'true', records: '0' }, query: { admissionClosed: 'false' } },
  ])
    assert.equal(inspect(['delete'], { ...service, proof }).status, 1);
  const proof = { result: { empty: 'true', records: '0' }, query: { admissionClosed: 'true' } };
  assert.equal(inspect(['delete'], { ...service, proof }).status, 0);
  assert.equal(inspect(['delete'], { proof }).status, 1); // storage has its own guard
});
