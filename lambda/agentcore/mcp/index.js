// MCP server entrypoint — spawned as a stdio child by the headless CLI
// (--mcp-config points here). Reads the TRUSTED scope from ENV, wires the
// graph-writer (Neptune) + process-bridge (DynamoDB + websocket) over the shared
// process store, and registers the role-appropriate tools.
//
// ENV (set by the container's run-stage / reviewer path, never by the agent):
//   V2_EXECUTION_ID, V2_INTENT_ID, V2_PROJECT_ID, V2_STAGE_INSTANCE_ID
//   V2_MCP_ROLE          author | reviewer   (reviewer → read-only tools)
//   V2_PROCESS_TABLE, NEPTUNE_ENDPOINT, CONNECTIONS_TABLE, WEBSOCKET_ENDPOINT

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { ddb, openGraph, broadcastToIntent } from '../clients.js';
import { createGraphWriter } from './graph-writer.js';
import { createProcessBridge } from './process-bridge.js';
import { buildToolHandlers, registerTools } from './server.js';

// lambda/shared is CommonJS; import it through createRequire so this ESM module
// can reuse the single source of truth for the process store.
const require = createRequire(import.meta.url);
const { createProcessStore } = require('../../shared/v2-process-store.js');

const scopeFromEnv = (env = process.env) => ({
  executionId: env.V2_EXECUTION_ID,
  intentId: env.V2_INTENT_ID,
  projectId: env.V2_PROJECT_ID,
  stageInstanceId: env.V2_STAGE_INSTANCE_ID ?? null,
});

export const startMcpServer = async ({ env = process.env } = {}) => {
  const scope = scopeFromEnv(env);
  const role = env.V2_MCP_ROLE === 'reviewer' ? 'reviewer' : 'author';

  const g = await openGraph();
  const writer = createGraphWriter({ g, scope });
  const store = createProcessStore({ ddb, tableName: env.V2_PROCESS_TABLE });
  const bridge = createProcessBridge({
    store,
    graphWriter: writer,
    broadcast: (payload) => broadcastToIntent(scope.intentId, payload),
    scope,
    pollIntervalMs: Number(env.V2_QUESTION_POLL_MS) || 3000,
  });

  const handlers = buildToolHandlers({ writer, bridge });
  const server = new McpServer({ name: 'aidlc-v2-mcp', version: '1.0.0' });
  const registered = registerTools({ server, handlers, role, z, env });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agentcore-mcp] connected (role=${role}, tools=${registered.length})`);
  return server;
};

// Only start when run directly as the MCP child process.
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((e) => {
    console.error('[agentcore-mcp] fatal:', e);
    process.exit(1);
  });
}
