import { credentialEnvName, authError } from '../shared/agent-auth-contracts.js';
import { listCodexModels } from '../shared/bedrock-models.js';
import { listMantleModels } from './mantle-models.js';
import { BEDROCK_GATEWAY_TOKEN_ENV, bedrockGatewayUrl } from './cli/backend-adapters.js';

// Keys deliver the API key in the CLI provider's env var. Kiro bindings qualify as 'keys'.
// With a Bedrock gateway configured, a Bedrock key is delivered as the gateway token instead.
export const KEYS_RUNTIME_PROVIDER = Object.freeze({
  id: 'keys',
  modes: Object.freeze(['keys']),
  controlledEnv: Object.freeze([BEDROCK_GATEWAY_TOKEN_ENV]),
  materials: Object.freeze({
    'api-key': ({ binding, material, env = {} }) => {
      if (binding.mechanism && binding.mechanism !== 'api-key')
        throw authError(
          'AGENT_AUTH_LEASE_INVALID',
          'Credential material does not match the pinned mechanism',
        );
      if (typeof material.value !== 'string' || !material.value)
        throw authError('AGENT_AUTH_LEASE_INVALID', 'API key material is invalid');
      const name =
        binding.provider === 'bedrock' && bedrockGatewayUrl(env)
          ? BEDROCK_GATEWAY_TOKEN_ENV
          : credentialEnvName(binding.provider);
      return { env: { [name]: material.value } };
    },
  }),
  // Codex models are read from bedrock-mantle with the same API key the run will
  // present, so a key restricted to one region reports that region's catalogue.
  // A gateway key is not in the Bedrock env var, so it is never sent to Mantle.
  capabilities: async ({ env = {} }) => {
    const region = env.BEDROCK_REGION || env.AWS_REGION;
    const apiKey = env[credentialEnvName('bedrock')];
    if (!region || !apiKey) return {};
    return {
      codexModels: await listCodexModels({
        region,
        listModels: (target) => listMantleModels({ region: target, apiKey }),
      }),
    };
  },
});
