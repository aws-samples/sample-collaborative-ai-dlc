import { credentialEnvName, authError } from '../shared/agent-auth-contracts.js';
export const CREDENTIAL_MATERIAL_ADAPTERS = Object.freeze({
  'api-key': ({ binding, material }) => {
    if (binding.mechanism && binding.mechanism !== 'api-key')
      throw authError(
        'AGENT_AUTH_LEASE_INVALID',
        'Credential material does not match the pinned mechanism',
      );
    if (typeof material.value !== 'string' || !material.value)
      throw authError('AGENT_AUTH_LEASE_INVALID', 'API key material is invalid');
    return { env: { [credentialEnvName(binding.provider)]: material.value } };
  },
});

export const CREDENTIAL_RESPONSE_READERS = [];
export const isAuthenticatedEnvironment = (provider, env) =>
  Boolean(env[credentialEnvName(provider)]);

export const CREDENTIAL_ADAPTER_ENV_NAMES = [];
