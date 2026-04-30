// ACP client wrapper - spawns the active agent CLI in ACP mode and communicates
// via JSON-RPC 2.0 over stdio. The CLI is selected via AGENT_CLI env var (default: kiro).
const { spawn } = require('child_process');
const readline = require('readline');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBClient, QueryCommand: DDBQueryCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
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

// ---------------------------------------------------------------------------
// Extra MCP servers — loaded once from SSM at startup
// ---------------------------------------------------------------------------
let extraMcpServers = null; // cached after first load

async function loadExtraMcpServers() {
  if (extraMcpServers !== null) return extraMcpServers;

  const ssmPath = process.env.MCP_SERVERS_SSM_PATH;
  if (!ssmPath) {
    extraMcpServers = [];
    return extraMcpServers;
  }

  try {
    const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const result = await ssm.send(new GetParameterCommand({ Name: ssmPath, WithDecryption: false }));
    const raw = result.Parameter?.Value || '[]';
    extraMcpServers = JSON.parse(raw);
    console.log(`[acp] Loaded ${extraMcpServers.length} extra MCP server(s) from SSM`);
  } catch (err) {
    console.error('[acp] Failed to load extra MCP servers from SSM:', err.message);
    extraMcpServers = [];
  }

  return extraMcpServers;
}

const lambda = new LambdaClient({});
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

const getConnection = async () => {
  if (!env.neptuneEndpoint) return null;
  const credentials = await fromNodeProviderChain()();
  credentials.region = env.region;
  const connInfo = getUrlAndHeaders(env.neptuneEndpoint, '8182', credentials, '/gremlin', 'wss');
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
// Track whether we've already persisted a final status to avoid double-saves
// (the prompt catch block and the kiro exit handler can both fire)
let statusSaved = false;

function send(method, params) {
  const id = msgId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  agentProc.stdin.write(msg + '\n');
  return id;
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = send(method, params);
    pending.set(id, { resolve, reject });
  });
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
  if (cachedConnections && (now - connectionsCacheTime) < CONNECTIONS_CACHE_TTL) {
    return cachedConnections;
  }
  if (!env.connectionsTable) return [];
  try {
    const documentId = env.sprintId ? `sprint:${env.sprintId}` : env.projectId;
    const result = await broadcastDdb.send(new DDBQueryCommand({
      TableName: env.connectionsTable,
      IndexName: 'DocumentIdIndex',
      KeyConditionExpression: 'documentId = :docId',
      ExpressionAttributeValues: { ':docId': { S: documentId } },
    }));
    cachedConnections = (result.Items || []).map(item => item.connectionId.S);
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
      const payload = JSON.stringify({ type, agentTaskId: env.agentTaskId || undefined, ...data });
      await Promise.all(connectionIds.map(connId =>
        broadcastWsClient.send(new PostToConnectionCommand({
          ConnectionId: connId,
          Data: payload,
        })).catch((err) => {
          // Connection gone (410) -- invalidate cache so we re-fetch
          if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
            cachedConnections = null;
          }
        })
      ));
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
  statusSaved = true;
  try {
    await ddb.send(new PutCommand({
      TableName: env.agentOutputsTable,
      Item: {
        executionId: env.executionId,
        agentType: env.agentType,
        projectId: env.projectId,
        sprintId: env.sprintId || undefined,
        status,
        // Persist the full accumulated agent output so it can be fetched later
        outputText: fullOutputBuffer || undefined,
        completedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
      },
    }));
    
    // Update Sprint vertex with completion status
    if (env.sprintId) {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        const agentStatus = status === 'completed' ? 'completed' : 'failed';
        await g.V().has('Sprint', 'id', env.sprintId)
          .property(cardinality.single, 'current_agent_status', agentStatus)
          .property(cardinality.single, 'agent_completed_at', new Date().toISOString())
          .next();
      });
    }

    // Clear task_execution_status on the Task vertex so the orchestrator knows this agent is done.
    // Without this, task_execution_status stays "RUNNING" forever and the orchestrator
    // thinks an agent is still working on the task.
    if (env.agentTaskId) {
      await withNeptune(async (g) => {
        const { cardinality } = gremlin.process;
        const execStatus = status === 'completed' ? 'COMPLETED' : 'FAILED';
        await g.V().has('Task', 'id', env.agentTaskId)
          .property(cardinality.single, 'task_execution_status', execStatus)
          .next();
        console.log(`[acp] Updated task ${env.agentTaskId} task_execution_status to ${execStatus}`);
      });
    }
  } catch (err) {
    console.error('Failed to save status:', err.message);
  }
}

