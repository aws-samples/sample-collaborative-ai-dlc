// Deployment profile for custom MCP credentials (Terraform
// `runtime_mcp_credentials`, env RUNTIME_MCP_CREDENTIALS):
//   allow        — today's behaviour: space and platform custom MCP servers
//                  run from the agent runtime, their `${VAR}` secrets resolved
//                  into it at stage start. The default; the variable is unset.
//   gateway_only — no custom MCP credential and no direct custom MCP
//                  connection reaches the runtime microVM. Customer MCP servers
//                  are served only as AgentCore Gateway targets
//                  (`mcp_gateway_custom_targets`), whose credentials the
//                  Gateway injects. Direct entries are refused where they are
//                  written, before a stage is dispatched, by the credential
//                  broker and by the runtime itself — always loudly, never by
//                  silently dropping a server the space configured.
// One helper for every enforcement point so they cannot drift.
export const RUNTIME_MCP_CREDENTIALS_ENV = 'RUNTIME_MCP_CREDENTIALS';
export const RUNTIME_MCP_CREDENTIAL_MODES = Object.freeze(['allow', 'gateway_only']);
export const RUNTIME_MCP_GATEWAY_ONLY = 'runtime_mcp_gateway_only';
export const RUNTIME_MCP_GATEWAY_ONLY_MESSAGE =
  'This deployment serves custom MCP servers only through the AgentCore Gateway ' +
  '(runtime_mcp_credentials = "gateway_only"): direct MCP servers and their secrets ' +
  'never reach the agent runtime. Remove the MCP servers from Space Settings and ' +
  'Platform Admin settings, and ask a platform administrator to add the server as a ' +
  'Gateway target (mcp_gateway_custom_targets).';

export class RuntimeMcpPolicyError extends Error {
  constructor(message = RUNTIME_MCP_GATEWAY_ONLY_MESSAGE) {
    super(message);
    this.name = 'RuntimeMcpPolicyError';
    this.code = RUNTIME_MCP_GATEWAY_ONLY;
  }
}

// An unknown value is a deployment error, not a reason to fall back to allow.
export const runtimeMcpCredentialsMode = (env = process.env) => {
  const value = env[RUNTIME_MCP_CREDENTIALS_ENV];
  if (value === undefined || value === '') return 'allow';
  if (!RUNTIME_MCP_CREDENTIAL_MODES.includes(value)) {
    throw new Error(`${RUNTIME_MCP_CREDENTIALS_ENV} must be one of allow, gateway_only`);
  }
  return value;
};

export const gatewayOnlyMcp = (env = process.env) =>
  runtimeMcpCredentialsMode(env) === 'gateway_only';

const serverCount = (servers) =>
  servers && typeof servers === 'object' && !Array.isArray(servers)
    ? Object.keys(servers).length
    : 0;

// Any entry counts — stdio or remote, with or without `${VAR}` refs or inline
// headers: each is a direct connection from the runtime.
export const hasDirectMcpServers = (serversByTier) =>
  serverCount(serversByTier?.global) > 0 || serverCount(serversByTier?.project) > 0;

// The execution META fields that carry direct MCP configuration, inline
// headers and environment values included. An intent started under `allow`
// keeps them after the deployment moves to gateway_only, so every runtime-facing
// response that carries META (engine-data) projects them out. The runtime never
// reads them from META: run-stage receives its tiers from the orchestrator.
export const DIRECT_MCP_META_FIELDS = Object.freeze(['mcpServersByTier', 'customMcpServers']);

export const withoutDirectMcpConfig = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  if (!DIRECT_MCP_META_FIELDS.some((field) => Object.hasOwn(record, field))) return record;
  const projected = { ...record };
  for (const field of DIRECT_MCP_META_FIELDS) delete projected[field];
  return projected;
};

// `config` is one tier's name-keyed map (an editor save).
export const assertDirectMcpConfigAllowed = (config, env = process.env) => {
  if (gatewayOnlyMcp(env) && serverCount(config) > 0) throw new RuntimeMcpPolicyError();
};

// Setting a secret value is refused; clearing one (empty string) stays allowed
// so an administrator can remove what an earlier `allow` deployment stored.
export const assertMcpSecretWritesAllowed = (secrets, env = process.env) => {
  if (
    gatewayOnlyMcp(env) &&
    secrets &&
    typeof secrets === 'object' &&
    Object.values(secrets).some((value) => value !== '')
  ) {
    throw new RuntimeMcpPolicyError();
  }
};
