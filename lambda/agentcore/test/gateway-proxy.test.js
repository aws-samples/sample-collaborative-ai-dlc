import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createGatewayPassthroughServer,
  createGatewayProxyServer,
  createSignedFetch,
  isCustomerGatewayTool,
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

  it('turns a Gateway interceptor denial into the local denial text', async () => {
    const gateway = {
      callTool: vi.fn(async () => {
        throw new McpError(-32001, 'scope_not_active');
      }),
    };
    const cli = await connect(gateway, 'author');
    const result = await cli.callTool({ name: 'get_artifact', arguments: { id: 'a-1' } });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Tool call denied: this stage is no longer active. Stop and end your turn.',
        },
      ],
    });
  });

  it('keeps other Gateway protocol errors as tool errors', async () => {
    const gateway = {
      callTool: vi.fn(async () => {
        throw new McpError(-32603, 'internal');
      }),
    };
    const cli = await connect(gateway, 'author');
    const result = await cli.callTool({ name: 'get_artifact', arguments: { id: 'a-1' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/^Tool call denied/);
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

describe('gateway MCP proxy — customer tool passthrough', () => {
  const PAGES = {
    first: {
      tools: [
        { name: 'aidlc___get_artifact', inputSchema: { type: 'object' } },
        {
          name: 'confluence___search',
          description: 'Search pages',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      nextCursor: 'c-2',
    },
    'c-2': { tools: [{ name: 'jira___get_issue', inputSchema: { type: 'object' } }] },
  };

  // A real MCP server standing in for the Gateway, so the passthrough speaks
  // the protocol end to end.
  const connectThroughGateway = async ({ onCall } = {}) => {
    const gatewayServer = new Server(
      { name: 'gateway', version: '1' },
      { capabilities: { tools: {} } },
    );
    const listed = [];
    gatewayServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
      listed.push(request.params?.cursor ?? null);
      return PAGES[request.params?.cursor ?? 'first'];
    });
    const calls = [];
    gatewayServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      return onCall(request.params);
    });
    const [gatewaySide, proxySide] = InMemoryTransport.createLinkedPair();
    await gatewayServer.connect(gatewaySide);
    const gatewayClient = new Client({ name: 'aidlc-gateway-proxy', version: '1' });
    await gatewayClient.connect(proxySide);

    const passthrough = createGatewayPassthroughServer({ client: gatewayClient });
    const [cliSide, serverSide] = InMemoryTransport.createLinkedPair();
    await passthrough.connect(serverSide);
    const cli = new Client({ name: 'cli', version: '1' });
    await cli.connect(cliSide);
    return { cli, calls, listed };
  };

  it('lists only customer tools, qualified, page by page', async () => {
    const { cli, listed } = await connectThroughGateway();
    const first = await cli.listTools();
    expect(first.tools.map((t) => t.name)).toEqual(['confluence___search']);
    expect(first.tools[0]).toMatchObject({ description: 'Search pages' });
    expect(first.nextCursor).toBe('c-2');
    const second = await cli.listTools({ cursor: 'c-2' });
    expect(second.tools.map((t) => t.name)).toEqual(['jira___get_issue']);
    expect(second.nextCursor).toBeUndefined();
    expect(listed).toEqual([null, 'c-2']);
  });

  it('forwards a call and its result unchanged, without the built-in unwrapping', async () => {
    const envelopeLike = { content: [{ type: 'text', text: 'inner' }] };
    const result = {
      content: [{ type: 'text', text: JSON.stringify(envelopeLike) }],
      structuredContent: { hits: 1 },
    };
    const { cli, calls } = await connectThroughGateway({ onCall: async () => result });
    const got = await cli.callTool({ name: 'confluence___search', arguments: { query: 'x' } });
    expect(calls).toEqual([{ name: 'confluence___search', arguments: { query: 'x' } }]);
    expect(got.content).toEqual(result.content);
    expect(got.structuredContent).toEqual({ hits: 1 });
  });

  it('refuses built-in and unqualified tools without calling the Gateway', async () => {
    const { cli, calls } = await connectThroughGateway({ onCall: async () => ({ content: [] }) });
    for (const name of ['aidlc___get_artifact', 'get_artifact']) {
      await expect(cli.callTool({ name, arguments: {} })).rejects.toThrow(/not found/);
    }
    expect(calls).toEqual([]);
    expect(isCustomerGatewayTool('confluence___search')).toBe(true);
    expect(isCustomerGatewayTool('aidlc___get_artifact')).toBe(false);
  });

  it('turns an interceptor denial into a tool error the agent can read', async () => {
    const { cli } = await connectThroughGateway({
      // The interceptor's JSON-RPC error: code -32001, the bare reason code.
      onCall: async () => {
        throw Object.assign(new Error('tool_not_allowed_for_target'), { code: -32001 });
      },
    });
    const result = await cli.callTool({ name: 'jira___get_issue', arguments: {} });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Tool call denied: this tool is not enabled for this space and stage.',
        },
      ],
    });
  });
});
