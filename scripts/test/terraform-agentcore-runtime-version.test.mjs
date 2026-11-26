import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const moduleRoot = new URL('../../terraform/modules/compute/agentcore/', import.meta.url);
const observation = readFileSync(new URL('runtime-observation.tf', moduleRoot), 'utf8');
const outputs = readFileSync(new URL('outputs.tf', moduleRoot), 'utf8');
const resource = 'awscc_bedrockagentcore_runtime.stage_executor';

test('observes the runtime after updates even when its ID does not change', () => {
  assert.match(observation, /data "awscc_bedrockagentcore_runtime" "stage_executor_observed"\s*\{/);
  assert.match(observation, /id\s*=\s*awscc_bedrockagentcore_runtime\.stage_executor\.id/);
  assert.match(
    observation,
    /depends_on\s*=\s*\[\s*awscc_bedrockagentcore_runtime\.stage_executor\s*\]/,
  );
  const versionOutput = outputs.match(/output "runtime_version"\s*\{([^}]+)\}/)?.[1];
  assert.ok(versionOutput, 'runtime_version output exists');
  assert.match(
    versionOutput,
    /value\s*=\s*data\.awscc_bedrockagentcore_runtime\.stage_executor_observed\.agent_runtime_version/,
  );
});

test('actual Terraform postconditions accept the new version and reject unsafe observations', () => {
  // Evaluate the production HCL expressions, not a JavaScript copy of the guards.
  // This uses a provider-free console: no plan, apply, backend or AWS access.
  const conditions = [
    ...observation.matchAll(/postcondition\s*\{\s*condition\s*=\s*([\s\S]*?)\s+error_message\s*=/g),
  ].map((match) =>
    match[1]
      .replaceAll('self.', 'fixture.observed.')
      .replaceAll(`${resource}.`, 'fixture.expected.'),
  );
  assert.equal(conditions.length, 4);
  const expected = {
    agent_runtime_id: 'shared_runtime-abcdefghij',
    agent_runtime_arn:
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/shared_runtime-abcdefghij',
    agent_runtime_name: 'shared_runtime',
    // The resource's computed version is stale; it must not gate the new read.
    agent_runtime_version: '112',
    agent_runtime_artifact: {
      container_configuration: {
        container_uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'d'.repeat(64)}`,
      },
      code_configuration: null,
    },
    environment_variables: { AWS_REGION: 'us-east-1', NATIVE_INTERACTION_PROBE_ENABLED: 'true' },
    role_arn: 'arn:aws:iam::123456789012:role/agentcore',
  };
  const ready = { ...structuredClone(expected), agent_runtime_version: '113', status: 'READY' };
  const fixtures = [
    { name: 'new version despite stale resource version', observed: ready, pass: true },
  ];
  const reject = (name, modify) => {
    const observed = structuredClone(ready);
    modify(observed);
    fixtures.push({ name, observed, pass: false });
  };
  for (const status of ['CREATING', 'UPDATING', 'UPDATE_FAILED', null]) {
    reject(`status ${status}`, (value) => {
      value.status = status;
    });
  }
  for (const version of ['0', 'latest', '', null, '100000']) {
    reject(`version ${version}`, (value) => {
      value.agent_runtime_version = version;
    });
  }
  for (const field of ['agent_runtime_id', 'agent_runtime_arn', 'agent_runtime_name', 'role_arn']) {
    reject(`different ${field}`, (value) => {
      value[field] += '-other';
    });
    reject(`missing ${field}`, (value) => {
      delete value[field];
    });
  }
  reject('old image reported with old version', (value) => {
    value.agent_runtime_version = '112';
    value.agent_runtime_artifact.container_configuration.container_uri =
      expected.agent_runtime_artifact.container_configuration.container_uri.replace(
        'd'.repeat(64),
        'a'.repeat(64),
      );
  });
  reject('missing container configuration', (value) => {
    value.agent_runtime_artifact.container_configuration = null;
  });
  reject('unexpected code artifact', (value) => {
    value.agent_runtime_artifact.code_configuration = { runtime: 'NODE_22' };
  });
  reject('old environment with the same desired image', (value) => {
    value.environment_variables.NATIVE_INTERACTION_PROBE_ENABLED = 'false';
  });
  reject('unexpected environment variable', (value) => {
    value.environment_variables.EXTRA = 'unapproved';
  });
  reject('missing environment variable', (value) => {
    delete value.environment_variables.AWS_REGION;
  });
  reject('missing environment', (value) => {
    value.environment_variables = null;
  });

  const directory = mkdtempSync(join(tmpdir(), 'aidlc-runtime-observation-'));
  try {
    writeFileSync(join(directory, 'main.tf'), 'variable "fixtures" { type = any }\n');
    writeFileSync(
      join(directory, 'terraform.tfvars.json'),
      JSON.stringify({ fixtures: fixtures.map((fixture) => ({ ...fixture, expected })) }),
    );
    const expression = `jsonencode([for fixture in var.fixtures : {name = fixture.name, checks = [${conditions.join(',')}]}])`;
    const result = spawnSync('terraform', ['console', '-no-color'], {
      cwd: directory,
      input: `${expression.replaceAll('\n', ' ')}\n`,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_WORKSPACE: 'default' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const evaluated = JSON.parse(JSON.parse(result.stdout.trim()));
    assert.equal(evaluated.length, fixtures.length);
    for (const [index, value] of evaluated.entries()) {
      assert.equal(value.name, fixtures[index].name);
      assert.equal(
        value.checks.every((check) => check === true),
        fixtures[index].pass,
        value.name,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
