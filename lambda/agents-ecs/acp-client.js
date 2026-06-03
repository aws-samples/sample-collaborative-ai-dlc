// ACP client wrapper - spawns the active agent CLI in ACP mode and communicates
// via JSON-RPC 2.0 over stdio. The CLI is selected via AGENT_CLI env var (default: kiro).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { DynamoDBClient, QueryCommand: DDBQueryCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');

// ---------------------------------------------------------------------------
// Driver — pluggable agent CLI abstraction
// ---------------------------------------------------------------------------
const { getDriver } = require('./drivers');
const AGENT_CLI = process.env.AGENT_CLI || 'kiro';
const driver = getDriver(AGENT_CLI);
const ACP_VERBOSE = process.env.ACP_VERBOSE === 'true';
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.ACP_REQUEST_TIMEOUT_MS || '120000', 10);

// ---------------------------------------------------------------------------
// MCP servers — merged from global (SSM), project (Neptune), task (Neptune)
// ---------------------------------------------------------------------------
// Cached after first load to avoid redundant lookups within the same session.
let mergedMcpServers = null;

function mcpServerLabel(server) {
  return `${server?.name || '(unnamed)'}:${server?.command || server?.url || '(no command)'}`;
}

function validateMcpServer(server, index) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new Error(`MCP server at index ${index} must be an object`);
  }
  if (typeof server.name !== 'string' || server.name.length === 0) {
    throw new Error(`MCP server at index ${index} must include a string name`);
  }
  const type = server.type || 'stdio';
  if (!['stdio', 'http', 'sse'].includes(type)) {
    throw new Error(`MCP server ${server.name} type must be stdio, http, or sse`);
  }
  if (type === 'stdio') {
    if (!server.command || typeof server.command !== 'string') {
      throw new Error(`MCP server ${server.name} must include a string command`);
    }
    if (server.args === undefined) server.args = [];
    if (!Array.isArray(server.args)) {
      throw new Error(`MCP server ${server.name} args must be an array`);
    }
    if (server.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`MCP server ${server.name} args must contain only strings`);
    }
  }
  if (type === 'http' || type === 'sse') {
    if (!server.url || typeof server.url !== 'string') {
      throw new Error(`MCP server ${server.name} must include a string url`);
    }
    if (server.headers === undefined) server.headers = [];
    if (!Array.isArray(server.headers)) {
      throw new Error(`MCP server ${server.name} headers must be an array`);
    }
  }
  return server;
}

function commandExists(command) {
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return (
    spawnSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
      stdio: 'ignore',
    }).status === 0
  );
}

function filterRunnableMcpServers(servers, { requiredNames = new Set() } = {}) {
  const runnable = [];
  for (let i = 0; i < servers.length; i += 1) {
    const server = validateMcpServer(servers[i], i);
    if ((server.type || 'stdio') !== 'stdio') {
      runnable.push(server);
      continue;
    }
    if (commandExists(server.command)) {
      runnable.push(server);
      continue;
    }

    const label = mcpServerLabel(server);
    const message = `MCP server ${label} command not found on PATH: ${server.command}`;
    if (requiredNames.has(server.name)) {
      throw new Error(message);
    }
    reportAgentWarning(
      `Skipping optional ${message}. The agent will continue without this tool server.`,
    );
  }
  return runnable;
}

