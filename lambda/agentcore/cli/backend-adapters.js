import { normalizeEndpoint } from '../../shared/agent-auth-catalog.js';

export const BEDROCK_BACKEND = Object.freeze({
  id: 'bedrock',
  model(cli, model) {
    if (!model) return null;
    const value = String(model);
    return cli === 'opencode' && !value.includes('/') ? `amazon-bedrock/${value}` : value;
  },
  codexOverrides: ['-c', 'model_provider="amazon-bedrock"', '-c', 'approval_policy="never"'],
});

// A backend contract exercised against controlled endpoints. Registering a
// runtime adapter does not make a product mode selectable: broker/provider and
// environment qualification are separate capability gates.
export const createGatewayBackend = ({ endpoint, tokenEnv = 'AIDLC_GATEWAY_TOKEN' }) => {
  const baseUrl = normalizeEndpoint(endpoint);
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv))
    throw new Error('Gateway token environment name is invalid');
  const providerId = 'aidlc-gateway';
  return Object.freeze({
    id: 'gateway',
    model(cli, model) {
      return model
        ? cli === 'opencode' && !String(model).startsWith(`${providerId}/`)
          ? `${providerId}/${model}`
          : String(model)
        : null;
    },
    envForAuth(cli, env) {
      if (cli === 'claude')
        return {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: env[tokenEnv] ?? '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          IS_SANDBOX: '1',
        };
      return { [tokenEnv]: env[tokenEnv] ?? '' };
    },
    opencodeConfiguration: {
      provider: {
        [providerId]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Configured gateway',
          options: { baseURL: baseUrl, apiKey: `{env:${tokenEnv}}` },
        },
      },
    },
    codexOverrides: [
      '-c',
      `model_provider=${JSON.stringify(providerId)}`,
      '-c',
      'approval_policy="never"',
      '-c',
      `model_providers.${providerId}.name="Configured gateway"`,
      '-c',
      `model_providers.${providerId}.base_url=${JSON.stringify(baseUrl)}`,
      '-c',
      `model_providers.${providerId}.env_key=${JSON.stringify(tokenEnv)}`,
      '-c',
      `model_providers.${providerId}.wire_api="responses"`,
    ],
  });
};
