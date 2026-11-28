#!/usr/bin/env node
// Turns the demo deployments' MCP_GATEWAY_CONFIG JSON into a Terraform JSON
// variable file (deploy-terraform.sh passes <environment>.gateway.tfvars.json).
// Only the Gateway rollout variables are accepted; Terraform's own validations
// in terraform/variables.tf and modules/compute/agentcore/variables.tf check
// their values. The input holds provider and secret ARNs, never secret values.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BOOLEAN_KEYS = ['enable_mcp_gateway', 'enable_engine_data', 'enforce_runtime_grants'];
const KEYS = new Set([...BOOLEAN_KEYS, 'runtime_mcp_credentials', 'mcp_gateway_custom_targets']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeGatewayConfig = (input) => {
  if (!isObject(input)) {
    throw new Error('Configuration must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) {
      throw new Error(`Unsupported key "${key}"; allowed: ${[...KEYS].join(', ')}`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in input && typeof input[key] !== 'boolean') {
      throw new Error(`${key} must be true or false`);
    }
  }
  if ('runtime_mcp_credentials' in input && typeof input.runtime_mcp_credentials !== 'string') {
    throw new Error('runtime_mcp_credentials must be a string');
  }
  if ('mcp_gateway_custom_targets' in input && !isObject(input.mcp_gateway_custom_targets)) {
    throw new Error('mcp_gateway_custom_targets must be an object keyed by target name');
  }
  return Object.fromEntries(
    [...KEYS].filter((key) => key in input).map((key) => [key, input[key]]),
  );
};

// A JSON variable file, not HCL: Terraform reads its strings literally, so
// tool descriptions may contain `${...}` or `%{...}`.
export const toTfvarsJson = (config) => `${JSON.stringify(config, null, 2)}\n`;

export const loadGatewayConfig = (path) => {
  let input;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Parser errors may quote input fragments.
    throw new Error('Configuration must contain valid JSON');
  }
  return normalizeGatewayConfig(input);
};

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length > 0) {
    console.error('Usage: gateway-config.mjs <config.json>');
    process.exit(2);
  }
  try {
    process.stdout.write(toTfvarsJson(loadGatewayConfig(path)));
  } catch (error) {
    console.error(`Invalid MCP Gateway configuration: ${error.message}`);
    process.exit(2);
  }
}