function parseMcpServersJson(raw, source) {
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} MCP servers setting must be a JSON array`);
  }
  return parsed.map(validateMcpServer);
}

/**
 * Load and merge MCP server definitions from all three scopes:
 *   Global  — SSM Parameter Store (environment-wide, managed via Admin UI)
 *   Project — Neptune Project node `mcp_servers` property
 *   Task    — Neptune Task node `mcp_servers` property (only when taskId is set)
 *
 * Deduplication by `name`: task > project > global (more specific scope wins).
 * Non-conflicting servers (different names) are all included.
 */
async function loadMergedMcpServers(projectId, taskId) {
  if (mergedMcpServers !== null) return mergedMcpServers;

  // 1. Load global servers from SSM
  let globalServers = [];
  const ssmPath = process.env.MCP_SERVERS_SSM_PATH;
  if (ssmPath) {
    try {
      const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const result = await ssm.send(
        new GetParameterCommand({ Name: ssmPath, WithDecryption: false }),
      );
      const raw = result.Parameter?.Value || '[]';
      globalServers = parseMcpServersJson(raw, 'global');
    } catch (err) {
      console.error('[acp] Failed to load global MCP servers from SSM:', err.message);
    }
  }

  // 2. Load project and task servers from Neptune
  let projectServers = [];
  let taskServers = [];
  const neptuneEndpoint = process.env.NEPTUNE_ENDPOINT;
  if (neptuneEndpoint && projectId && projectId !== 'unknown') {
    try {
      const credentials = await fromNodeProviderChain()();
      credentials.region = env.region;
      const connInfo = getUrlAndHeaders(neptuneEndpoint, '8182', credentials, '/gremlin', 'wss');
      const conn = new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
      const g = traversal().withRemote(conn);
      try {
        // Single Gremlin query: fetch project and (optionally) task mcp_servers
        const projectResult = await g
          .V()
          .has('Project', 'id', projectId)
          .valueMap('mcp_servers')
          .next();
        if (projectResult.value) {
          const raw =
            projectResult.value instanceof Map
              ? (projectResult.value.get('mcp_servers') || [])[0]
              : (projectResult.value['mcp_servers'] || [])[0];
          if (raw) {
            try {
              projectServers = parseMcpServersJson(raw, 'project');
            } catch {
              console.error('[acp] Could not parse project mcp_servers:', raw);
            }
          }
        }

        if (taskId) {
          const taskResult = await g.V().has('Task', 'id', taskId).valueMap('mcp_servers').next();
          if (taskResult.value) {
            const raw =
              taskResult.value instanceof Map
                ? (taskResult.value.get('mcp_servers') || [])[0]
                : (taskResult.value['mcp_servers'] || [])[0];
            if (raw) {
              try {
                taskServers = parseMcpServersJson(raw, 'task');
              } catch {
                console.error('[acp] Could not parse task mcp_servers:', raw);
              }
            }
          }
        }
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.error('[acp] Failed to load scoped MCP servers from Neptune:', err.message);
    }
  }

  // 3. Merge: task > project > global (dedup by name; non-conflicting are additive)
  const serverMap = new Map();
  for (const s of globalServers) if (s.name) serverMap.set(s.name, s);
  for (const s of projectServers) if (s.name) serverMap.set(s.name, s);
  for (const s of taskServers) if (s.name) serverMap.set(s.name, s);
  mergedMcpServers = [...serverMap.values()];
  console.log(`[acp] Merged MCP servers: ${mergedMcpServers.length} total`);
  return mergedMcpServers;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

const env = {
  executionId: process.env.EXECUTION_ID || 'unknown',
  projectId: process.env.PROJECT_ID || 'unknown',
  sprintId: process.env.SPRINT_ID || '',
  agentType: process.env.AGENT_TYPE || 'inception',
  agentTaskId: process.env.TASK_ID || '',
  prompt: process.env.AGENT_PROMPT || '',
  agentOutputsTable: process.env.AGENT_OUTPUTS_TABLE,
  submitQuestionLambda: process.env.SUBMIT_QUESTION_LAMBDA,
  connectionsTable: process.env.CONNECTIONS_TABLE,
  websocketEndpoint: process.env.WEBSOCKET_ENDPOINT,
  neptuneEndpoint: process.env.NEPTUNE_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
};

function toNeptuneSignerCredentials(credentials, region) {
  return {
    accessKeyId: credentials.accessKeyId,
    accessKey: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    secretKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region,
  };
}

const getConnection = async () => {
  if (!env.neptuneEndpoint) return null;
  const credentials = await fromNodeProviderChain()();
  const signerCredentials = toNeptuneSignerCredentials(credentials, env.region);
  const connInfo = getUrlAndHeaders(
    env.neptuneEndpoint,
    '8182',
    signerCredentials,
    '/gremlin',
    'wss',
  );
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

async function withNeptune(fn) {
  const conn = await getConnection();
  if (!conn) return;
  try {
    const g = traversal().withRemote(conn);
    return await fn(g);
  } finally {
    await conn.close();
  }
}

let msgId = 0;
const pending = new Map();
let agentProc; // the spawned ACP subprocess (was 'kiro')
// Accumulate the full agent output text so we can persist it on completion
let fullOutputBuffer = '';
let lastErrorMessage = '';
// Track whether we've already persisted a final status to avoid double-saves
// (the prompt catch block and the kiro exit handler can both fire)
let statusSaved = false;

function send(method, params) {
  const id = msgId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  agentProc.stdin.write(msg + '\n');
  return id;
}

function request(method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const id = send(method, params);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    pending.set(id, { method, resolve, reject, timer });
  });
}

function settlePending(id, settle, value) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  entry[settle](value);
  return true;
}

function rejectAllPending(err) {
  for (const [id, entry] of pending) {
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
  }
}

function friendlyAgentError(err) {
  const raw = err && err.message ? err.message : String(err || 'Unknown error');
  if (/command not found on PATH/i.test(raw)) {
    const match = raw.match(/MCP server ([^:]+:[^ ]+) command not found on PATH: (.+)$/i);
    if (match) {
      return `An MCP server could not start because the required command \`${match[2]}\` is not installed in the agent image. The server was ${match[1]}.`;
    }
    return 'An MCP server could not start because one of its required commands is not installed in the agent image.';
  }
  if (/session\/new timed out/i.test(raw)) {
    return 'The agent could not finish starting its tool session. One of the configured MCP servers may be hanging during startup.';
  }
  if (/initialize timed out/i.test(raw)) {
    return 'The agent CLI did not finish initialization in time. Please retry, or check the agent credentials and runtime logs.';
  }
  if (/spawn .*ENOENT/i.test(raw) || /exited before responding/i.test(raw)) {
    return 'The agent CLI failed to start inside the worker image. Please check that the selected agent CLI is installed and healthy.';
  }
  if (/No KIRO_API_KEY|whoami failed|API key/i.test(raw)) {
    return 'The agent could not authenticate. Please check the configured agent API key in Admin settings.';
  }
  return 'The agent failed before it could complete. Please retry after checking the agent configuration and MCP server settings.';
}

