// A deployment can send API-key inference to a Bedrock gateway instead of Amazon Bedrock
// (Terraform `bedrock_gateway_url`). Bedrock keys are then gateway keys, and only Claude Code
// can use them: OpenCode and Codex always call AWS endpoints.

/** Host of the Bedrock gateway for display and network allowlists; null without a gateway. */
export function bedrockGatewayHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Wording of the field that holds a Bedrock key: an Amazon Bedrock API key, or with a gateway
 * the key of that gateway.
 */
export function bedrockKeyFieldCopy(gatewayHost: string | null) {
  if (gatewayHost) {
    return {
      label: 'Bedrock Gateway Key',
      emptyPlaceholder: 'Enter the gateway key',
      rotatePlaceholder: 'Enter a new key to rotate, or leave blank',
      helpText: `Sent to the Bedrock gateway at ${gatewayHost}. Enables Claude Code; OpenCode and Codex cannot use a gateway.`,
    };
  }
  return {
    label: 'Bedrock Bearer Token',
    emptyPlaceholder: 'Enter AWS_BEARER_TOKEN_BEDROCK value',
    rotatePlaceholder: 'Enter a new token to rotate, or leave blank',
    helpText: 'Enables Claude Code, OpenCode and Codex.',
  };
}

/** Why the runtime reports an installed, authenticated CLI as unavailable. */
export const BEDROCK_GATEWAY_UNAVAILABLE = 'not supported by the Bedrock gateway';
