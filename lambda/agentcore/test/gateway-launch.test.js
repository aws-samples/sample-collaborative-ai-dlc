import { describe, expect, it } from 'vitest';
import { mcpServerLaunch } from '../stage-materializer.js';
import { currentGatewayGrant, runWithGatewayGrant } from '../mcp/gateway-context.js';

const trustedEnv = { V2_EXECUTION_ID: 'e-1', V2_MCP_ROLE: 'author' };

describe('built-in MCP launch selection', () => {
  it('keeps the local server when the Gateway is not enabled', () => {
    expect(
      mcpServerLaunch({ mcpEntry: '/srv/mcp/index.js', trustedEnv, env: {}, grant: 'g' }),
    ).toEqual({ entry: '/srv/mcp/index.js', trustedEnv });
  });

  it('runs the Gateway proxy with the grant and endpoint when enabled', () => {
    const launch = mcpServerLaunch({
      mcpEntry: '/srv/mcp/index.js',
      trustedEnv,
      env: { AIDLC_MCP_GATEWAY_URL: 'https://gw/mcp' },
      grant: 'grant-token',
    });
    expect(launch.entry).toMatch(/mcp\/gateway-proxy\.js$/);
    expect(launch.trustedEnv).toEqual({
      ...trustedEnv,
      AIDLC_MCP_GATEWAY_URL: 'https://gw/mcp',
      AIDLC_MCP_GATEWAY_TARGET: 'aidlc',
      AIDLC_MCP_GATEWAY_GRANT: 'grant-token',
    });
  });

  it('fails closed instead of falling back to the local server without a grant', () => {
    expect(() =>
      mcpServerLaunch({
        mcpEntry: '/srv/mcp/index.js',
        trustedEnv,
        env: { AIDLC_MCP_GATEWAY_URL: 'https://gw/mcp' },
        grant: null,
      }),
    ).toThrow('Gateway MCP requires a control-plane grant');
  });

  it('scopes the invocation grant to async work started inside it', async () => {
    expect(currentGatewayGrant()).toBeNull();
    const seen = await runWithGatewayGrant('g-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentGatewayGrant();
    });
    expect(seen).toBe('g-1');
    expect(currentGatewayGrant()).toBeNull();
  });
});