function appendAgentSystemMessage(kind, message) {
  const heading = kind === 'error' ? 'Agent failed' : 'Agent startup warning';
  const text = `\n\n### ${heading}\n\n${message}\n`;
  fullOutputBuffer += text;
  bufferChunk(text);
}

function reportAgentWarning(message) {
  console.warn(`[acp] ${message}`);
  appendAgentSystemMessage('warning', message);
  broadcastEvent('agent.warning', { message });
}

function reportAgentError(err) {
  const raw = err && err.message ? err.message : String(err || 'Unknown error');
  const message = friendlyAgentError(err);
  lastErrorMessage = message;
  console.error('[acp] User-visible agent error:', message);
  console.error('[acp] Raw agent error:', raw);
  appendAgentSystemMessage('error', message);
  flushChunksSync();
  broadcastEvent('agent.error', { error: message, rawError: raw });
}

// ---------------------------------------------------------------------------
// WebSocket broadcast system
// ---------------------------------------------------------------------------
// Reuse clients instead of creating new ones per call
const broadcastDdb = new DynamoDBClient({});
const broadcastWsClient = env.websocketEndpoint
  ? new ApiGatewayManagementApiClient({ endpoint: env.websocketEndpoint })
  : null;

// Cache connections to avoid querying DynamoDB on every broadcast
let cachedConnections = null;
let connectionsCacheTime = 0;
const CONNECTIONS_CACHE_TTL = 10000; // 10 seconds

async function getConnections() {
  const now = Date.now();
  if (cachedConnections && now - connectionsCacheTime < CONNECTIONS_CACHE_TTL) {
    return cachedConnections;
  }
  if (!env.connectionsTable) return [];
  try {
    const documentId = env.sprintId ? `sprint:${env.sprintId}` : env.projectId;
    const result = await broadcastDdb.send(
      new DDBQueryCommand({
        TableName: env.connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: documentId } },
      }),
    );
    cachedConnections = (result.Items || []).map((item) => item.connectionId.S);
    connectionsCacheTime = now;
    return cachedConnections;
  } catch (err) {
    console.error('Failed to query connections:', err.message);
    return cachedConnections || [];
  }
}

// Serialized broadcast queue -- ensures messages are sent in order
// and prevents concurrent fire-and-forget storms
let broadcastQueue = Promise.resolve();

