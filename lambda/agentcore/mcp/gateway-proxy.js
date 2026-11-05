// Runtime-owned stdio MCP server that forwards the built-in `aidlc` tools to
// AgentCore Gateway. The runtime bridge spawns it in place of the local server
// when the Gateway is enabled, so the four CLIs keep the same `aidlc` server
// name, tool names and stdio wiring.
//
// It holds no data-plane permissions of its own: every call is SigV4-signed
// for bedrock-agentcore:InvokeGateway and carries the control-plane grant plus
// the runtime's session context. The Gateway's interceptor verifies both on
// every request; the Lambda behind it acts on the context it injects.
//
// In passthrough mode (AIDLC_MCP_GATEWAY_MODE=passthrough) the same proxy
// serves the customer MCP targets behind the Gateway instead: it lists the
// Gateway's tools (already filtered to this grant by the RESPONSE interceptor),
// drops the built-in `aidlc___*` ones and forwards calls and results unchanged,
// under their qualified `<target>___<tool>` names. The runtime never holds a
// customer credential: the Gateway injects it.
//
// ENV (runtime-provided, never agent-provided):
//   AIDLC_MCP_GATEWAY_URL   https://<gateway>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp
//   AIDLC_MCP_GATEWAY_GRANT control-plane grant for this invocation
//   AIDLC_MCP_GATEWAY_TARGET Gateway target name (default `aidlc`)
//   AIDLC_MCP_GATEWAY_MODE  `passthrough` for the customer tools, else built-in
//   plus the V2_* scope variables the local server reads.
import { createHash, createHmac } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SignatureV4 } from '@smithy/signature-v4';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { registerTools } from './server.js';
import { contextFromEnv } from './startup-context.js';
import { GRANT_HEADER, SESSION_HEADER, encodeGatewaySession } from './gateway-session.js';
import {
  AIDLC_TARGET,
  GATEWAY_DENIAL_CODE,
  gatewayDenialText,
  splitQualifiedToolName,
} from '../../shared/mcp/gateway-authorization.js';

const SEPARATOR = '___';
const TOOL_CALL_TIMEOUT_MS = 14 * 60 * 1000;

class NodeSha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(data) {
    this.hash.update(typeof data === 'string' ? Buffer.from(data) : data);
  }
  async digest() {
    return new Uint8Array(this.hash.digest());
  }
}

const headerEntries = (headers) => {
  if (!headers) return [];
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    const entries = [];
    headers.forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  return Array.isArray(headers) ? headers : Object.entries(headers);
};

// SigV4 needs the exact bytes sent, so only string bodies (the MCP SDK's JSON
// POSTs) and empty bodies (GET/DELETE) are supported.
export const createSignedFetch = ({
  region,
  credentials = fromNodeProviderChain(),
  service = 'bedrock-agentcore',
  fetchImpl = fetch,
}) => {
  const signer = new SignatureV4({ service, region, credentials, sha256: NodeSha256 });
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new Error('Gateway proxy can only sign string request bodies');
    }
    const headers = Object.fromEntries(
      headerEntries(init.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    headers.host = url.host;
    const signed = await signer.sign({
      method: init.method ?? 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: init.body ?? undefined,
    });
    const { host: _host, ...sendHeaders } = signed.headers;
    return fetchImpl(url, { ...init, headers: sendHeaders });
  };
};

// Gateway serializes a Lambda target's JSON result into a text content part.
// The Lambda returns the local server's MCP envelope, so unwrap it back.
export const unwrapGatewayResult = (result) => {
  const text = result?.content?.length === 1 ? result.content[0]?.text : null;
  if (typeof text !== 'string') return result;
  try {
    const inner = JSON.parse(text);
    if (inner && Array.isArray(inner.content)) {
      return inner.isError ? { content: inner.content, isError: true } : { content: inner.content };
    }
  } catch {
    // Not an envelope: pass the Gateway's result through unchanged.
  }
  return result;
};

// The Gateway interceptor denies with a JSON-RPC error whose message is the
// reason code; the SDK client raises it as `MCP error <code>: <message>`. Give
// the agent the same tool-error text the local server would.
const DENIAL_PREFIX = `MCP error ${GATEWAY_DENIAL_CODE}: `;
const gatewayDenial = (error) =>
  error?.code === GATEWAY_DENIAL_CODE
    ? {
        content: [
          {
            type: 'text',
            text: gatewayDenialText(String(error.message ?? '').replace(DENIAL_PREFIX, '')),
          },
        ],
        isError: true,
      }
    : null;

