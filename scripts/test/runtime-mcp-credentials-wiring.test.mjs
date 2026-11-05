import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// runtime_mcp_credentials = gateway_only is enforced by one helper
// (lambda/shared/runtime-mcp-policy.js) that reads RUNTIME_MCP_CREDENTIALS.
// Every Lambda with an enforcement point must receive it, and the root must
// refuse the profile without the grant-checked paths it relies on.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const block = (path, kind, name) => {
  const found = read(path).match(new RegExp(`${kind} "${name}" \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(found, `missing ${kind} "${name}" in ${path}`);
  return found;
};

test('the enforcing Lambdas receive the profile only when it is gateway_only', () => {
  const lambdas = 'terraform/modules/api/lambda/main.tf';
  assert.match(
    read(lambdas),
    /runtime_mcp_policy_env = var\.runtime_mcp_credentials == "gateway_only" \? \{\s*RUNTIME_MCP_CREDENTIALS = "gateway_only"\s*\} : \{\}/,
  );
  for (const name of [
    'credential_broker_lambda',
    'projects_lambda',
    'intents_lambda',
    'v2_orchestrator_lambda',
  ]) {
    assert.match(
      block(lambdas, 'module', name),
      /environment_variables = merge\([\s\S]*local\.runtime_mcp_policy_env\)/,
      `${name} must receive RUNTIME_MCP_CREDENTIALS`,
    );
  }
  assert.match(
    block('terraform/modules/api/agents.tf', 'module', 'agents_lambda'),
    /var\.runtime_mcp_credentials == "gateway_only" \? \{ RUNTIME_MCP_CREDENTIALS = "gateway_only" \} : \{\}/,
  );
  // engine-data projects the stored MCP configuration out of runtime-facing META.
  assert.match(
    block('terraform/modules/compute/agentcore/engine-data.tf', 'module', 'engine_data_lambda'),
    /environment_variables = merge\(\{[\s\S]*\}, var\.runtime_mcp_credentials == "gateway_only" \? \{\s*RUNTIME_MCP_CREDENTIALS = "gateway_only"\s*\} : \{\}\)/,
    'engine_data_lambda must receive RUNTIME_MCP_CREDENTIALS',
  );
  // The runtime's environment and IAM are covered by
  // terraform/tests/mcp-gateway-custom-targets.tftest.hcl.
});

test('the root passes the profile to every module that enforces it', () => {
  for (const name of ['lambda', 'api', 'agentcore']) {
    assert.match(
      block('terraform/main.tf', 'module', name),
      /runtime_mcp_credentials\s+= var\.runtime_mcp_credentials/,
      `module "${name}" must receive runtime_mcp_credentials`,
    );
  }
});

test('gateway_only requires the Gateway, engine-data and enforced runtime grants', () => {
  const preconditions = block(
    'terraform/main.tf',
    'resource "terraform_data"',
    'runtime_mcp_credentials_preconditions',
  );
  assert.match(preconditions, /count = var\.runtime_mcp_credentials == "gateway_only" \? 1 : 0/);
  for (const variable of ['enable_mcp_gateway', 'enable_engine_data', 'enforce_runtime_grants']) {
    assert.match(preconditions, new RegExp(`condition\\s+= var\\.${variable}\\n`));
  }
});