function broadcastEvent(type, data) {
  if (!broadcastWsClient || !env.connectionsTable) return;
  // Chain onto the queue so broadcasts are serialized
  broadcastQueue = broadcastQueue.then(async () => {
    try {
      const connectionIds = await getConnections();
      if (connectionIds.length === 0) return;
      const payload = JSON.stringify({
        type,
        executionId: env.executionId,
        agentType: env.agentType,
        agentTaskId: env.agentTaskId || undefined,
        ...data,
      });
      await Promise.all(
        connectionIds.map((connId) =>
          broadcastWsClient
            .send(
              new PostToConnectionCommand({
                ConnectionId: connId,
                Data: payload,
              }),
            )
            .catch((err) => {
              // Connection gone (410) -- invalidate cache so we re-fetch
              if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
                cachedConnections = null;
              }
            }),
        ),
      );
    } catch (err) {
      console.error('Broadcast failed:', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Text chunk batching
// ---------------------------------------------------------------------------
// Agent message chunks arrive every ~80ms. Instead of sending each tiny chunk
// individually over WebSocket (creating dozens of concurrent network ops),
// we buffer them and flush on a short timer. This reduces message volume
// dramatically while keeping latency low (<200ms).
let chunkBuffer = '';
let chunkFlushTimer = null;
const CHUNK_FLUSH_INTERVAL = 150; // ms -- flush at most every 150ms

function bufferChunk(text) {
  chunkBuffer += text;
  if (!chunkFlushTimer) {
    chunkFlushTimer = setTimeout(flushChunks, CHUNK_FLUSH_INTERVAL);
  }
}

function flushChunks() {
  chunkFlushTimer = null;
  if (!chunkBuffer) return;
  const text = chunkBuffer;
  chunkBuffer = '';
  broadcastEvent('agent.chunk', {
    text,
    seq: ++broadcastSeq,
  });
}

// Force-flush any pending chunks (e.g. before completion event)
function flushChunksSync() {
  if (chunkFlushTimer) {
    clearTimeout(chunkFlushTimer);
    chunkFlushTimer = null;
  }
  if (chunkBuffer) {
    const text = chunkBuffer;
    chunkBuffer = '';
    broadcastEvent('agent.chunk', {
      text,
      seq: ++broadcastSeq,
    });
  }
}

async function saveStatus(status) {
  if (!env.agentOutputsTable) return;
  if (statusSaved) {
    console.log(`[acp] Status already saved, skipping duplicate saveStatus('${status}')`);
    return;
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.agentOutputsTable,
        Item: {
          executionId: env.executionId,
          agentType: env.agentType,
          projectId: env.projectId,
          sprintId: env.sprintId || undefined,
          status,
          errorMessage: lastErrorMessage || undefined,
          // Persist the full accumulated agent output so it can be fetched later
          outputText: fullOutputBuffer || undefined,
          completedAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
        },
      }),
    );
    statusSaved = true;
    console.log(`[acp] Wrote AgentOutputs status '${status}' for ${env.executionId}`);
  } catch (err) {
    console.error('[acp] Failed to write AgentOutputs status:', err.message);
    return;
  }

  // Update Sprint vertex with completion status
  if (env.sprintId) {
    try {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        const agentStatus = status === 'completed' ? 'completed' : 'failed';
        await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .property(cardinality.single, 'current_agent_status', agentStatus)
          .property(cardinality.single, 'agent_completed_at', new Date().toISOString())
          .next();
      });
      console.log(`[acp] Updated Sprint ${env.sprintId} status to '${status}'`);
    } catch (err) {
      console.error('[acp] Failed to update Sprint status in Neptune:', err.message);
    }
  }

  // Clear task_execution_status on the Task vertex so the orchestrator knows this agent is done.
  // Without this, task_execution_status stays "RUNNING" forever and the orchestrator
  // thinks an agent is still working on the task.
  if (env.agentTaskId) {
    try {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        const execStatus = status === 'completed' ? 'COMPLETED' : 'FAILED';
        await g
          .V()
          .has('Task', 'id', env.agentTaskId)
          .property(cardinality.single, 'task_execution_status', execStatus)
          .next();
        console.log(`[acp] Updated task ${env.agentTaskId} task_execution_status to ${execStatus}`);
      });
    } catch (err) {
      console.error('[acp] Failed to update Task status in Neptune:', err.message);
    }
  }
}

