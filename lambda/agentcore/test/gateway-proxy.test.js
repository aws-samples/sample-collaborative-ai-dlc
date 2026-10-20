import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  createGatewayProxyServer,
  createSignedFetch,
  unwrapGatewayResult,
} from '../mcp/gateway-proxy.js';
import { registerTools, toolsForRole } from '../mcp/server.js';

const scope = {
  stageId: 'requirements-analysis',
  policy: null,
  checkpointOwner: true,
  canAsk: true,
};

const connect = async (gatewayClient, role) => {
  const { server } = createGatewayProxyServer({
    client: gatewayClient,
    target: 'aidlc',
    role,
    scope,
    env: { V2_MCP_TRACE: 'off' },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const cli = new Client({ name: 'cli', version: '1' });
  await cli.connect(clientSide);
  return cli;
};

const localCatalog = async (role) => {
  const tools = [];
  const fake = { tool: (name, description, shape) => tools.push({ name, description, shape }) };
  registerTools({
    server: fake,
    handlers: {},
    role,
    stageId: scope.stageId,
    policy: null,
    z,
    env: { V2_MCP_TRACE: 'off' },
  });
  return tools.map((t) => t.name);
};

describe('gateway MCP proxy', () => {
  it.each(['author', 'reviewer', 'reader'])(
    'exposes exactly the local %s catalog without asking the Gateway',
    async (role) => {
      const gateway = { listTools: vi.fn(), callTool: vi.fn() };
      const cli = await connect(gateway, role);
      const { tools } = await cli.listTools();
      expect(tools.map((t) => t.name)).toEqual(await localCatalog(role));
      expect(tools.map((t) => t.name)).toEqual(toolsForRole(role, scope.stageId));
      expect(gateway.listTools).not.toHaveBeenCalled();
    },
  );

  it('forwards calls with the target prefix and unwraps the Lambda envelope', async () => {
    const envelope = { content: [{ type: 'text', text: '{"id":"a-1"}' }] };
    const gateway = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
      })),
    };
    const cli = await connect(gateway, 'author');
    const result = await cli.callTool({ name: 'get_artifact', arguments: { id: 'a-1' } });
    expect(result.content).toEqual(envelope.content);
    expect(gateway.callTool.mock.calls[0][0]).toEqual({
      name: 'aidlc___get_artifact',
      arguments: { id: 'a-1' },
    });
  });

  it('refuses tools outside the role catalog without calling the Gateway', async () => {
    const gateway = { callTool: vi.fn() };
    const cli = await connect(gateway, 'reader');
    const result = await cli.callTool({ name: 'create_artifact', arguments: {} });
    expect(result.isError).toBe(true);
    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it('preserves tool errors and passes non-envelope results through', () => {
    const errorEnvelope = {
      content: [{ type: 'text', text: 'graph write rejected' }],
      isError: true,
    };
    expect(
      unwrapGatewayResult({ content: [{ type: 'text', text: JSON.stringify(errorEnvelope) }] }),
    ).toEqual(errorEnvelope);
    const plain = { content: [{ type: 'text', text: 'Tool call denied' }], isError: true };
    expect(unwrapGatewayResult(plain)).toBe(plain);
  });

  it('SigV4-signs Gateway requests including the grant and session headers', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const signedFetch = createSignedFetch({
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
      fetchImpl,
    });
    const headers = new Headers({
      'content-type': 'application/json',
      'x-aidlc-grant': 'g',
      'x-aidlc-session': 's',
    });
    await signedFetch(new URL('https://gw.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'), {
      method: 'POST',
      headers,
      body: '{"jsonrpc":"2.0"}',
    });
    const sent = fetchImpl.mock.calls[0][1].headers;
    expect(sent.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request/,
    );
    expect(sent.authorization).toMatch(/SignedHeaders=[^,]*x-aidlc-grant;x-aidlc-session/);
    expect(sent['x-amz-content-sha256'] ?? sent['x-amz-date']).toBeTruthy();
    expect(sent.host).toBeUndefined();
  });

  it('refuses to sign streaming bodies it cannot hash', async () => {
    const signedFetch = createSignedFetch({
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
      fetchImpl: vi.fn(),
    });
    await expect(
      signedFetch('https://gw/mcp', { method: 'POST', body: new Uint8Array([1]) }),
    ).rejects.toThrow('Gateway proxy can only sign string request bodies');
  });
});
