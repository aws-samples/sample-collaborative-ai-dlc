// MCP secret store — per-var SSM SecureString CRUD under a tier prefix.
//   global  → {base}/mcp-secrets/{VAR}
//   project → {base}/projects/{projectId}/mcp-secrets/{VAR}
//
// One parameter per referenced `${VAR}` (the var name IS the lookup key — no
// name→path mapping table). Per-parameter storage gives independent rotate/clear,
// a clean "Set/Not set" status per field, and least-privilege reads.
//
// GET returns set-state only — NEVER a value (no WithDecryption). PUT writes a
// SecureString; an empty-string value CLEARS (DeleteParameter). The SSM clients +
// command classes are passed in so each lambda reuses its own configured client.

import {
  GetParametersByPathCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { SECRET_VAR_NAME } from './mcp-validator.js';

// The SSM path prefix for a tier's mcp-secrets bag (no trailing slash on the VAR;
// callers append `/{VAR}`). `base` is like `/{project}/{env}`.
//
// SINGLE SOURCE OF TRUTH for the MCP-secret SSM layout. The resolver's path
// builders (agentcore/mcp-secret-paths.js) wrap this, and the terraform IAM
// policies are scoped to exactly these paths — keep all three in sync by keeping
// the layout HERE only.
export const mcpSecretsBase = ({ base, projectId }) => {
  const b = String(base || '').replace(/\/+$/, '');
  return projectId ? `${b}/projects/${projectId}/mcp-secrets` : `${b}/mcp-secrets`;
};

/**
 * List the stored secret var set-state under a tier prefix. Never decrypts.
 * Returns `{ set: Record<string, true> }` — the var names are the keys (a
 * separate names array would be redundant: `Object.keys(set)`).
 */
export const listMcpSecrets = async (ssm, { base, projectId }) => {
  const path = mcpSecretsBase({ base, projectId });
  const set = {};
  let token;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: path,
        WithDecryption: false,
        MaxResults: 10,
        NextToken: token,
      }),
    );
    for (const p of res.Parameters || []) {
      const name = (p.Name || '').slice(path.length + 1); // strip `${path}/`
      if (name) set[name] = true;
    }
    token = res.NextToken;
  } while (token);
  return { set };
};

/**
 * Apply a { VAR: value } map under a tier prefix. A non-empty value writes a
 * SecureString (rotate); an empty string DELETES (clear). Rejects malformed var
 * names. Returns { written: string[], cleared: string[], errors: string[] }.
 */
export const putMcpSecrets = async (ssm, { base, projectId, secrets }) => {
  const path = mcpSecretsBase({ base, projectId });
  const written = [];
  const cleared = [];
  const errors = [];
  for (const [name, rawValue] of Object.entries(secrets || {})) {
    if (!SECRET_VAR_NAME.test(name)) {
      errors.push(`${name}: invalid variable name`);
      continue;
    }
    const paramName = `${path}/${name}`;
    const value = typeof rawValue === 'string' ? rawValue : '';
    try {
      if (value.trim() === '') {
        await ssm.send(new DeleteParameterCommand({ Name: paramName }));
        cleared.push(name);
      } else {
        await ssm.send(
          new PutParameterCommand({
            Name: paramName,
            Value: value,
            Type: 'SecureString',
            Overwrite: true,
          }),
        );
        written.push(name);
      }
    } catch (e) {
      // A clear of a not-yet-set secret is a no-op, not an error.
      if (e?.name === 'ParameterNotFound') {
        cleared.push(name);
        continue;
      }
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { written, cleared, errors };
};

export default { mcpSecretsBase, listMcpSecrets, putMcpSecrets };