function handleMessage(msg) {
  // Log all incoming messages for debugging
  if (msg.method) {
    console.log(`[acp] << ${msg.id !== undefined ? 'request' : 'notification'}: ${msg.method}`);
  } else if (msg.id !== undefined) {
    console.log(
      `[acp] << response id=${msg.id} ${msg.error ? 'ERROR: ' + msg.error.message : 'ok'}`,
    );
  }

  // Response to a request we sent
  if (msg.id !== undefined && pending.has(msg.id)) {
    if (msg.error) {
      console.error('[acp] Error response details:', JSON.stringify(msg.error));
      settlePending(msg.id, 'reject', new Error(msg.error.message));
    } else {
      settlePending(msg.id, 'resolve', msg.result);
    }
    return;
  }

  // Incoming request from the agent (has both id and method)
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options || [];
      // Select the best available option from what kiro-cli actually offered.
      // Prefer allow_always > allow_once > first available option.
      // NEVER fabricate an optionId — it must come from the options array.
      const selected =
        options.find((o) => o.kind === 'allow_always') ||
        options.find((o) => o.kind === 'allow_once') ||
        options[0];
      if (selected) {
        console.log(
          `[acp] Permission request: selecting '${selected.kind}' (optionId=${selected.optionId}) from ${options.length} options`,
        );
        agentProc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
          }) + '\n',
        );
      } else {
        console.error(
          `[acp] Permission request has no options, sending empty selection. params:`,
          JSON.stringify(msg.params),
        );
        agentProc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
          }) + '\n',
        );
      }
    } else {
      console.warn(
        `[acp] Unhandled request method '${msg.method}', responding with empty result. Full params:`,
        JSON.stringify(msg.params),
      );
      agentProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    }
    return;
  }

  // Notification from the agent
  if (msg.method === 'session/update') {
    handleSessionUpdate(msg.params);
  }
}

let broadcastSeq = 0;

function handleSessionUpdate(params) {
  if (!params) return;
  const update = params.update;
  if (!update) return;
  const kind = update.sessionUpdate;

  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    // Robustly extract text from various content structures that kiro-cli / opencode may send:
    // - { content: { text: "..." } }           -- most common
    // - { content: "..." }                      -- simple string
    // - { content: [{ text: "..." }, ...] }     -- array of content blocks
    // - { text: "..." }                         -- fallback at update level
    // - { content: { type: "text", text: "..."} } -- typed content block
    // Note: opencode sends thinking/reasoning output as agent_thought_chunk; we surface it the same way.
    let text = '';
    const content = update.content;
    if (typeof content === 'string') {
      text = content;
    } else if (content && typeof content === 'object') {
      if (typeof content.text === 'string') {
        text = content.text;
      } else if (Array.isArray(content)) {
        text = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
      }
    }
    if (!text && typeof update.text === 'string') {
      text = update.text;
    }
    if (!text) {
      if (ACP_VERBOSE) {
        console.warn(
          `[acp] ${kind} with no extractable text. Raw update:`,
          JSON.stringify(update).slice(0, 500),
        );
      } else {
        console.warn(
          `[acp] ${kind} with no extractable text (set ACP_VERBOSE=true to log raw update)`,
        );
      }
      return;
    }
    // Accumulate the full output for persistence
    fullOutputBuffer += text;
    // Buffer chunks and flush periodically to reduce WebSocket message volume
    bufferChunk(text);
  } else if (kind === 'tool_call') {
    // Flush any pending text chunks before sending tool events
    // so text always arrives before the tool event that follows it
    flushChunksSync();
    // kiro-cli sends tool_call events with these observed statuses:
    //   - 'in_progress': tool is starting (= 'pending' for frontend)
    //   - 'completed': tool finished successfully
    //   - 'error'/'failed': tool failed
    //   - undefined: title update for an in-progress tool (e.g. "Reading project.pbxproj:1")
    //
    // When status is undefined, it's an in-flight title update -- treat as a tool_update, not a new tool.
    const toolStatus = update.status;
    const toolName = update.title || 'unknown';
    const toolId = update.toolCallId || undefined;

    if (toolStatus === undefined || toolStatus === null) {
      // This is a title/progress update for an existing tool call, not a new one
      console.log(`[acp] Tool progress: "${toolName}" id=${toolId || 'none'}`);
      if (toolId) {
        broadcastEvent('agent.tool_update', {
          toolCallId: toolId,
          status: 'running',
          title: toolName,
          seq: ++broadcastSeq,
        });
      }
    } else {
      // Map kiro-cli statuses to what the frontend expects
      let frontendStatus = toolStatus;
      if (toolStatus === 'in_progress') frontendStatus = 'pending';
      // 'completed', 'error', 'failed' pass through as-is

      console.log(
        `[acp] Tool call: ${toolName} (${toolStatus} -> ${frontendStatus}) id=${toolId || 'none'}`,
      );
      broadcastEvent('agent.tool', {
        name: toolName,
        status: frontendStatus,
        toolCallId: toolId,
        seq: ++broadcastSeq,
      });
    }
  } else if (kind === 'tool_call_update') {
    // Flush any pending text chunks before tool updates
    flushChunksSync();
    console.log(`[acp] Tool update: ${update.toolCallId} (${update.status})`);
    broadcastEvent('agent.tool_update', {
      toolCallId: update.toolCallId || undefined,
      status: update.status,
      content: update.content?.text || undefined,
      seq: ++broadcastSeq,
    });
  } else if (kind) {
    if (ACP_VERBOSE) {
      console.log(`[acp] Session update: ${kind}`, JSON.stringify(update).slice(0, 300));
    } else {
      console.log(`[acp] Session update: ${kind}`);
    }
  }
}

