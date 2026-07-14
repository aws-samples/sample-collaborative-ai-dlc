// SSM parameter-name builders for MCP secrets. Thin wrapper over the SINGLE
// source of truth for the path layout — `mcpSecretsBase` in
// ../../shared/mcp-secrets-store.js (which the CRUD lambdas + the IAM policies
// are scoped to). Keeping the layout in one place means the resolver, the
// list/put store, and terraform can never drift out of sync.
//
// The prefix comes from the runtime env (`MCP_SECRETS_SSM_PREFIX`, e.g.
// `/acme/prod`, set by terraform); the layout (from mcpSecretsBase) is:
//   global  → {prefix}/mcp-secrets/{VAR}
//   project → {prefix}/projects/{projectId}/mcp-secrets/{VAR}
//
// Returns `{ globalPath, projectPath }` — two `(VAR) => name` functions the
// resolver calls per referenced var. `projectPath` throws if used without a
// projectId (a project-tier ref cannot resolve without one — a programming error).

import { mcpSecretsBase } from '../shared/mcp-secrets-store.js';

export const mcpSecretPaths = ({
  prefix = process.env.MCP_SECRETS_SSM_PREFIX || '',
  projectId,
} = {}) => ({
  globalPath: (varName) => `${mcpSecretsBase({ base: prefix })}/${varName}`,
  projectPath: (varName) => {
    if (!projectId) {
      throw new Error('Cannot resolve a project-tier MCP secret without a projectId.');
    }
    return `${mcpSecretsBase({ base: prefix, projectId })}/${varName}`;
  },
});

export default { mcpSecretPaths };
