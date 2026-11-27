import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadGatewayConfig, normalizeGatewayConfig, toTfvarsJson } from '../gateway-config.mjs';

const script = new URL('../gateway-config.mjs', import.meta.url).pathname;
const run = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-gateway-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, contents);
    return spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const target = {
  endpoint: 'https://bridge.example.com/mcp',
  auth: {
    type: 'oauth',
    credential_provider_arn:
      'arn:aws:bedrock-agentcore:eu-central-1:111122223333:token-vault/default/oauth2credentialprovider/codekb',
    secret_arn: 'arn:aws:secretsmanager:eu-central-1:111122223333:secret:codekb-AbCdEf',
    scopes: ['codekb-bridge/mcp'],
  },
  allow: { project_ids: ['space-1'], tools: ['find_component'] },
};

test('emits a JSON variable file with the supplied Gateway variables, in a stable order', () => {
  const json = toTfvarsJson(
    normalizeGatewayConfig({
      mcp_gateway_custom_targets: { codekb: target },
      runtime_mcp_credentials: 'gateway_only',
      enable_mcp_gateway: true,
    }),
  );
  assert.ok(json.endsWith('\n'));
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), [
    'enable_mcp_gateway',
    'runtime_mcp_credentials',
    'mcp_gateway_custom_targets',
  ]);
  assert.deepEqual(parsed.mcp_gateway_custom_targets, { codekb: target });
});

test('an empty object configures nothing', () => {
  assert.deepEqual(JSON.parse(toTfvarsJson(normalizeGatewayConfig({}))), {});
});

const terraformAvailable = spawnSync('terraform', ['version'], { encoding: 'utf8' }).status === 0;

test(
  'Terraform reads template sequences in descriptions and tool schemas literally',
  { skip: !terraformAvailable && 'terraform is not on PATH' },
  () => {
    const description = 'Expand ${workspace} in a path; %{ if x }y%{ endif }';
    const toolSchema = JSON.stringify([
      { name: 'expand', description, inputSchema: { type: 'object' } },
    ]);
    const config = normalizeGatewayConfig({
      enable_mcp_gateway: true,
      mcp_gateway_custom_targets: {
        codekb: {
          description,
          lambda: {
            function_arn: 'arn:aws:lambda:eu-central-1:111122223333:function:codekb-tools',
            tool_schema: toolSchema,
          },
          allow: { project_ids: ['space-1'] },
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'aidlc-gateway-tfvars-'));
    try {
      writeFileSync(
        join(dir, 'main.tf'),
        'variable "enable_mcp_gateway" {\n  type = bool\n}\n' +
          'variable "mcp_gateway_custom_targets" {\n  type = any\n}\n',
      );
      writeFileSync(join(dir, 'prod.gateway.tfvars.json'), toTfvarsJson(config));
      const result = spawnSync(
        'terraform',
        [`-chdir=${dir}`, 'console', '-var-file=prod.gateway.tfvars.json'],
        { encoding: 'utf8', input: 'jsonencode(var.mcp_gateway_custom_targets)\n' },
      );
      assert.equal(result.status, 0, result.stderr);
      const read = JSON.parse(JSON.parse(result.stdout.trim()));
      assert.equal(read.codekb.description, description);
      assert.equal(read.codekb.lambda.tool_schema, toolSchema);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('rejects keys outside the Gateway rollout variables', () => {
  assert.throws(
    () => normalizeGatewayConfig({ project_name: 'other' }),
    /Unsupported key "project_name"/,
  );
  assert.throws(() => normalizeGatewayConfig({ deletion_protection: false }), /Unsupported key/);
});

test('rejects wrongly typed values', () => {
  assert.throws(() => normalizeGatewayConfig([]), /must be a JSON object/);
  assert.throws(() => normalizeGatewayConfig({ enable_mcp_gateway: 'true' }), /true or false/);
  assert.throws(
    () => normalizeGatewayConfig({ runtime_mcp_credentials: true }),
    /must be a string/,
  );
  assert.throws(
    () => normalizeGatewayConfig({ mcp_gateway_custom_targets: [target] }),
    /object keyed by target name/,
  );
});

test('malformed JSON does not disclose input fragments', () => {
  const marker = 'GATEWAY_LEAK';
  const result = run(`{"enable_mcp_gateway": ${marker}}`);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Invalid MCP Gateway configuration: Configuration must contain valid JSON\n',
  );
  assert.throws(() => loadGatewayConfig('/nonexistent/gateway.json'), {
    message: 'Configuration must contain valid JSON',
  });
});

test('the CLI prints the JSON variable file for a valid configuration', () => {
  const result = run(JSON.stringify({ enable_mcp_gateway: true, enable_engine_data: false }));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    enable_mcp_gateway: true,
    enable_engine_data: false,
  });
});
