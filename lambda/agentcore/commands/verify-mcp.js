// verify-mcp — probe custom MCP servers INSIDE the AgentCore container so the
// project-settings UI can confirm a config actually works before it's saved:
// same image (uvx/npx/python3 on PATH), same network egress, same env the real
// agent gets. Runs as a stateless /invocations command (like `capabilities`) —
// no workspace/repo/microVM-session machinery.
//
// The handshake is delegated to the official @modelcontextprotocol/sdk Client +
// its transports (Stdio / StreamableHTTP / SSE) so we get spec-correct behavior
// for free: initialize → notifications/initialized, protocol negotiation, and
// the Mcp-Session-Id echo that stateful Streamable-HTTP servers require. A
// hand-rolled JSON-RPC flow gets those wrong and false-fails compliant servers.
//
// Pure of ambient I/O: `probeServer` is injected so it unit-tests without a real
// process/network; the default implementation uses the SDK.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import mcpValidatorPkg from '../../shared/mcp-validator.js';

const { validateMcpServers, toMcpServerMap } = mcpValidatorPkg;

const DEFAULT_TIMEOUT_MS = 25_000;
const CLIENT_INFO = { name: 'aidlc-verify', version: '1.0.0' };

// Build the SDK transport for a (transformed) server spec.
//   stdio  → StdioClientTransport (spawns command+args; env merged over the
//            SDK's safe default so uvx/npx/etc. on the image PATH resolve)
//   http   → StreamableHTTPClientTransport (handles session id + init notif)
//   sse    → SSEClientTransport
const makeTransport = (server) => {
  if (typeof server.url === 'string') {
    const url = new URL(server.url);
    const requestInit = server.headers ? { headers: server.headers } : undefined;
    return server.type === 'sse'
      ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
      : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...getDefaultEnvironment(), ...server.env },
  });
};

// Default probe: connect (runs the full MCP handshake), list tools, close.
// Resolves { ok:true, tools } | { ok:false, error }. Never throws.
const defaultProbeServer = async (server, { timeoutMs }) => {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let transport;
  try {
    transport = makeTransport(server);
  } catch (e) {
    return { ok: false, error: `bad server config: ${e?.message ?? e}` };
  }
  // Hard wall-clock guard around connect+list (a hung server / slow first-run
  // uvx download must not wedge the probe).
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: (tools ?? []).map((t) => t.name).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    try {
      await client.close();
    } catch {
      /* transport may already be down */
    }
  }
};

/**
 * Verify a set of custom MCP servers. Payload: { mcpServers: { "<name>": {...} } }
 * (our author format). Returns { results: { "<name>": { ok, tools?, error? } } },
 * or { error, issues } when the config fails validation (caller maps to 400).
 */
export const verifyMcp = async (payload, deps = {}) => {
  const { probeServer = defaultProbeServer, timeoutMs = DEFAULT_TIMEOUT_MS } = deps;

  const servers = payload?.mcpServers;
  const validation = validateMcpServers(servers ?? {});
  if (!validation.valid) {
    return { error: 'Invalid MCP servers configuration', issues: validation.issues };
  }

  // Transform to the map the runtime materializes (drops reserved names,
  // resolves stdio vs remote), then probe each entry in parallel.
  const map = toMcpServerMap(servers ?? {});
  const names = Object.keys(map);
  const entries = await Promise.all(
    names.map(async (name) => [name, await probeServer(map[name], { timeoutMs })]),
  );

  return { results: Object.fromEntries(entries) };
};
