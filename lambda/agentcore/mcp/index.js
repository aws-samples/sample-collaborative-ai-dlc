// MCP server entrypoint — spawned as a stdio child by the headless CLI
// (--mcp-config points here). Reads the TRUSTED scope from ENV, wires the
// graph-writer (Neptune) + process-bridge (DynamoDB + websocket) over the shared
// process store, and registers the role-appropriate tools.
//
// ENV (set by the container's run-stage / reviewer path, never by the agent):
//   V2_EXECUTION_ID, V2_INTENT_ID, V2_PROJECT_ID, V2_STAGE_ID,
//   V2_STAGE_INSTANCE_ID
//   V2_MCP_ROLE          author | reviewer | reader
//   V2_STAGE_POLICY      the resolved release policy as JSON, or absent/empty for
//                        a 2.3.3-era or unpinned run
//   V2_CHECKPOINT_OWNER  '0' on a dispatched persona session (the lead owns the
//                        checkpoint); absent otherwise
//   V2_ASK_QUESTION      '0' on a dispatched persona session, which has no answer
//                        path back into it; absent otherwise
//   V2_AGENT_REF         trusted agent identity of a dispatched persona session
//   V2_VALIDATION_ROUND  the validation revision checkpoint receipts are scoped
//                        to; absent for the first run and without a policy
//   V2_MCP_MODE          stage (default) | discussion | conflict
//   V2_PROCESS_TABLE, NEPTUNE_ENDPOINT, CONNECTIONS_TABLE, WEBSOCKET_ENDPOINT

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ddb, openGraph, broadcastToIntent } from '../clients.js';
import { createGraphWriter, closeGraphSource } from './graph-writer.js';
import { createGraphManager } from './graph-manager.js';
import { createProcessBridge } from './process-bridge.js';
import { buildToolHandlers, registerTools } from './server.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { contextFromEnv, validateStartupContext } from './startup-context.js';

export const startMcpServer = async ({ env = process.env, store: injectedStore } = {}) => {
  const { scope, role, mode } = contextFromEnv(env);
  const store =
    mode === 'discussion'
      ? null
      : (injectedStore ?? createProcessStore({ ddb, tableName: env.V2_PROCESS_TABLE }));
  await validateStartupContext({ scope, mode, store, openGraph, closeGraphSource });

  const graph = createGraphManager({
    openGraph,
    createWriter: createGraphWriter,
    closeGraphSource,
    scope,
  });
  const bridge = store
    ? createProcessBridge({
        store,
        graphWriter: {
          recordQuestion: (args) => graph.withWriter((writer) => writer.recordQuestion(args)),
        },
        broadcast: (payload) => broadcastToIntent(scope.intentId, payload),
        scope,
        pollIntervalMs: Number(env.V2_QUESTION_POLL_MS) || 3000,
        parkGraceMs: Number(env.V2_QUESTION_PARK_GRACE_MS) || undefined,
      })
    : null;

  const handlers = buildToolHandlers({ graph, bridge });
  const server = new McpServer({ name: 'aidlc-v2-mcp', version: '1.0.0' });
  const registered = registerTools({
    server,
    handlers,
    role,
    stageId: scope.stageId,
    policy: scope.policy,
    checkpointOwner: scope.checkpointOwner,
    canAsk: scope.canAsk,
    z,
    env,
  });

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