async function main() {
  if (!env.prompt) {
    console.error('AGENT_PROMPT env var is required');
    process.exit(1);
  }

  await runAcpMode();
}
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ACP mode — JSON-RPC 2.0 over stdio (kiro, opencode, claude-agent-acp)
// ---------------------------------------------------------------------------
async function runAcpMode() {
  // Load merged MCP servers from SSM (global), Neptune project, and Neptune task.
  // Result is cached within this process for the session lifetime.
  // Default `env` to [] when missing — kiro-cli's ACP deserializer rejects
  // stdio MCP entries without an `env` field and silently exits with code 0
  // (no stderr, no JSON-RPC error), so we normalize here.
  const extras = (await loadMergedMcpServers(env.projectId, env.agentTaskId)).map((s) => ({
    ...s,
    env: Array.isArray(s.env) ? s.env : [],
  }));

  // Authenticate the driver in THIS process so module-level state (e.g.
  // _cachedBearerToken) is populated. pool-worker.js already authenticated
  // the driver in the parent process, but that state doesn't cross the
  // process boundary — acp-client.js runs as a separate child process.
  // Without this, getEnvForAcpProcess() cannot include secrets (like the
  // Bedrock bearer token) that were loaded from SSM during authenticate().
  try {
    await driver.authenticate(process.env);
  } catch (authErr) {
    // Non-fatal: if the driver was selected for this job, pool-worker already
    // verified authentication. A failure here is unexpected but shouldn't
    // prevent the attempt — the ACP process may still work if env vars are
    // sufficient (e.g. kiro driver which uses KIRO_API_KEY, not bearer tokens).
    console.warn(`[acp] Driver re-authentication warning: ${authErr.message}`);
  }

  // Build the ACP command from the active driver
  const [acpBin, ...acpArgs] = driver.getAcpCommand();
  const driverEnv = driver.getEnvForAcpProcess(process.env);

  console.log(`[acp] Spawning ${acpBin} ${acpArgs.join(' ')} (driver=${AGENT_CLI})...`);
  agentProc = spawn(acpBin, acpArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: '/workspace',
    env: {
      ...process.env,
      // Driver-specific env vars (e.g. KIRO_LOG_LEVEL, ANTHROPIC_API_KEY)
      ...driverEnv,
      // Always forward these to the ACP subprocess
      NEPTUNE_ENDPOINT: process.env.NEPTUNE_ENDPOINT || '',
      PROJECT_ID: env.projectId,
      SPRINT_ID: process.env.SPRINT_ID || '',
      QUESTIONS_TABLE: process.env.QUESTIONS_TABLE || '',
      CONNECTIONS_TABLE: process.env.CONNECTIONS_TABLE || '',
      WEBSOCKET_ENDPOINT: process.env.WEBSOCKET_ENDPOINT || '',
      SUBMIT_QUESTION_LAMBDA: process.env.SUBMIT_QUESTION_LAMBDA || '',
      AGENTS_LAMBDA_NAME: process.env.AGENTS_LAMBDA_NAME || '',
      CREATE_PR_LAMBDA_NAME: process.env.CREATE_PR_LAMBDA_NAME || '',
      AWS_REGION: env.region,
    },
  });

  // Log stderr from the agent CLI for debugging
  const stderrChunks = [];
  agentProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    // Log line-by-line so each line appears as its own CloudWatch log event.
    for (const line of text.split('\n')) {
      if (line.length > 0) console.error(`[agent-stderr] ${line}`);
    }
  });

  const rl = readline.createInterface({ input: agentProc.stdout });
  rl.on('line', (line) => {
    try {
      handleMessage(JSON.parse(line));
    } catch {
      console.error('[acp] Failed to parse message:', line.slice(0, 200));
    }
  });

  agentProc.on('exit', async (code) => {
    console.log(`[acp] ${acpBin} exited with code ${code}`);
    // If the agent exited without producing stderr, surface that explicitly so
    // the failure mode is obvious in the logs.
    if (stderrChunks.length === 0) {
      console.error(`[acp] ${acpBin} exited (code=${code}) with no stderr output`);
    }
    rejectAllPending(new Error(`${acpBin} exited before responding`));
    // Only save status here if the prompt flow hasn't already handled it.
    // The statusSaved guard inside saveStatus() prevents double-writes.
    if (!statusSaved) {
      await saveStatus(code === 0 ? 'completed' : 'failed');
    }
    // Don't call process.exit() here — let the main() flow handle exit
    // to avoid racing with the prompt catch block.
  });

  // 1. Initialize
  console.log('[acp] Initializing...');
  const initResult = await request(
    'initialize',
    {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'ai-dlc-agent', version: '1.0.0' },
    },
    { timeoutMs: 60000 },
  );
  console.log('[acp] Initialized:', initResult.agentInfo?.name, initResult.agentInfo?.version);
  console.log('[acp] Agent capabilities:', JSON.stringify(initResult.agentCapabilities || {}));

  // 2. Create session — graph MCP server is always included; extra MCP servers
  //    are loaded from Secrets Manager and appended.
  console.log('[acp] Creating session...');
  // Build the env array for the graph MCP server.
  // All vars are listed explicitly because some ACP binaries (e.g. claude-agent-acp)
  // do NOT inherit the parent process environment when spawning MCP servers —
  // they only forward the env vars listed here. Kiro/OpenCode inherit the full
  // parent env, so they worked without this, but claude-agent-acp requires it.
  const graphMcpEnv = [
    { name: 'NEPTUNE_ENDPOINT', value: process.env.NEPTUNE_ENDPOINT || '' },
    { name: 'PROJECT_ID', value: env.projectId || '' },
    { name: 'SPRINT_ID', value: process.env.SPRINT_ID || '' },
    { name: 'QUESTIONS_TABLE', value: process.env.QUESTIONS_TABLE || '' },
    { name: 'CONNECTIONS_TABLE', value: process.env.CONNECTIONS_TABLE || '' },
    { name: 'WEBSOCKET_ENDPOINT', value: process.env.WEBSOCKET_ENDPOINT || '' },
    { name: 'SUBMIT_QUESTION_LAMBDA', value: process.env.SUBMIT_QUESTION_LAMBDA || '' },
    { name: 'AGENTS_LAMBDA_NAME', value: process.env.AGENTS_LAMBDA_NAME || '' },
    { name: 'CREATE_PR_LAMBDA_NAME', value: process.env.CREATE_PR_LAMBDA_NAME || '' },
    { name: 'POOL_TABLE', value: process.env.POOL_TABLE || '' },
    { name: 'EXECUTION_ID', value: env.executionId || '' },
    { name: 'AWS_REGION', value: env.region || 'us-east-1' },
    { name: 'GIT_TOKEN', value: process.env.GIT_TOKEN || '' },
    { name: 'GIT_REPO', value: process.env.GIT_REPO || '' },
  ];
  // Forward ECS task role credential env vars so the MCP server can call AWS APIs.
  // These are set automatically by ECS when a task role is attached; without them
  // the AWS SDK credential chain cannot resolve credentials inside the MCP process.
  const ecsCredVars = [
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_DEFAULT_REGION',
  ];
  for (const name of ecsCredVars) {
    if (process.env[name]) {
      graphMcpEnv.push({ name, value: process.env[name] });
    }
  }

  const configuredMcpServers = [
    {
      name: 'graph',
      command: 'node',
      args: [process.env.MCP_GRAPH_SERVER_PATH || '/opt/mcp-server-graph/index.js'],
      env: graphMcpEnv,
    },
    // Additional MCP servers from Secrets Manager (zero or more)
    ...extras,
  ];
  const mcpServers = filterRunnableMcpServers(configuredMcpServers, {
    requiredNames: new Set(['graph']),
  });
  console.log(`[acp] Starting session with ${mcpServers.length} MCP server(s)`);
  console.log('[acp] MCP servers:', mcpServers.map(mcpServerLabel).join(', '));
  // Redacted dump of the payload we're about to send. Header/env values are
  // replaced with their length so secrets don't end up in CloudWatch.
  console.log(
    '[acp] session/new payload (redacted):',
    JSON.stringify({
      cwd: '/workspace',
      mcpServers: mcpServers.map((s) => ({
        ...s,
        env: Array.isArray(s.env)
          ? s.env.map((e) => ({ name: e.name, value: `<${(e.value || '').length} chars>` }))
          : s.env,
        headers: Array.isArray(s.headers)
          ? s.headers.map((h) => ({ name: h.name, value: `<${(h.value || '').length} chars>` }))
          : s.headers,
      })),
    }),
  );

  const session = await request(
    'session/new',
    {
      cwd: '/workspace',
      mcpServers,
    },
    { timeoutMs: parseInt(process.env.ACP_SESSION_NEW_TIMEOUT_MS || '180000', 10) },
  );
  const sessionId = session.sessionId;
  console.log('[acp] Session created:', sessionId);

  // 2b. Switch to bypassPermissions mode if the agent supports it.
  // claude-agent-acp requires IS_SANDBOX=1 to offer bypassPermissions (because ECS
  // runs as root). When available, we activate it immediately so no tool call ever
  // blocks waiting for a human permission prompt — which would hang the session.
  // Kiro and OpenCode auto-allow tools via their own permission models, so this
  // call is harmless for those drivers (it will simply fail silently if unsupported).
  const availableModes = session.modes?.availableModes || [];
  const hasBypassMode = availableModes.some((m) => m.id === 'bypassPermissions');
  if (hasBypassMode) {
    try {
      await request(
        'session/set_mode',
        { sessionId, modeId: 'bypassPermissions' },
        { timeoutMs: 30000 },
      );
      console.log('[acp] Session mode set to bypassPermissions');
    } catch (modeErr) {
      // Non-fatal — we still have the session/request_permission handler as fallback
      console.warn('[acp] Could not set bypassPermissions mode:', modeErr.message);
    }
  } else {
    console.log(
      '[acp] bypassPermissions mode not available — relying on request_permission handler',
    );
  }

  broadcastEvent('agent.started', { projectId: env.projectId });
  await broadcastQueue;

  // 3. Send prompt
  console.log('[acp] Sending prompt...');
  let promptSucceeded = false;
  try {
    await request(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text: env.prompt }],
      },
      { timeoutMs: 0 },
    );
    console.log('[acp] Prompt completed');
    // Flush any buffered text chunks before saving/broadcasting completion
    flushChunksSync();
    await saveStatus('completed');
    // Wait for any pending broadcasts to drain before sending completion
    await broadcastQueue;
    broadcastEvent('agent.completed', {
      projectId: env.projectId,
      executionId: env.executionId,
      agentType: env.agentType,
    });
    await broadcastQueue;
    promptSucceeded = true;
  } catch (err) {
    reportAgentError(err);
    await saveStatus('failed');
    await broadcastQueue;
  }

  // Kill agent process and exit with appropriate code
  agentProc.kill();
  process.exit(promptSucceeded ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[acp] Fatal error:', err);
  reportAgentError(err);
  await saveStatus('failed');
  await broadcastQueue;
  process.exit(1);
});
