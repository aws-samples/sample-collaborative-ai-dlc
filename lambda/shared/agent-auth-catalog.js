// Public, dependency-free contracts. Keep AWS clients and secret values out of
// this module: APIs, brokers, runtimes and the frontend share these identifiers.
export const AGENT_CREDENTIAL_PROVIDERS = Object.freeze(['bedrock', 'kiro']);
export const AGENT_CREDENTIAL_SOURCES = Object.freeze(['user', 'space', 'platform']);
export const AGENT_CREDENTIAL_METADATA_ACTIONS = Object.freeze({
  READ_SCOPE_STATUS: 'read-agent-credential-scope-status',
  RESOLVE_EFFECTIVE_BINDINGS: 'resolve-effective-agent-credential-bindings',
  LIST_SCOPES: 'list-agent-credential-scopes',
});
export const AGENT_CLI_PROVIDER = Object.freeze({
  kiro: 'kiro',
  claude: 'bedrock',
  opencode: 'bedrock',
  codex: 'bedrock',
});
export const KEY_PROVIDERS = Object.freeze({
  bedrock: Object.freeze({
    parameterName: 'bedrock-bearer-token',
    inputField: 'bedrockBearerToken',
    setField: 'bedrockBearerTokenSet',
    envName: 'AWS_BEARER_TOKEN_BEDROCK',
    label: 'Bedrock',
  }),
  kiro: Object.freeze({
    parameterName: 'kiro-api-key',
    inputField: 'kiroApiKey',
    setField: 'kiroApiKeySet',
    envName: 'KIRO_API_KEY',
    label: 'Kiro',
  }),
});
export const AGENT_AUTH_PROTOCOL_VERSION = 2;
export const AGENT_AUTH_MODES_CATALOG = Object.freeze([
  Object.freeze({
    id: 'keys',
    label: 'Keys',
    backend: 'bedrock',
    mechanisms: ['api-key'],
    available: true,
  }),
  Object.freeze({
    id: 'iam',
    label: 'IAM',
    backend: 'bedrock',
    mechanisms: ['assume-role'],
    available: false,
  }),
  Object.freeze({
    id: 'litellm',
    label: 'LiteLLM',
    backend: 'litellm',
    mechanisms: ['api-key', 'oauth-machine', 'oauth-user'],
    available: false,
  }),
]);
export const AUTH_MECHANISMS = Object.freeze({
  'api-key': Object.freeze({ scopes: AGENT_CREDENTIAL_SOURCES, refreshable: false }),
  'assume-role': Object.freeze({
    scopes: ['platform', 'space'],
    refreshable: true,
    platformAdminOnly: true,
  }),
  'oauth-machine': Object.freeze({ scopes: ['platform', 'space'], refreshable: true }),
  'oauth-user': Object.freeze({ scopes: ['space'], refreshable: true, shared: true }),
});
export const AGENT_CREDENTIAL_ENV_NAMES = Object.freeze(
  Object.values(KEY_PROVIDERS).map(({ envName }) => envName),
);
export const authError = (code, message) => Object.assign(new Error(message), { code });
export const assertIdentifier = (value, label = 'identifier') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value.length > 200) {
    throw authError('AGENT_AUTH_INVALID', `${label} is invalid`);
  }
  return value;
};
export const assertProvider = (provider) => {
  if (!AGENT_CREDENTIAL_PROVIDERS.includes(provider)) {
    throw authError('AGENT_AUTH_INVALID', `Unsupported agent credential provider: ${provider}`);
  }
  return provider;
};
export const assertSource = (source) => {
  if (!AGENT_CREDENTIAL_SOURCES.includes(source)) {
    throw authError('AGENT_AUTH_INVALID', `Unsupported agent credential source: ${source}`);
  }
  return source;
};
const revision = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw authError('AGENT_AUTH_INVALID', `${label} is invalid`);
  return value;
};
export const credentialProviderForCli = (cli) => AGENT_CLI_PROVIDER[cli] ?? null;
export const credentialEnvName = (provider) => KEY_PROVIDERS[assertProvider(provider)].envName;
export const isConfiguredCredentialValue = (value) =>
  typeof value === 'string' && value.trim() !== '' && value.trim() !== 'placeholder';

