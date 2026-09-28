import {
  AGENT_CLI_PROVIDER,
  AUTH_MECHANISMS,
  authError,
  assertIdentifier,
  assertProvider,
  assertSource,
} from './agent-auth-protocol.js';
import {
  KEY_PROVIDERS,
  AGENT_AUTH_MODES_CATALOG,
  normalizeConnectionConfiguration,
} from './agent-auth-providers.js';
const revision = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw authError('AGENT_AUTH_INVALID', `${label} is invalid`);
  return value;
};

export * from './agent-auth-protocol.js';
export const AGENT_CREDENTIAL_ENV_NAMES = Object.freeze(
  Object.values(KEY_PROVIDERS).map(({ envName }) => envName),
);
export const credentialProviderForCli = (cli) => AGENT_CLI_PROVIDER[cli] ?? null;
export const credentialEnvName = (provider) => KEY_PROVIDERS[assertProvider(provider)].envName;
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
