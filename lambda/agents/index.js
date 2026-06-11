// Agents Lambda - handles agent task pool, status, Q&A, and graph queries
const {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} = require('@aws-sdk/client-ecs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParametersCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');
const { resolveGitToken } = require('./shared/git-token');
const { validateMcpServersJson } = require('./shared/mcp-validator');

const ecs = new ECSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const { cardinality } = gremlin.process;
const __ = gremlin.process.statics;

const POOL_TABLE = process.env.POOL_TABLE || '';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
const MAX_POOL_WORKERS = parseInt(process.env.MAX_POOL_WORKERS || String(POOL_SIZE * 2), 10);
const POOL_TASK_DEFINITION_ARN = process.env.AGENT_TASK_DEFINITION_ARN || '';
const POOL_VERSION = process.env.POOL_VERSION || 'unknown';
const STALE_STARTING_MS = 5 * 60 * 1000; // 5 minutes
const STALE_IDLE_MS = 3 * 60 * 1000; // 3 minutes
const STALE_BUSY_MS = 30 * 60 * 1000; // 30 minutes — sub-agents should not run this long

// ---------------------------------------------------------------------------
// Repo / branch validation — authoritative gate before values reach the
// pool-worker, which interpolates them into shell `git` commands. The projects
// lambda validates on write, but legacy/pre-existing `git_repo` values were
// stored without validation, so we MUST re-validate here on the read path.
// Validators live in shared/ so the agents and projects lambdas can't drift.
// ---------------------------------------------------------------------------

const { isSafeRepo, isSafeRef } = require('./shared/repo-validation');

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';
  const credentials = await fromNodeProviderChain()();
  credentials.region = region;
  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

async function withNeptune(fn) {
  const conn = await getConnection();
  try {
    const g = traversal().withRemote(conn);
    return await fn(g);
  } finally {
    await conn.close();
  }
}

// --- Task Pool Logic ---

async function findIdleWorkers(agentCli) {
  if (!POOL_TABLE) return [];
  const result = await ddb.send(
    new QueryCommand({
      TableName: POOL_TABLE,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#s = :s',
      FilterExpression: 'version = :v AND contains(availableClis, :cli)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'idle', ':v': POOL_VERSION, ':cli': agentCli },
      Limit: 10,
    }),
  );
  return result.Items || [];
}

// ---------------------------------------------------------------------------
// CLI pre-flight checks
//
// Before dispatching a job we verify the selected CLI has the credentials it
// needs. Without this, a misconfigured CLI (missing/invalid SSM key) results
// in a silently hung job: the worker catches the auth error internally, never
// advertises the CLI, and the job only times out after 45 minutes.
// ---------------------------------------------------------------------------

// CLI -> SSM parameter that stores its credential. Must stay in sync with
// the `${prefix}/...` keys used by the GET/PUT /agents/settings handlers above.
function ssmPathForCli(cliName) {
  const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
  if (!prefix) return null;
  if (cliName === 'kiro') return `${prefix}/kiro-api-key`;
  if (cliName === 'claude' || cliName === 'opencode') return `${prefix}/bedrock-bearer-token`;
  return null;
}

function humanCliName(cliName) {
  return cliName === 'kiro'
    ? 'Kiro'
    : cliName === 'claude'
      ? 'Claude'
      : cliName === 'opencode'
        ? 'OpenCode'
        : cliName;
}

/**
 * Returns { configured: true } if the SSM parameter for the CLI's credential
 * is set to a non-placeholder value, otherwise { configured: false, reason }.
 */
async function checkCliConfigured(cliName) {
  const ssmPath = ssmPathForCli(cliName);
  if (!ssmPath) {
    return { configured: false, reason: `No SSM path mapped for CLI "${cliName}"` };
  }
  try {
    const result = await ssm.send(
      new GetParametersCommand({
        Names: [ssmPath],
        WithDecryption: true,
      }),
    );
    const param = (result.Parameters || [])[0];
    const value = param?.Value || '';
    if (!value || value === 'placeholder') {
      const human = humanCliName(cliName);
      const credLabel = cliName === 'kiro' ? 'API key' : 'Bedrock bearer token';
      return {
        configured: false,
        reason: `${human} is not configured. Set the ${credLabel} in Admin → Agent Settings before starting agents for this project.`,
      };
    }
    return { configured: true };
  } catch (err) {
    return {
      configured: false,
      reason: `Could not read credential for ${humanCliName(cliName)} from SSM: ${err.message}`,
    };
  }
}

/**
 * Collect the most recent auth error for a CLI across current-version workers.
 * Returns a string (the first non-empty message) or null if no worker has
 * reported an error yet.
 */
async function collectWorkerAuthError(cliName) {
  if (!POOL_TABLE) return null;
  try {
    const result = await ddb.send(new ScanCommand({ TableName: POOL_TABLE }));
    for (const w of result.Items || []) {
      if (w.version !== POOL_VERSION) continue;
      const msg = w.cliAuthErrors?.[cliName];
      if (msg) return msg;
    }
  } catch (err) {
    console.error('[agents] collectWorkerAuthError scan failed:', err.message);
  }
  return null;
}

async function assignJobToWorker(workerId, job) {
  await ddb.send(
    new UpdateCommand({
      TableName: POOL_TABLE,
      Key: { workerId },
      UpdateExpression: 'SET #s = :assigned, job = :job, lastHeartbeat = :t',
      ConditionExpression: '#s = :idle',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':assigned': 'assigned',
        ':idle': 'idle',
        ':job': job,
        ':t': Date.now(),
      },
    }),
  );
}

