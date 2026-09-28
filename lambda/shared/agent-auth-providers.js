import { authError, normalizeEndpoint } from './agent-auth-protocol.js';
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
    modelDiscovery: 'runtime',
    label: 'IAM',
    backend: 'bedrock',
    mechanisms: ['assume-role'],
    available: false,
  }),
  Object.freeze({
    id: 'litellm',
    modelDiscovery: 'runtime',
    label: 'LiteLLM',
    backend: 'litellm',
    mechanisms: ['api-key', 'oauth-machine', 'oauth-user'],
    available: false,
  }),
]);
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
