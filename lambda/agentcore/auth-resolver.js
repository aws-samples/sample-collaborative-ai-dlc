// Auth resolver — at container startup, fetch the agent CLI's Bedrock bearer
// token + Kiro API key from SSM and expose them as the env vars the CLI drivers
// read (AWS_BEARER_TOKEN_BEDROCK / KIRO_API_KEY).
//
// Why: terraform passes the SSM *paths* (BEDROCK_BEARER_TOKEN_SSM_PATH /
// KIRO_API_KEY_SSM_PATH), not the secrets. The drivers' envForAuth() only forward
// AWS_BEARER_TOKEN_BEDROCK / KIRO_API_KEY if already present — so without this
// step the token is never set and Claude Code silently falls back to task-role
// SigV4 (which the execution role is not granted), yielding a 403.
//
// Best-effort + idempotent: a missing path or an SSM miss is skipped (the CLI may
// be configured another way, or only one CLI is installed); an already-populated
// env var is never overwritten. Pure-ish: the SSM getter is injected for tests.

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Map of target env var → the env var holding its SSM path.
const SSM_PATH_ENV = {
  AWS_BEARER_TOKEN_BEDROCK: 'BEDROCK_BEARER_TOKEN_SSM_PATH',
  KIRO_API_KEY: 'KIRO_API_KEY_SSM_PATH',
};

// Fetch one decrypted SSM SecureString; returns '' on any miss/error.
const defaultGetParam = (client) => async (name) => {
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value ?? '';
  } catch {
    return '';
  }
};

// Resolve the auth secrets into `env` in place. Returns the list of target env
// vars that were populated (for a startup log line — never the values).
export const resolveAgentAuth = async ({ env = process.env, getParam } = {}) => {
  const get = getParam ?? defaultGetParam(new SSMClient({ region: env.AWS_REGION || 'us-east-1' }));
  const resolved = [];
  for (const [target, pathEnv] of Object.entries(SSM_PATH_ENV)) {
    if (env[target]) continue; // already set — never overwrite
    const path = env[pathEnv];
    if (!path) continue; // no path configured for this CLI
    const value = await get(path);
    if (value) {
      env[target] = value;
      resolved.push(target);
    }
  }
  return resolved;
};
