import { credentialEnvName, authError } from '../shared/agent-auth-contracts.js';
import {
  BEDROCK_GATEWAY_KEY_MATERIAL,
  bedrockGatewayUrl,
} from '../shared/agent-credential-lease.js';
import { listCodexModels } from '../shared/bedrock-models.js';
import { listMantleModels } from './mantle-models.js';
import { BEDROCK_GATEWAY_TOKEN_ENV } from './cli/backend-adapters.js';

const assertApiKey = (binding, material) => {
  if (binding.mechanism && binding.mechanism !== 'api-key')
    throw authError(
      'AGENT_AUTH_LEASE_INVALID',
      'Credential material does not match the pinned mechanism',
    );
  if (typeof material.value !== 'string' || !material.value)
    throw authError('AGENT_AUTH_LEASE_INVALID', 'API key material is invalid');
};

// Keys deliver the API key in the CLI provider's env var. Kiro bindings qualify as 'keys'.
// The lease says where a Bedrock key belongs: api-key material is a key for Amazon Bedrock,
// gateway-key material a key for the Bedrock gateway it names, delivered as the gateway token.
// This runtime's own gateway setting (BEDROCK_GATEWAY_URL) has to agree with the lease. A
// runtime session or environment revision from before a gateway change is refused the key
// instead of sending it to the endpoint it was started with.
export const KEYS_RUNTIME_PROVIDER = Object.freeze({
  id: 'keys',
  modes: Object.freeze(['keys']),
  controlledEnv: Object.freeze([BEDROCK_GATEWAY_TOKEN_ENV]),
  materials: Object.freeze({
    'api-key': ({ binding, material, env = {} }) => {
      assertApiKey(binding, material);
      if (binding.provider === 'bedrock' && bedrockGatewayUrl(env))
        throw authError(
          'AGENT_AUTH_RUNTIME_UNSUPPORTED',
          'This runtime is configured for a Bedrock gateway and cannot use an Amazon Bedrock API key',
        );
      return { env: { [credentialEnvName(binding.provider)]: material.value } };
    },
    [BEDROCK_GATEWAY_KEY_MATERIAL]: ({ binding, material, env = {} }) => {
      assertApiKey(binding, material);
      if (binding.provider !== 'bedrock')
        throw authError('AGENT_AUTH_LEASE_INVALID', 'Bedrock gateway key material is invalid');
      if (!material.endpoint || material.endpoint !== bedrockGatewayUrl(env))
        throw authError(
          'AGENT_AUTH_RUNTIME_UNSUPPORTED',
          'This runtime is not configured for the Bedrock gateway that the key belongs to',
        );
      return { env: { [BEDROCK_GATEWAY_TOKEN_ENV]: material.value } };
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
