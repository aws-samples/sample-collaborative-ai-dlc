import { credentialEnvName, authError } from '../shared/agent-auth-contracts.js';

// Keys deliver the API key in the CLI provider's env var. Kiro bindings qualify as 'keys'.
export const KEYS_RUNTIME_PROVIDER = Object.freeze({
  id: 'keys',
  modes: Object.freeze(['keys']),
  materials: Object.freeze({
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
  }),
});