function handleMessage(msg) {
  // Log all incoming messages for debugging
  if (msg.method) {
    console.log(`[acp] << ${msg.id !== undefined ? 'request' : 'notification'}: ${msg.method}`);
  } else if (msg.id !== undefined) {
    console.log(`[acp] << response id=${msg.id} ${msg.error ? 'ERROR: ' + msg.error.message : 'ok'}`);
  }

  // Response to a request we sent
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      console.error('[acp] Error response details:', JSON.stringify(msg.error));
      reject(new Error(msg.error.message));
    }
    else resolve(msg.result);
    return;
  }

  // Incoming request from the agent (has both id and method)
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options || [];
      // Select the best available option from what kiro-cli actually offered.
      // Prefer allow_always > allow_once > first available option.
      // NEVER fabricate an optionId — it must come from the options array.
      const selected = options.find(o => o.kind === 'allow_always')
        || options.find(o => o.kind === 'allow_once')
        || options[0];
      if (selected) {
        console.log(`[acp] Permission request: selecting '${selected.kind}' (optionId=${selected.optionId}) from ${options.length} options`);
        agentProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: selected.optionId } } }) + '\n');
      } else {
        console.error(`[acp] Permission request has no options, sending empty selection. params:`, JSON.stringify(msg.params));
        agentProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }) + '\n');
      }
    } else {
      console.warn(`[acp] Unhandled request method '${msg.method}', responding with empty result. Full params:`, JSON.stringify(msg.params));
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
        text = content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('');
      }
    }
    if (!text && typeof update.text === 'string') {
      text = update.text;
    }
    if (!text) {
      if (ACP_VERBOSE) {
        console.warn(`[acp] ${kind} with no extractable text. Raw update:`, JSON.stringify(update).slice(0, 500));
      } else {
        console.warn(`[acp] ${kind} with no extractable text (set ACP_VERBOSE=true to log raw update)`);
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

      console.log(`[acp] Tool call: ${toolName} (${toolStatus} -> ${frontendStatus}) id=${toolId || 'none'}`);
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
  // Load extra MCP servers from Secrets Manager (non-blocking, cached)
  const extras = await loadExtraMcpServers();

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
    process.stderr.write(`[agent-stderr] ${text}`);
  });

  const rl = readline.createInterface({ input: agentProc.stdout });
  rl.on('line', (line) => {
    try {
      handleMessage(JSON.parse(line));
    } catch (err) {
      console.error('[acp] Failed to parse message:', line.slice(0, 200));
    }
  });

  agentProc.on('exit', async (code) => {
    console.log(`[acp] ${acpBin} exited with code ${code}`);
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
  const initResult = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'ai-dlc-agent', version: '1.0.0' },
  });
  console.log('[acp] Initialized:', initResult.agentInfo?.name, initResult.agentInfo?.version);

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

  const mcpServers = [
    {
      name: 'graph',
      command: 'node',
      args: [process.env.MCP_GRAPH_SERVER_PATH || '/opt/mcp-server-graph/index.js'],
      env: graphMcpEnv,
    },
    // Additional MCP servers from Secrets Manager (zero or more)
    ...extras,
  ];
  console.log(`[acp] Starting session with ${mcpServers.length} MCP server(s)`);

  const session = await request('session/new', {
    cwd: '/workspace',
    mcpServers,
  });
  const sessionId = session.sessionId;
  console.log('[acp] Session created:', sessionId);

  // 2b. Switch to bypassPermissions mode if the agent supports it.
  // claude-agent-acp requires IS_SANDBOX=1 to offer bypassPermissions (because ECS
  // runs as root). When available, we activate it immediately so no tool call ever
  // blocks waiting for a human permission prompt — which would hang the session.
  // Kiro and OpenCode auto-allow tools via their own permission models, so this
  // call is harmless for those drivers (it will simply fail silently if unsupported).
  const availableModes = session.modes?.availableModes || [];
  const hasBypassMode = availableModes.some(m => m.id === 'bypassPermissions');
  if (hasBypassMode) {
    try {
      await request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
      console.log('[acp] Session mode set to bypassPermissions');
    } catch (modeErr) {
      // Non-fatal — we still have the session/request_permission handler as fallback
      console.warn('[acp] Could not set bypassPermissions mode:', modeErr.message);
    }
  } else {
    console.log('[acp] bypassPermissions mode not available — relying on request_permission handler');
  }

  broadcastEvent('agent.started', { projectId: env.projectId });
  await broadcastQueue;

  // 3. Send prompt
  console.log('[acp] Sending prompt...');
  let promptSucceeded = false;
  try {
    await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: env.prompt }],
    });
    console.log('[acp] Prompt completed');
    // Flush any buffered text chunks before saving/broadcasting completion
    flushChunksSync();
    await saveStatus('completed');
    // Wait for any pending broadcasts to drain before sending completion
    await broadcastQueue;
    broadcastEvent('agent.completed', { projectId: env.projectId });
    await broadcastQueue;
    promptSucceeded = true;
  } catch (err) {
    console.error('[acp] Prompt failed:', err.message);
    flushChunksSync();
    await saveStatus('failed');
    await broadcastQueue;
    broadcastEvent('agent.error', { error: err.message });
    await broadcastQueue;
  }

  // Kill agent process and exit with appropriate code
  agentProc.kill();
  process.exit(promptSucceeded ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[acp] Fatal error:', err);
  await saveStatus('failed');
  process.exit(1);
});