export const gatewayForwardingHandlers = ({ client, target }) =>
  new Proxy(
    {},
    {
      get: (_handlers, name) => async (args) => {
        let result;
        try {
          result = await client.callTool(
            { name: `${target}${SEPARATOR}${String(name)}`, arguments: args ?? {} },
            undefined,
            { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
          );
        } catch (error) {
          const denial = gatewayDenial(error);
          if (denial) return denial;
          throw error;
        }
        return unwrapGatewayResult(result);
      },
    },
  );

// The catalog (names, descriptions, zod schemas, role/policy selection) is the
// local server's own registration, so agents see byte-identical tools whichever
// path serves them. Only execution goes through the Gateway.
export const createGatewayProxyServer = ({ client, target, role, scope, env = process.env }) => {
  const server = new McpServer({ name: 'aidlc-v2-mcp', version: '1.0.0' });
  const registered = registerTools({
    server,
    handlers: gatewayForwardingHandlers({ client, target }),
    role,
    stageId: scope.stageId,
    policy: scope.policy,
    checkpointOwner: scope.checkpointOwner,
    canAsk: scope.canAsk,
    z,
    env,
  });
  return { server, registered };
};

export const GATEWAY_PASSTHROUGH_MODE = 'passthrough';

// A Gateway tool of a customer target: qualified, and not the built-in target.
export const isCustomerGatewayTool = (name) => {
  const { target } = splitQualifiedToolName(name);
  return Boolean(target) && target !== AIDLC_TARGET;
};

// The customer tools exactly as the Gateway lists them for this grant. Each
// page is forwarded with its cursor, so the CLI pages through the Gateway.
// Results are NOT unwrapped (unwrapGatewayResult is for the built-in Lambda
// envelope): a customer server's content is returned as it sent it.
export const createGatewayPassthroughServer = ({ client }) => {
  const server = new Server(
    { name: 'aidlc-gateway-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const page = await client.request(
      { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      ListToolsResultSchema,
    );
    return { ...page, tools: page.tools.filter((tool) => isCustomerGatewayTool(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!isCustomerGatewayTool(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    }
    try {
      return await client.request(
        { method: 'tools/call', params: { name, arguments: args ?? {} } },
        CallToolResultSchema,
        { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
      );
    } catch (error) {
      const denial = gatewayDenial(error);
      if (denial) return denial;
      throw error;
    }
  });
  return server;
};

export const startGatewayProxy = async ({ env = process.env } = {}) => {
  const gatewayUrl = env.AIDLC_MCP_GATEWAY_URL;
  const grant = env.AIDLC_MCP_GATEWAY_GRANT;
  if (!gatewayUrl || !grant) throw new Error('Gateway MCP requires a gateway URL and grant');
  const { scope, role } = contextFromEnv(env);
  const target = env.AIDLC_MCP_GATEWAY_TARGET || 'aidlc';

  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
    fetch: createSignedFetch({ region: env.AWS_REGION }),
    requestInit: {
      headers: {
        [GRANT_HEADER]: grant,
        [SESSION_HEADER]: encodeGatewaySession({ ...scope, role }),
      },
    },
  });
  const client = new Client({ name: 'aidlc-gateway-proxy', version: '1.0.0' });
  await client.connect(transport);

  if (env.AIDLC_MCP_GATEWAY_MODE === GATEWAY_PASSTHROUGH_MODE) {
    const server = createGatewayPassthroughServer({ client });
    await server.connect(new StdioServerTransport());
    console.error('[agentcore-mcp] gateway customer-tool proxy connected');
    return server;
  }

  const { server, registered } = createGatewayProxyServer({ client, target, role, scope, env });
  await server.connect(new StdioServerTransport());
  console.error(
    `[agentcore-mcp] gateway proxy connected (role=${role}, tools=${registered.length})`,
  );
  return server;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startGatewayProxy().catch((e) => {
    console.error('[agentcore-mcp] gateway proxy fatal:', e?.message);
    process.exit(1);
  });
}
