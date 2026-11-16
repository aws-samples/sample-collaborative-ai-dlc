import { describe, expect, it } from 'vitest';
import { bedrockGatewayHost, bedrockKeyFieldCopy } from './bedrockGateway';

describe('bedrockGatewayHost', () => {
  it('reduces the gateway URL to the host an allowlist and a label need', () => {
    expect(bedrockGatewayHost('https://gateway.example.com')).toBe('gateway.example.com');
    expect(bedrockGatewayHost('https://gateway.example.com:8443/bedrock/')).toBe(
      'gateway.example.com:8443',
    );
  });

  it('reports no gateway for a deployment or backend without one', () => {
    expect(bedrockGatewayHost(undefined)).toBeNull();
    expect(bedrockGatewayHost(null)).toBeNull();
    expect(bedrockGatewayHost('')).toBeNull();
  });

  it('still names a value it cannot parse instead of hiding the gateway', () => {
    expect(bedrockGatewayHost('gateway.example.com')).toBe('gateway.example.com');
  });
});

describe('bedrockKeyFieldCopy', () => {
  it('describes an Amazon Bedrock API key without a gateway', () => {
    expect(bedrockKeyFieldCopy(null)).toEqual({
      label: 'Bedrock Bearer Token',
      emptyPlaceholder: 'Enter AWS_BEARER_TOKEN_BEDROCK value',
      rotatePlaceholder: 'Enter a new token to rotate, or leave blank',
      helpText: 'Enables Claude Code, OpenCode and Codex.',
    });
  });

  it('describes a gateway key, names its gateway and says which agents can use it', () => {
    expect(bedrockKeyFieldCopy('gateway.example.com')).toEqual({
      label: 'Bedrock Gateway Key',
      emptyPlaceholder: 'Enter the gateway key',
      rotatePlaceholder: 'Enter a new key to rotate, or leave blank',
      helpText:
        'Sent to the Bedrock gateway at gateway.example.com. Enables Claude Code; OpenCode and Codex cannot use a gateway.',
    });
  });
});