async function launchPoolWorker(workerId) {
  const result = await ecs.send(
    new RunTaskCommand({
      cluster: process.env.ECS_CLUSTER_ARN,
      taskDefinition: POOL_TASK_DEFINITION_ARN,
      launchType: 'FARGATE',
      enableExecuteCommand: true,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: JSON.parse(process.env.PRIVATE_SUBNET_IDS || '[]'),
          securityGroups: [process.env.AGENT_SECURITY_GROUP_ID],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'agent',
            environment: [
              { name: 'WORKER_ID', value: workerId },
              // CLIs are discovered at runtime by probing installed binaries —
              // no AGENT_CAPABILITIES override needed.
            ],
          },
        ],
      },
    }),
  );
  const task = result.tasks?.[0];
  if (!task) throw new Error('Failed to launch pool worker');

  await ddb.send(
    new PutCommand({
      TableName: POOL_TABLE,
      Item: {
        workerId,
        status: 'starting',
        taskArn: task.taskArn,
        version: 'starting',
        lastHeartbeat: Date.now(),
      },
    }),
  );

  return task.taskArn;
}

async function cleanupStaleWorkers() {
  if (!POOL_TABLE) return;
  const now = Date.now();
  for (const status of ['starting', 'idle', 'busy']) {
    const threshold =
      status === 'starting' ? STALE_STARTING_MS : status === 'idle' ? STALE_IDLE_MS : STALE_BUSY_MS;
    const result = await ddb.send(
      new QueryCommand({
        TableName: POOL_TABLE,
        IndexName: 'StatusIndex',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    );
    for (const w of result.Items || []) {
      if (w.lastHeartbeat && now - w.lastHeartbeat > threshold) {
        console.log(
          `Cleaning up stale ${status} worker ${w.workerId} (last heartbeat ${now - w.lastHeartbeat}ms ago)`,
        );
        // When cleaning up a stale busy worker with a sprint job, mark Sprint and AgentRun as failed
        if (status === 'busy' && w.job?.sprintId) {
          try {
            await withNeptune(async (g) => {
              const completedAt = new Date().toISOString();
              await g
                .V()
                .has('Sprint', 'id', w.job.sprintId)
                .property(cardinality.single, 'current_agent_status', 'failed')
                .property(cardinality.single, 'agent_completed_at', completedAt)
                .next();
              if (w.job.executionId) {
                await g
                  .V()
                  .hasLabel('AgentRun')
                  .has('execution_id', w.job.executionId)
                  .property(cardinality.single, 'status', 'failed')
                  .property(cardinality.single, 'completed_at', completedAt)
                  .next();
              }
            });
          } catch (e) {
            console.error('Failed to update Neptune for stale worker:', e.message);
          }
        }
        if (w.taskArn)
          await ecs
            .send(
              new StopTaskCommand({
                cluster: process.env.ECS_CLUSTER_ARN,
                task: w.taskArn,
                reason: `Stale ${status} worker cleanup`,
              }),
            )
            .catch(() => {});
        await ddb
          .send(new DeleteCommand({ TableName: POOL_TABLE, Key: { workerId: w.workerId } }))
          .catch(() => {});
      }
    }
  }
}

async function ensurePoolSize() {
  if (!POOL_TABLE || !POOL_TASK_DEFINITION_ARN) return;
  try {
    const poolVersion = POOL_VERSION;
    const queryByStatus = async (status) => {
      const r = await ddb.send(
        new QueryCommand({
          TableName: POOL_TABLE,
          IndexName: 'StatusIndex',
          KeyConditionExpression: '#s = :s',
          FilterExpression: 'version = :v',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status, ':v': poolVersion },
        }),
      );
      return r.Items || [];
    };
    const idle = await queryByStatus('idle');
    const busy = await queryByStatus('busy');
    const starting = await queryByStatus('starting');
    const assigned = await queryByStatus('assigned');
    const total = idle.length + busy.length + starting.length + assigned.length;

    // Cull excess idle workers beyond POOL_SIZE
    if (idle.length > POOL_SIZE) {
      const excess = idle.slice(POOL_SIZE);
      for (const w of excess) {
        console.log(`Draining excess idle worker ${w.workerId}`);
        await ddb
          .send(
            new UpdateCommand({
              TableName: POOL_TABLE,
              Key: { workerId: w.workerId },
              UpdateExpression: 'SET #s = :s',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':s': 'draining' },
            }),
          )
          .catch(() => {});
      }
    }

    // Launch new workers to fill up to POOL_SIZE
    for (let i = 0; i < Math.max(0, POOL_SIZE - total); i++) {
      await launchPoolWorker(`worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    }
  } catch (err) {
    console.error('ensurePoolSize error:', err.message);
  }
}

async function getTaskStatus(taskArn) {
  const result = await ecs.send(
    new DescribeTasksCommand({ cluster: process.env.ECS_CLUSTER_ARN, tasks: [taskArn] }),
  );
  const task = result.tasks?.[0];
  if (!task) return { status: 'STOPPED', lastStatus: 'UNKNOWN' };
  const lastStatus = task.lastStatus;
  const stoppedReason = task.stoppedReason || '';
  let status;
  if (['RUNNING', 'PENDING', 'PROVISIONING'].includes(lastStatus)) status = 'RUNNING';
  else if (lastStatus === 'STOPPED') {
    const exitCode = task.containers?.[0]?.exitCode;
    status =
      exitCode === 0 ? 'SUCCEEDED' : stoppedReason.includes('imeout') ? 'TIMED_OUT' : 'FAILED';
  } else status = 'RUNNING';
  return { status, lastStatus, stoppedReason };
}

// --- Handler ---

exports.handler = async (event) => {
  const response = buildResponse(event);
  const { httpMethod, path = '', pathParameters, body } = event;
  const projectId = pathParameters?.projectId;
  const taskId = pathParameters?.taskId ? decodeURIComponent(pathParameters.taskId) : null;
  const questionId = pathParameters?.questionId;
  const workerId = pathParameters?.workerId;
  const reqId = pathParameters?.reqId;
  const storyId = pathParameters?.storyId;

  try {
    // ===== AGENT SETTINGS (SSM-backed, editable via Admin UI) =====

    // GET /agents/settings — read bearer token, Kiro API key, and MCP servers from SSM
    if (httpMethod === 'GET' && path.endsWith('/settings')) {
      const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
      const bearerPath = `${prefix}/bedrock-bearer-token`;
      const mcpPath = `${prefix}/mcp-servers`;
      const kiroApiKeyPath = `${prefix}/kiro-api-key`;
      try {
        const result = await ssm.send(
          new GetParametersCommand({
            Names: [bearerPath, mcpPath, kiroApiKeyPath],
            WithDecryption: true,
          }),
        );
        const byName = {};
        for (const p of result.Parameters || []) byName[p.Name] = p.Value;
        const bearerToken = byName[bearerPath] || '';
        const kiroApiKey = byName[kiroApiKeyPath] || '';
        const mcpServersRaw = byName[mcpPath] || '[]';
        // Return secrets as masked flags (never send the raw values to the browser)
        return response(200, {
          bedrockBearerTokenSet: bearerToken !== '' && bearerToken !== 'placeholder',
          kiroApiKeySet: kiroApiKey !== '' && kiroApiKey !== 'placeholder',
          mcpServers: mcpServersRaw,
        });
      } catch (err) {
        console.error('[settings] GET failed:', err.message);
        return response(500, { error: 'Failed to load settings from SSM' });
      }
    }

    // PUT /agents/settings — write bearer token, Kiro API key, and/or MCP servers to SSM
    if (httpMethod === 'PUT' && path.endsWith('/settings')) {
      const prefix = process.env.AGENT_SETTINGS_SSM_PREFIX || '';
      const input = JSON.parse(body || '{}');
      const errors = [];

      if (typeof input.bedrockBearerToken === 'string') {
        // Empty string clears the token (stored as literal "placeholder" sentinel)
        const value = input.bedrockBearerToken.trim() || 'placeholder';
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/bedrock-bearer-token`,
              Value: value,
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write bearer token:', err.message);
          errors.push('bedrockBearerToken: ' + err.message);
        }
      }

      if (typeof input.kiroApiKey === 'string') {
        const value = input.kiroApiKey.trim() || 'placeholder';
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/kiro-api-key`,
              Value: value,
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write Kiro API key:', err.message);
          errors.push('kiroApiKey: ' + err.message);
        }
      }

      if (typeof input.mcpServers === 'string') {
        const validation = validateMcpServersJson(input.mcpServers);
        if (!validation.valid) {
          return response(400, {
            error: 'Invalid MCP servers configuration',
            issues: validation.issues,
          });
        }
        try {
          await ssm.send(
            new PutParameterCommand({
              Name: `${prefix}/mcp-servers`,
              Value: input.mcpServers,
              Type: 'String',
              Overwrite: true,
            }),
          );
        } catch (err) {
          console.error('[settings] Failed to write MCP servers:', err.message);
          errors.push('mcpServers: ' + err.message);
        }
      }

      if (errors.length > 0) return response(500, { error: errors.join('; ') });
      return response(200, { saved: true });
    }

    // ===== POOL ADMIN ENDPOINTS =====

    // GET /agents/capabilities — CLIs available across live pool workers.
    // Always derived from the live pool — no static fallback.
    // Returns an empty list when no workers are running; warm the pool first.
    if (httpMethod === 'GET' && path.endsWith('/capabilities')) {
      const cliSet = new Set();
      if (POOL_TABLE) {
        try {
          const result = await ddb.send(new ScanCommand({ TableName: POOL_TABLE }));
          for (const w of result.Items || []) {
            for (const cli of w.availableClis || []) {
              cliSet.add(cli);
            }
          }
        } catch (e) {
          console.error('[capabilities] pool scan failed:', e.message);
        }
      }
      return response(200, { available: [...cliSet] });
    }

    // GET /agents/pool - List all pool workers
    if (httpMethod === 'GET' && path.endsWith('/pool') && !workerId) {
      if (!POOL_TABLE)
        return response(200, { workers: [], currentVersion: POOL_VERSION, poolSize: POOL_SIZE });
      const result = await ddb.send(new ScanCommand({ TableName: POOL_TABLE }));
      const workers = (result.Items || []).map((w) => ({
        workerId: w.workerId,
        status: w.status,
        version: w.version || 'unknown',
        availableClis: w.availableClis || [],
        cliAuthErrors: w.cliAuthErrors || {},
        agentCli: w.agentCli || null, // legacy field, kept for compatibility
        taskArn: w.taskArn,
        lastHeartbeat: w.lastHeartbeat,
        job: w.job
          ? {
              executionId: w.job.executionId,
              projectId: w.job.projectId,
              agentType: w.job.agentType,
            }
          : null,
      }));
      return response(200, { workers, currentVersion: POOL_VERSION, poolSize: POOL_SIZE });
    }

    // POST /agents/pool/warm - Launch workers to fill pool
    if (httpMethod === 'POST' && path.endsWith('/pool/warm')) {
      if (!POOL_TABLE) return response(400, { error: 'Pool not configured' });
      const input = JSON.parse(body || '{}');
      const count = Math.min(input.count || POOL_SIZE, 10);
      const launched = [];
      for (let i = 0; i < count; i++) {
        const wid = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const arn = await launchPoolWorker(wid);
        launched.push({ workerId: wid, taskArn: arn });
      }
      return response(200, { launched, version: POOL_VERSION });
    }

    // POST /agents/pool/recycle - Drain old-version workers and warm new ones
    if (httpMethod === 'POST' && path.endsWith('/pool/recycle')) {
      if (!POOL_TABLE) return response(400, { error: 'Pool not configured' });
      const poolVersion = POOL_VERSION;
      let drained = 0;
      for (const status of ['idle', 'busy', 'assigned', 'starting']) {
        const result = await ddb.send(
          new QueryCommand({
            TableName: POOL_TABLE,
            IndexName: 'StatusIndex',
            KeyConditionExpression: '#s = :s',
            FilterExpression: 'version <> :v',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': status, ':v': poolVersion },
          }),
        );
        for (const item of result.Items || []) {
          if (status === 'idle' || status === 'starting') {
            if (item.taskArn)
              await ecs
                .send(
                  new StopTaskCommand({
                    cluster: process.env.ECS_CLUSTER_ARN,
                    task: item.taskArn,
                    reason: 'Pool recycle',
                  }),
                )
                .catch(() => {});
            await ddb
              .send(new DeleteCommand({ TableName: POOL_TABLE, Key: { workerId: item.workerId } }))
              .catch(() => {});
          } else {
            await ddb
              .send(
                new UpdateCommand({
                  TableName: POOL_TABLE,
                  Key: { workerId: item.workerId },
                  UpdateExpression: 'SET #s = :s',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': 'draining' },
                }),
              )
              .catch(() => {});
          }
          drained++;
        }
      }
      await ensurePoolSize();
      return response(200, { drained, version: poolVersion });
    }

    // DELETE /agents/pool/{workerId} - Kill a specific worker
    if (httpMethod === 'DELETE' && workerId) {
      if (!POOL_TABLE) return response(400, { error: 'Pool not configured' });
      const worker = await ddb.send(new GetCommand({ TableName: POOL_TABLE, Key: { workerId } }));
      if (!worker.Item) return response(404, { error: 'Worker not found' });
      if (worker.Item.taskArn) {
        await ecs
          .send(
            new StopTaskCommand({
              cluster: process.env.ECS_CLUSTER_ARN,
              task: worker.Item.taskArn,
              reason: 'Killed by admin',
            }),
          )
          .catch(() => {});
      }
      await ddb.send(new DeleteCommand({ TableName: POOL_TABLE, Key: { workerId } }));
      return response(200, { killed: true });
    }

    // ===== PROJECT AGENT ENDPOINTS =====

    // POST /projects/{projectId}/agents - Start agent
    if (httpMethod === 'POST' && path.endsWith('/agents') && projectId && !taskId) {
      const userId = event.requestContext?.authorizer?.claims?.sub;
      const input = JSON.parse(body || '{}');
      const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      let gitRepo = '',
        description = input.description || '',
        sprintPhase = '',
        projectAgentCli = 'kiro';
      let gitRepos = [];
      let isMember = false;
      await withNeptune(async (g) => {
        const result = await g.V().has('Project', 'id', projectId).valueMap().next();
        if (result.value?.get) {
          gitRepo = result.value.get('git_repo')?.[0] || '';
          projectAgentCli = result.value.get('agent_cli')?.[0] || 'kiro';
        }
        // Fetch all Repository vertices linked to the project (multi-repo support)
        const repoVertices = await g
          .V()
          .has('Project', 'id', projectId)
          .out('HAS_REPO')
          .hasLabel('Repository')
          .valueMap()
          .toList();
        if (repoVertices.length > 0) {
          gitRepos = repoVertices.map((r) => ({
            url: (r.get('url') || [''])[0],
            role: (r.get('role') || ['unknown'])[0],
            detectedStack: (r.get('detected_stack') || [''])[0],
          }));
          // Ensure gitRepo (primary) is derived from repos list for backward compat
          const primary = gitRepos.find((r) => r.role === 'primary') || gitRepos[0];
          if (primary && !gitRepo) gitRepo = primary.url;
        }
        if (input.sprintId) {
          const sr = await g.V().has('Sprint', 'id', input.sprintId).valueMap().next();
          if (sr.value?.get) {
            sprintPhase = sr.value.get('phase')?.[0] || 'INCEPTION';
            description = description || sr.value.get('description')?.[0] || '';
          }
        }
        // Verify the requesting user is a member of this project
        if (userId) {
          isMember = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .inV()
            .has('User', 'id', userId)
            .hasNext();
        }
      });

      // Allow system/orchestrator re-triggers to bypass membership check
      if (!isMember && userId !== 'system' && userId !== 'orchestrator') {
        return response(403, {
          error: 'Access denied',
          message: 'You are not a member of this project',
        });
      }

      // Pre-flight: verify the project's selected CLI has credentials configured.
      // Without this check, a misconfigured CLI (missing/invalid SSM key) would
      // cause the pool worker's authenticate() to silently fail, the CLI would
      // never be advertised, and the job would hang until the 45-minute stale
      // timeout. System/orchestrator re-triggers skip this check because they
      // represent internal re-entries for jobs already past the user-facing gate.
      if (userId !== 'system' && userId !== 'orchestrator') {
        const preflight = await checkCliConfigured(projectAgentCli);
        if (!preflight.configured) {
          // If any worker already tried and failed to authenticate, surface the
          // real reason (e.g. "kiro-cli whoami failed — invalid key") instead
          // of the generic "not configured" message.
          const workerErr = await collectWorkerAuthError(projectAgentCli);
          return response(400, {
            error: 'cli_unavailable',
            cli: projectAgentCli,
            message: workerErr || preflight.reason,
            actionHref: '/admin#agent-settings',
            actionLabel: 'Open Agent Settings',
          });
        }
      }

      // Look up user's GitHub token from git connections table
      let gitToken = '';
      if (userId && process.env.GIT_CONNECTIONS_TABLE) {
        try {
          const { Item } = await ddb.send(
            new GetCommand({
              TableName: process.env.GIT_CONNECTIONS_TABLE,
              Key: { userId },
            }),
          );
          if (Item?.parameterName || Item?.accessToken) {
            gitToken = await resolveGitToken(ssm, Item);
          }
        } catch (e) {
          console.error('Failed to fetch git token:', e.message);
        }
      }

      // Fall back to gitToken passed in request body (used by orchestrator/system re-triggers)
      if (!gitToken && input.gitToken) {
        gitToken = input.gitToken;
      }

      // Require GitHub connection for projects with a git repo
      if (gitRepo && !gitToken) {
        return response(400, {
          error: 'GitHub not connected',
          message:
            'You must connect your GitHub account before running agents on this project. Go to project settings to connect GitHub.',
        });
      }

      // SECURITY: re-validate every repo URL and git ref before they reach the
      // pool-worker, which interpolates them into shell `git` commands. Legacy
      // `git_repo` values may predate the projects-lambda write-time validation,
      // so this read-path gate is authoritative against command injection.
      for (const url of [gitRepo, ...gitRepos.map((r) => r.url)].filter(Boolean)) {
        if (!isSafeRepo(url)) {
          console.error(`[agents] Rejecting job: unsafe repository url ${JSON.stringify(url)}`);
          return response(400, {
            error: 'Invalid repository',
            message: 'A linked repository URL contains unsafe characters and cannot be cloned.',
          });
        }
      }
      for (const ref of [input.branch, input.baseBranch].filter(Boolean)) {
        if (!isSafeRef(ref)) {
          console.error(`[agents] Rejecting job: unsafe git ref ${JSON.stringify(ref)}`);
          return response(400, {
            error: 'Invalid branch',
            message: 'The branch name contains characters that are not allowed.',
          });
        }
      }

      const job = {
        executionId,
        projectId,
        agentType: input.phase || sprintPhase || 'inception',
        description,
        gitRepo,
        gitRepos,
        userId: userId || '',
        sprintId: input.sprintId || '',
        taskId: input.taskId || '',
        branch: input.branch || '',
        baseBranch: input.baseBranch || 'main',
        gitToken,
        event: input.event || null,
        runNumber: 1,
        changeRequest: input.changeRequest || '',
        agentCli: projectAgentCli,
      };

      // Cleanup stale workers before looking for idle ones
      await cleanupStaleWorkers().catch((e) =>
        console.error('cleanupStaleWorkers error:', e.message),
      );

      // Try to assign to an idle worker — retry multiple candidates to handle
      // race conditions where another job grabs the same worker concurrently.
      const idleWorkers = await findIdleWorkers(job.agentCli);
      let taskArn;
      for (const idle of idleWorkers) {
        try {
          await assignJobToWorker(idle.workerId, job);
          taskArn = idle.taskArn || idle.workerId;
          break;
        } catch {
          // ConditionalCheckFailed — another request grabbed this worker, try next
          console.log(
            `[agents] Worker ${idle.workerId} assignment failed (likely race), trying next`,
          );
        }
      }
      if (!taskArn) {
        if (POOL_TABLE) {
          const allWorkers = await ddb.send(new ScanCommand({ TableName: POOL_TABLE }));
          const items = allWorkers.Items || [];

          // Before launching a fresh worker, check whether any *existing* worker
          // has already tried and failed to authenticate this CLI. If so, a new
          // worker running the same image will fail the same way — fail fast and
          // surface the real reason instead of making the user wait 45 minutes
          // for the stale timeout.
          if (userId !== 'system' && userId !== 'orchestrator') {
            // Only look at workers on the current pool version; older versions
            // may have had different CLIs installed or different credentials.
            const currentVersion = items.filter((w) => w.version === POOL_VERSION);
            const anyAdvertising = currentVersion.some((w) =>
              (w.availableClis || []).includes(job.agentCli),
            );
            if (currentVersion.length > 0 && !anyAdvertising) {
              // Pick the first reported auth error for this CLI.
              const reported = currentVersion
                .map((w) => w.cliAuthErrors?.[job.agentCli])
                .find(Boolean);
              if (reported) {
                return response(400, {
                  error: 'cli_unavailable',
                  cli: job.agentCli,
                  message: `${humanCliName(job.agentCli)} failed to authenticate on every worker: ${reported}`,
                  actionHref: '/admin#agent-settings',
                  actionLabel: 'Open Agent Settings',
                });
              }
            }
          }

          // Check pool cap before launching a new worker (reuse the scan above)
          if (items.length >= MAX_POOL_WORKERS) {
            return response(503, {
              error: 'Agent pool at capacity',
              message: `Maximum ${MAX_POOL_WORKERS} workers reached. Please try again shortly.`,
            });
          }
        }
        const wid = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const arn = await launchPoolWorker(wid);
        await ddb.send(
          new UpdateCommand({
            TableName: POOL_TABLE,
            Key: { workerId: wid },
            UpdateExpression: 'SET #s = :s, job = :j',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': 'assigned', ':j': job },
          }),
        );
        taskArn = arn;
      }
      ensurePoolSize().catch(() => {});

      try {
        await withNeptune(async (g) => {
          // Store execution info on Task node for sub-agents
          if (input.taskId) {
            await g
              .V()
              .has('Task', 'id', input.taskId)
              .property(cardinality.single, 'task_execution_id', executionId)
              .property(cardinality.single, 'task_execution_arn', taskArn)
              .property(cardinality.single, 'task_execution_status', 'RUNNING')
              .property(cardinality.single, 'task_dispatched_at', new Date().toISOString())
              .property(cardinality.single, 'status', 'in_progress')
              .next();
          }

          // Store execution info on Sprint node (NEW: replaces Project storage)
          if (input.sprintId) {
            const updateQuery = g
              .V()
              .has('Sprint', 'id', input.sprintId)
              .property(cardinality.single, 'current_execution_arn', taskArn)
              .property(cardinality.single, 'current_execution_id', executionId)
              .property(cardinality.single, 'current_agent_type', job.agentType)
              .property(cardinality.single, 'current_agent_status', 'running')
              .property(cardinality.single, 'agent_started_at', new Date().toISOString());

            // Update sprint phase only for inception (other phases require manual approval)
            const agentType = (job.agentType || '').toLowerCase();
            if (agentType === 'inception') {
              updateQuery.property(cardinality.single, 'phase', 'INCEPTION');
            }
            // Note: CONSTRUCTION and REVIEW phases are set via manual approval in the UI

            await updateQuery.next();

            // When a construction-orchestrator re-run starts (run_number > 1), mark any
            // existing Review nodes for this sprint as stale so the review phase creates fresh ones.
            const isConstructionOrchestrator =
              (job.agentType || '').toLowerCase() === 'construction-orchestrator';
            if (isConstructionOrchestrator) {
              try {
                await g
                  .V()
                  .has('Sprint', 'id', input.sprintId)
                  .out('HAS_REVIEW')
                  .hasLabel('Review')
                  .not(__.has('stale', 'true'))
                  .property(cardinality.single, 'stale', 'true')
                  .property(cardinality.single, 'stale_at', new Date().toISOString())
                  .toList();
              } catch (staleErr) {
                // Non-fatal: construction proceeds even if stale-marking fails, but
                // log distinctly so a silent regression (e.g. a missing `__` import)
                // surfaces in CloudWatch instead of leaving reviews permanently un-stale.
                console.error(
                  `[stale-review] Failed to mark Review nodes stale for sprint ${input.sprintId}:`,
                  staleErr,
                );
              }
            }

            // Compute run_number for this phase and create an AgentRun node.
            // Only track top-level phase agents (not sub-agents like construction task workers).
            const isTopLevelAgent = !input.taskId;
            if (isTopLevelAgent) {
              const normalizedPhase = (job.agentType || 'inception')
                .toLowerCase()
                .replace('construction-orchestrator', 'construction')
                .replace(/^review.*/, 'review');
              const phaseLabel = normalizedPhase.toUpperCase();

              // Count existing AgentRun nodes for this sprint+phase to determine run_number
              const existingRuns = await g
                .V()
                .has('Sprint', 'id', input.sprintId)
                .out('HAS_AGENT_RUN')
                .has('AgentRun', 'phase', phaseLabel)
                .count()
                .next();
              const runNumber = (existingRuns.value || 0) + 1;
              job.runNumber = runNumber;

              const runId = `run-${input.sprintId}-${phaseLabel.toLowerCase()}-${runNumber}`;
              await g
                .addV('AgentRun')
                .property('id', runId)
                .property('phase', phaseLabel)
                .property('agent_type', job.agentType)
                .property('run_number', runNumber)
                .property('execution_id', executionId)
                .property('status', 'running')
                .property('started_at', new Date().toISOString())
                .property('sprint_id', input.sprintId)
                .property('change_request', input.changeRequest || '')
                .as('run')
                .V()
                .has('Sprint', 'id', input.sprintId)
                .addE('HAS_AGENT_RUN')
                .to('run')
                .next();
            }
          } else {
            // Fallback: Store on Project node for backward compatibility
            await g
              .V()
              .has('Project', 'id', projectId)
              .property(cardinality.single, 'current_execution_arn', taskArn)
              .property(cardinality.single, 'current_execution_id', executionId)
              .property(cardinality.single, 'current_execution_status', 'RUNNING')
              .next();
          }
        });
      } catch (e) {
        console.error('Neptune write failed:', e.message);
      }

      return response(200, { executionArn: taskArn, executionId });
    }

    // GET /projects/{projectId}/agents/tasks - Per-task agent status for construction
    if (httpMethod === 'GET' && path.endsWith('/agents/tasks') && projectId) {
      const sprintId = event.queryStringParameters?.sprintId;
      if (!sprintId) return response(400, { error: 'sprintId query parameter required' });
      return await withNeptune(async (g) => {
        const tasks = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .valueMap(true)
          .toList();
        const taskStatuses = tasks.map((t) => {
          const props = {};
          t.forEach((v, k) => {
            props[k] = Array.isArray(v) ? v[0] : v;
          });
          return {
            taskId: props.id,
            title: props.title,
            status: props.status,
            executionId: props.task_execution_id || null,
            executionArn: props.task_execution_arn || null,
            executionStatus: props.task_execution_status || null,
          };
        });
        return response(200, { tasks: taskStatuses });
      });
    }

    // GET /projects/{projectId}/agents
    if (httpMethod === 'GET' && path.endsWith('/agents') && projectId && !reqId && !storyId) {
      const sprintId = event.queryStringParameters?.sprintId;
      console.log('[GET /agents] projectId:', projectId, 'sprintId:', sprintId);

      // Proactively prune stale workers on every status poll (fire-and-forget)
      cleanupStaleWorkers().catch((e) => console.error('cleanupStaleWorkers error:', e.message));

      return await withNeptune(async (g) => {
        // Use Sprint vertex if sprintId provided, otherwise fallback to Project
        const vertexLabel = sprintId ? 'Sprint' : 'Project';
        const vertexId = sprintId || projectId;
        console.log('[GET /agents] Querying vertex:', vertexLabel, 'id:', vertexId);

        const result = await g.V().has(vertexLabel, 'id', vertexId).valueMap().next();
        const v = result.value;
        if (!v) return response(200, { executionArn: null, executionId: null, status: null });

        const arn = v?.get?.('current_execution_arn')?.[0] || null;
        const execId = v?.get?.('current_execution_id')?.[0] || null;
        const agentStartedAt = v?.get?.('agent_started_at')?.[0] || null;
        // Log only execId; ARN contains account ID and is considered sensitive
        console.log('[GET /agents] execId:', execId, 'hasArn:', !!arn);

        // Helper to write terminal status to Sprint and AgentRun nodes
        const writeTerminalStatus = async (statusStr, execIdForRun) => {
          const completedAt = new Date().toISOString();
          await g
            .V()
            .has(vertexLabel, 'id', vertexId)
            .property(cardinality.single, 'current_agent_status', statusStr)
            .property(cardinality.single, 'agent_completed_at', completedAt)
            .next();
          if (execIdForRun) {
            await g
              .V()
              .hasLabel('AgentRun')
              .has('execution_id', execIdForRun)
              .property(cardinality.single, 'status', statusStr)
              .property(cardinality.single, 'completed_at', completedAt)
              .next()
              .catch(() => {});
          }
        };

        // Check pool first - it's the source of truth for running agents
        // Use GSI queries instead of full table scan
        if (POOL_TABLE) {
          const poolWorkers = [];
          for (const poolStatus of ['busy', 'assigned']) {
            const qr = await ddb.send(
              new QueryCommand({
                TableName: POOL_TABLE,
                IndexName: 'StatusIndex',
                KeyConditionExpression: '#s = :s',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':s': poolStatus },
              }),
            );
            poolWorkers.push(...(qr.Items || []));
          }
          for (const w of poolWorkers) {
            const matchesProject = w.job?.projectId === projectId;
            const matchesSprint = sprintId ? w.job?.sprintId === sprintId : true;
            if (matchesProject && matchesSprint) {
              // Found running agent - sync Neptune
              await g
                .V()
                .has(vertexLabel, 'id', vertexId)
                .property(cardinality.single, 'current_execution_arn', w.taskArn)
                .property(cardinality.single, 'current_execution_id', w.job.executionId)
                .property(cardinality.single, 'current_agent_status', 'running')
                .next();
              return response(200, {
                executionArn: w.taskArn,
                executionId: w.job.executionId,
                status: 'RUNNING',
              });
            }
          }
        }

        // No running agent in pool - check historical status
        if (arn) {
          // Stale timeout: if agent_started_at > 45 min ago and no worker found, mark as failed
          const STALE_AGENT_MS = 45 * 60 * 1000;
          if (agentStartedAt) {
            const elapsed = Date.now() - new Date(agentStartedAt).getTime();
            if (elapsed > STALE_AGENT_MS) {
              console.log(
                `[GET /agents] Agent stale (${Math.round(elapsed / 60000)}m), marking as failed`,
              );
              await writeTerminalStatus('failed', execId);
              return response(200, { executionArn: arn, executionId: execId, status: 'FAILED' });
            }
          }

          // Check agent-outputs for final status
          if (process.env.AGENT_OUTPUTS_TABLE && execId) {
            const outputQuery = await ddb.send(
              new QueryCommand({
                TableName: process.env.AGENT_OUTPUTS_TABLE,
                KeyConditionExpression: 'executionId = :eid',
                ExpressionAttributeValues: { ':eid': execId },
                Limit: 1,
              }),
            );
            const outputItem = outputQuery.Items?.[0];
            if (outputItem) {
              const s = outputItem.status;
              const mapped =
                s === 'completed' ? 'SUCCEEDED' : s === 'failed' ? 'FAILED' : 'RUNNING';
              const statusStr = mapped.toLowerCase();
              if (mapped === 'SUCCEEDED' || mapped === 'FAILED') {
                await writeTerminalStatus(statusStr, execId);
              } else {
                await g
                  .V()
                  .has(vertexLabel, 'id', vertexId)
                  .property(cardinality.single, 'current_agent_status', statusStr)
                  .next();
              }
              return response(200, { executionArn: arn, executionId: execId, status: mapped });
            }
          }
          try {
            const taskStatus = await getTaskStatus(arn);
            const statusStr = taskStatus.status.toLowerCase();
            if (taskStatus.status === 'SUCCEEDED' || taskStatus.status === 'FAILED') {
              await writeTerminalStatus(statusStr, execId);
            } else {
              await g
                .V()
                .has(vertexLabel, 'id', vertexId)
                .property(cardinality.single, 'current_agent_status', statusStr)
                .next();
            }
            return response(200, {
              executionArn: arn,
              executionId: execId,
              status: taskStatus.status,
            });
          } catch {
            await writeTerminalStatus('failed', execId);
            return response(200, { executionArn: arn, executionId: execId, status: 'FAILED' });
          }
        }

        return response(200, { executionArn: null, executionId: null, status: null });
      });
    }

    // GET /agents/{taskId}/questions
    if (httpMethod === 'GET' && taskId && path.endsWith('/questions')) {
      const result = await ddb.send(
        new QueryCommand({
          TableName: process.env.QUESTIONS_TABLE,
          IndexName: 'AgentTaskIdIndex',
          KeyConditionExpression: 'agentTaskId = :taskId',
          ExpressionAttributeValues: { ':taskId': taskId },
        }),
      );
      return response(200, { questions: result.Items });
    }

    // POST /agents/{taskId}/questions/{questionId}/answer
    if (httpMethod === 'POST' && questionId) {
      const { structuredAnswer } = JSON.parse(body);
      const claims = event.requestContext.authorizer.claims;
      const userId = claims.sub;
      const userName = claims['custom:display_name'] || claims.email || '';
      const question = await ddb.send(
        new GetCommand({ TableName: process.env.QUESTIONS_TABLE, Key: { questionId } }),
      );
      if (!question.Item) return response(404, { error: 'Question not found' });
      const structuredAnswerJson =
        typeof structuredAnswer === 'string' ? structuredAnswer : JSON.stringify(structuredAnswer);
      await ddb.send(
        new UpdateCommand({
          TableName: process.env.QUESTIONS_TABLE,
          Key: { questionId },
          UpdateExpression:
            'SET #s = :s, structuredAnswer = :a, answeredBy = :u, answeredByName = :n, answeredAt = :t',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': 'answered',
            ':a': structuredAnswerJson,
            ':u': userId,
            ':n': userName,
            ':t': Date.now(),
          },
        }),
      );
      return response(200, { success: true });
    }

    // GET /agents/{taskId}
    if (httpMethod === 'GET' && taskId && !questionId) {
      // Check agent-outputs table first (pool workers keep ECS task running across jobs)
      // taskId may be an executionId (exec-...) or an ECS task ARN
      if (process.env.AGENT_OUTPUTS_TABLE) {
        // Try taskId directly as executionId
        let outputQuery = await ddb.send(
          new QueryCommand({
            TableName: process.env.AGENT_OUTPUTS_TABLE,
            KeyConditionExpression: 'executionId = :eid',
            ExpressionAttributeValues: { ':eid': taskId },
            Limit: 1,
          }),
        );
        // Also try the executionId query param if provided
        if (!outputQuery.Items?.length && event.queryStringParameters?.executionId) {
          outputQuery = await ddb.send(
            new QueryCommand({
              TableName: process.env.AGENT_OUTPUTS_TABLE,
              KeyConditionExpression: 'executionId = :eid',
              ExpressionAttributeValues: { ':eid': event.queryStringParameters.executionId },
              Limit: 1,
            }),
          );
        }
        const outputItem = outputQuery.Items?.[0];
        if (outputItem) {
          const s = outputItem.status;
          const mapped = s === 'completed' ? 'SUCCEEDED' : s === 'failed' ? 'FAILED' : 'RUNNING';
          return response(200, { status: mapped, executionArn: taskId });
        }
      }
      const taskStatus = await getTaskStatus(taskId);
      return response(200, { status: taskStatus.status, executionArn: taskId });
    }

    // DELETE /agents/{taskId}
    if (httpMethod === 'DELETE' && taskId) {
      // Find the worker with this taskArn and clear its job
      if (POOL_TABLE) {
        const scan = await ddb.send(new ScanCommand({ TableName: POOL_TABLE }));
        for (const w of scan.Items || []) {
          if (w.taskArn === taskId && w.job) {
            await ddb
              .send(
                new UpdateCommand({
                  TableName: POOL_TABLE,
                  Key: { workerId: w.workerId },
                  UpdateExpression: 'SET #s = :s, job = :j',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': 'idle', ':j': null },
                }),
              )
              .catch(() => {});
            break;
          }
        }
      }
      // Clear execution state from Neptune (both Project and Sprint vertices)
      await withNeptune(async (g) => {
        // Clear Project vertex (backward compatibility)
        await g
          .V()
          .has('Project', 'current_execution_arn', taskId)
          .properties('current_execution_arn', 'current_execution_id', 'current_execution_status')
          .drop()
          .next();
        // Clear Sprint vertex — mark as cancelled with timestamp
        const completedAt = new Date().toISOString();
        const sprintVertices = await g.V().has('Sprint', 'current_execution_arn', taskId).toList();
        for (const sv of sprintVertices) {
          // Update AgentRun nodes BEFORE dropping execution properties
          const runs = await g
            .V(sv)
            .out('HAS_AGENT_RUN')
            .has('AgentRun', 'status', 'running')
            .toList();
          for (const run of runs) {
            await g
              .V(run)
              .property(cardinality.single, 'status', 'cancelled')
              .property(cardinality.single, 'completed_at', completedAt)
              .next();
          }
          // Set cancelled status and clear execution pointers
          await g
            .V(sv)
            .property(cardinality.single, 'current_agent_status', 'cancelled')
            .property(cardinality.single, 'agent_completed_at', completedAt)
            .next();
          await g.V(sv).properties('current_execution_arn', 'current_execution_id').drop().next();
        }
      }).catch((e) => console.error('Neptune cleanup on cancel failed:', e.message));
      return response(200, { cancelled: true });
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
