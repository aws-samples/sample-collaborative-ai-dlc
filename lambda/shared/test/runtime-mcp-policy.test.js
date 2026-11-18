import { describe, expect, it } from 'vitest';
import {
  RuntimeMcpPolicyError,
  assertDirectMcpConfigAllowed,
  assertMcpSecretWritesAllowed,
  gatewayOnlyMcp,
  hasDirectMcpServers,
  runtimeMcpCredentialsMode,
} from '../runtime-mcp-policy.js';

const STRICT = { RUNTIME_MCP_CREDENTIALS: 'gateway_only' };

describe('runtime MCP credential profile', () => {
  it('defaults to allow and rejects unknown values loudly', () => {
    expect(runtimeMcpCredentialsMode({})).toBe('allow');
    expect(runtimeMcpCredentialsMode({ RUNTIME_MCP_CREDENTIALS: '' })).toBe('allow');
    expect(gatewayOnlyMcp(STRICT)).toBe(true);
    expect(() => runtimeMcpCredentialsMode({ RUNTIME_MCP_CREDENTIALS: 'deny' })).toThrow(
      /RUNTIME_MCP_CREDENTIALS/,
    );
  });

  it('treats any stdio or remote entry in either tier as a direct server', () => {
    expect(hasDirectMcpServers(null)).toBe(false);
    expect(hasDirectMcpServers({ global: {}, project: {} })).toBe(false);
    expect(hasDirectMcpServers({ global: { a: { command: 'npx' } } })).toBe(true);
    expect(hasDirectMcpServers({ project: { b: { type: 'http', url: 'https://x' } } })).toBe(true);
  });

  it('allows everything under the default profile', () => {
    expect(() => assertDirectMcpConfigAllowed({ a: { command: 'npx' } }, {})).not.toThrow();
    expect(() => assertMcpSecretWritesAllowed({ K: 'v' }, {})).not.toThrow();
  });

  it('refuses direct servers and secret values under gateway_only, but not clears', () => {
    expect(() => assertDirectMcpConfigAllowed({ a: { command: 'npx' } }, STRICT)).toThrow(
      RuntimeMcpPolicyError,
    );
    expect(() => assertDirectMcpConfigAllowed({}, STRICT)).not.toThrow();
    expect(() => assertMcpSecretWritesAllowed({ K: 'v' }, STRICT)).toThrow(RuntimeMcpPolicyError);
    expect(() => assertMcpSecretWritesAllowed({ K: '' }, STRICT)).not.toThrow();
    expect(() => assertMcpSecretWritesAllowed({ K: 'v' }, STRICT)).toThrow(
      expect.objectContaining({ code: 'runtime_mcp_gateway_only' }),
    );
  });
});
