import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadGatewayConfig, normalizeGatewayConfig, toTfvars } from '../gateway-config.mjs';

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

test('emits one tfvars assignment per supplied Gateway variable, in a stable order', () => {
  const tfvars = toTfvars(
    normalizeGatewayConfig({
      mcp_gateway_custom_targets: { codekb: target },
      runtime_mcp_credentials: 'gateway_only',
      enable_mcp_gateway: true,
    }),
  );
  const lines = tfvars.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'enable_mcp_gateway = true');
  assert.equal(lines[1], 'runtime_mcp_credentials = "gateway_only"');
  assert.equal(lines[2], `mcp_gateway_custom_targets = ${JSON.stringify({ codekb: target })}`);
});

test('an empty object configures nothing', () => {
  assert.equal(toTfvars(normalizeGatewayConfig({})), '');
});

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

test('the CLI prints tfvars for a valid configuration', () => {
  const result = run(JSON.stringify({ enable_mcp_gateway: true, enable_engine_data: false }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'enable_mcp_gateway = true\nenable_engine_data = false\n');
});
