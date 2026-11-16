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

/** Why the runtime reports an installed, authenticated CLI as unavailable. */
export const BEDROCK_GATEWAY_UNAVAILABLE = 'not supported by the Bedrock gateway';
