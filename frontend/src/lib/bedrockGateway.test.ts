import { describe, expect, it } from 'vitest';
import { bedrockGatewayHost } from './bedrockGateway';

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