export const normalizeEndpoint = (value, label = 'endpoint') => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw authError('AGENT_AUTH_INVALID', `${label} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw authError(
      'AGENT_AUTH_INVALID',
      `${label} must be an HTTPS URL without credentials, query or fragment`,
    );
  }
  return url.href.replace(/\/+$/, '');
};
export const normalizeConnectionConfiguration = (backend, mechanism, configuration = {}) => {
  const out = {};
  const allowed =
    backend === 'litellm'
      ? ['endpoint', 'audience', 'issuer', 'clientId', 'scopes']
      : backend === 'bedrock' && mechanism === 'assume-role'
        ? ['region', 'roleArn']
        : ['region'];
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    Object.keys(configuration).some((key) => !allowed.includes(key))
  ) {
    throw authError('AGENT_AUTH_INVALID', 'Connection configuration contains unsupported fields');
  }
  for (const [key, value] of Object.entries(configuration)) {
    if (key === 'scopes') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
        throw authError('AGENT_AUTH_INVALID', 'OAuth scopes are invalid');
      }
      out.scopes = [...new Set(value)].toSorted();
    } else {
      if (typeof value !== 'string' || !value.trim())
        throw authError('AGENT_AUTH_INVALID', `${key} is invalid`);
      out[key] = ['endpoint', 'issuer'].includes(key)
        ? normalizeEndpoint(value, key)
        : value.trim();
    }
  }
  if (backend === 'litellm' && !out.endpoint)
    throw authError('AGENT_AUTH_INVALID', 'Gateway endpoint is required');
  if (mechanism.startsWith('oauth-') && (!out.issuer || !out.clientId || !out.audience)) {
    throw authError('AGENT_AUTH_INVALID', 'OAuth issuer, clientId and audience are required');
  }
  if (
    mechanism === 'assume-role' &&
    (!out.region ||
      !/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(out.roleArn || ''))
  ) {
    throw authError('AGENT_AUTH_INVALID', 'IAM role ARN and region are required');
  }
  return out;
};
export const normalizeConnection = (connection) => {
  if (!connection || typeof connection !== 'object')
    throw authError('AGENT_AUTH_INVALID', 'Connection is required');
  const { backend, mechanism } = connection;
  const mode = connection.mode ?? (backend === 'kiro' ? 'kiro' : null);
  const descriptor = AGENT_AUTH_MODES_CATALOG.find((candidate) => candidate.id === mode);
  if (
    !(backend === 'kiro' && mode === 'kiro' && mechanism === 'api-key') &&
    (!descriptor || descriptor.backend !== backend || !descriptor.mechanisms.includes(mechanism))
  ) {
    throw authError(
      'AGENT_AUTH_INVALID',
      'Connection backend and authentication mechanism do not match its mode',
    );
  }
  const source = assertSource(connection.source);
  if (!AUTH_MECHANISMS[mechanism].scopes.includes(source))
    throw authError('AGENT_AUTH_INVALID', 'Authentication mechanism does not support this scope');
  const state = connection.state ?? 'ready';
  if (!['ready', 'reconnect-required', 'revoked', 'retired'].includes(state))
    throw authError('AGENT_AUTH_INVALID', 'Connection state is invalid');
  return {
    id: assertIdentifier(connection.id, 'connectionId'),
    revision: revision(connection.revision, 'connectionRevision'),
    mode,
    backend,
    mechanism,
    source,
    state,
    ...(source === 'space'
      ? { projectId: assertIdentifier(connection.projectId, 'projectId') }
      : {}),
    ...(source === 'user' ? { userId: assertIdentifier(connection.userId, 'userId') } : {}),
    configuration: normalizeConnectionConfiguration(backend, mechanism, connection.configuration),
  };
};
export const connectionAudience = (connection) => {
  const {
    endpoint = null,
    issuer = null,
    audience = null,
    clientId = null,
    scopes = [],
  } = connection.configuration;
  return JSON.stringify([connection.backend, endpoint, issuer, audience, clientId, scopes]);
};
export const assertMatchingConnection = (connection, effective) => {
  if (
    connection.mode !== effective.mode ||
    connectionAudience(connection) !== connectionAudience(effective)
  ) {
    throw authError(
      'AGENT_AUTH_DESTINATION_MISMATCH',
      'Credential does not belong to the effective gateway and identity configuration',
    );
  }
};
export const normalizeCredentialBinding = (binding) => {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  if (binding.version !== undefined && binding.version !== 1 && binding.version !== 2)
    throw authError('AGENT_AUTH_INVALID', 'Unsupported credential binding version');
  const source = assertSource(binding.source);
  if (binding.version !== 2) {
    // A historical Bedrock binding ALWAYS means a bearer key, irrespective of policy.
    return {
      provider: assertProvider(binding.provider),
      source,
      ...(source === 'user' ? { userId: assertIdentifier(binding.userId, 'userId') } : {}),
    };
  }
  const connection = normalizeConnection({
    id: binding.connectionId,
    revision: binding.connectionRevision,
    mode: binding.mode,
    backend: binding.backend,
    mechanism: binding.mechanism,
    source,
    projectId: binding.projectId,
    userId: binding.userId,
    configuration: binding.configuration,
  });
  if (binding.provider !== connection.backend)
    throw authError('AGENT_AUTH_INVALID', 'Credential provider does not match backend');
  return {
    version: 2,
    provider: connection.backend,
    source,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    policyRevision: revision(binding.policyRevision, 'policyRevision'),
    mode: connection.mode,
    backend: connection.backend,
    mechanism: connection.mechanism,
    configuration: connection.configuration,
    ...(source === 'space' ? { projectId: connection.projectId } : {}),
    ...(source === 'user' ? { userId: connection.userId } : {}),
  };
};
export const bindingIdentity = (binding) => JSON.stringify(normalizeCredentialBinding(binding));
export const legacyPlatformBinding = (cli) => {
  const provider = credentialProviderForCli(cli);
  return provider ? { provider, source: 'platform' } : null;
};
export const assertRuntimeSupportsBinding = (binding, capabilities = {}) => {
  if (!binding || binding.version !== 2) return;
  if (
    (capabilities.agentAuthProtocol ?? 1) < 2 ||
    !capabilities.agentAuthModes?.includes(binding.mode === 'kiro' ? 'keys' : binding.mode)
  ) {
    throw authError(
      'AGENT_AUTH_RUNTIME_UNSUPPORTED',
      'Publish an environment with support for the selected authentication mode before starting new work',
    );
  }
};
export const credentialSourcesFromBindings = (bindings = {}) => ({
  bedrock: bindings.bedrock?.source ?? null,
  kiro: bindings.kiro?.source ?? null,
});
export const availableClisForBindings = ({ installed = [], bindings = {} } = {}) =>
  installed.filter((cli) => Boolean(bindings[credentialProviderForCli(cli)]));

export const credentialBindingDisplay = (binding, cli = null) => {
  const selected = normalizeCredentialBinding(binding) ?? legacyPlatformBinding(cli);
  if (!selected) return null;
  return {
    mode: selected.mode ?? (selected.provider === 'kiro' ? 'kiro' : 'keys'),
    backend: selected.backend ?? selected.provider,
    mechanism: selected.mechanism ?? 'api-key',
    source: selected.source,
    connectionId: selected.connectionId ?? null,
    connectionRevision: selected.connectionRevision ?? null,
    policyRevision: selected.policyRevision ?? null,
    configuration: selected.configuration ?? {},
    legacy: selected.version !== 2,
  };
};

export const credentialChangeAffects = (candidate, binding, projectId) =>
  candidate?.kind === 'credential-update' &&
  binding &&
  (binding.version !== 2 || binding.connectionId?.startsWith('legacy-')) &&
  candidate.source === binding.source &&
  (candidate.source !== 'space' || candidate.projectId === projectId) &&
  (candidate.source !== 'user' || candidate.userId === binding.userId) &&
  candidate.changes.some((change) => change.provider === binding.provider);
