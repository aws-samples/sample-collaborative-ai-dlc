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
export const AGENT_AUTH_PROTOCOL_VERSION = 2;
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
export const isConfiguredCredentialValue = (value) =>
  typeof value === 'string' && value.trim() !== '' && value.trim() !== 'placeholder';

export const withoutTrailingSlashes = (value) => {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
};

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
  return withoutTrailingSlashes(url.href);
};

export const normalizeRequestedProviders = (providers = AGENT_CREDENTIAL_PROVIDERS) => {
  if (
    !Array.isArray(providers) ||
    !providers.length ||
    providers.length > AGENT_CREDENTIAL_PROVIDERS.length
  )
    throw authError('AGENT_AUTH_INVALID', 'Requested credential providers are invalid');
  const selected = providers.map(assertProvider);
  if (new Set(selected).size !== selected.length)
    throw authError('AGENT_AUTH_INVALID', 'Requested credential providers must be unique');
  return selected;
};
