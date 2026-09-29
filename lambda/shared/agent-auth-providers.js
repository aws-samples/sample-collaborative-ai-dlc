import { createAuthModeRegistry } from './agent-auth-mode-registry.js';
import { AGENT_AUTH_MODE_DESCRIPTORS } from './agent-auth-modes.js';
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
// Built at load from the root, so a misregistered mode fails the Lambda or image at init.
const AUTH_MODES = createAuthModeRegistry(AGENT_AUTH_MODE_DESCRIPTORS);
export const AGENT_AUTH_MODES_CATALOG = AUTH_MODES.catalog;
export const authModeDescriptor = (id) => AUTH_MODES.get(id);
