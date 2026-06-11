const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { DynamoDBClient, QueryCommand: DDBRawQueryCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const fs = require('fs');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const {
  t: { label: T_label },
  P,
  order: Order,
  cardinality,
} = gremlin.process;
const __ = gremlin.process.statics;

const LOG_FILE = '/tmp/mcp-graph.log';
const POLL_INTERVAL_MS = 3000;
const _origErr = console.error.bind(console);
console.error = (...args) => {
  _origErr(...args);
  try {
    fs.appendFileSync(LOG_FILE, args.join(' ') + '\n');
  } catch {}
};

const env = {
  neptuneEndpoint: process.env.NEPTUNE_ENDPOINT,
  projectId: process.env.PROJECT_ID,
  sprintId: process.env.SPRINT_ID,
  questionsTable: process.env.QUESTIONS_TABLE,
  connectionsTable: process.env.CONNECTIONS_TABLE,
  websocketEndpoint: process.env.WEBSOCKET_ENDPOINT,
  submitQuestionLambda: process.env.SUBMIT_QUESTION_LAMBDA,
  region: process.env.AWS_REGION || 'us-east-1',
  gitToken: process.env.GIT_TOKEN || '',
  gitRepo: process.env.GIT_REPO || '',
  gitRepos: (() => {
    try {
      return JSON.parse(process.env.GIT_REPOS || '[]');
    } catch {
      return [];
    }
  })(),
};

// Parse a GitHub repository identifier in "owner/repo" form into its parts.
// Multiple call sites .split('/') and destructure [owner, repo] before building
// api.github.com URLs; a malformed value (empty, no slash, extra segments) would
// otherwise produce an undefined owner/repo and a silently-wrong request. Throw a
// clear error instead so the failure is attributable.
function parseOwnerRepo(s) {
  if (typeof s !== 'string') {
    throw new Error(`Invalid repository identifier: expected "owner/repo", got ${typeof s}`);
  }
  const parts = s.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository identifier "${s}": expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

// --- Neptune helpers (persistent connection with auto-reconnect) ---
let _conn = null;
let _g = null;

async function getConnection() {
  const creds = await fromNodeProviderChain()();
  creds.region = env.region;
  const info = getUrlAndHeaders(env.neptuneEndpoint, '8182', creds, '/gremlin', 'wss');
  return new DriverRemoteConnection(info.url, { headers: info.headers });
}

async function ensureConnection() {
  if (_conn && _g) {
    // Verify the connection is still alive with a lightweight query
    try {
      await _g.V().limit(0).toList();
      return _g;
    } catch (e) {
      console.error('[neptune] Connection stale, reconnecting:', e.message);
      try {
        await _conn.close();
      } catch {}
      _conn = null;
      _g = null;
    }
  }
  _conn = await getConnection();
  _g = traversal().withRemote(_conn);
  console.error('[neptune] New persistent connection established');
  return _g;
}

async function withGraph(fn) {
  try {
    const g = await ensureConnection();
    return await fn(g);
  } catch (e) {
    // On connection-level errors, reset and retry once
    if (
      e.message &&
      (e.message.includes('WebSocket') ||
        e.message.includes('Connection') ||
        e.message.includes('ECONNRESET'))
    ) {
      console.error('[neptune] Connection error, retrying:', e.message);
      try {
        if (_conn) await _conn.close();
      } catch {}
      _conn = null;
      _g = null;
      const g = await ensureConnection();
      return await fn(g);
    }
    throw e;
  }
}

function propsToObj(props) {
  const o = {};
  if (props) {
    // First pass: collect user-defined string-keyed properties
    props.forEach((v, k) => {
      if (typeof k === 'string') {
        o[k] = Array.isArray(v) ? v[0] : v;
      }
    });
    // Second pass: only add T.id/T.label if no user property with the same name exists
    props.forEach((v, k) => {
      if (typeof k === 'object' && k.typeName === 'T') {
        const name = k.elementName; // 'id' or 'label'
        if (!(name in o)) {
          o[name] = Array.isArray(v) ? v[0] : v;
        }
      }
    });
  }
  return o;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

const VALID_LABELS = [
  'Project',
  'Sprint',
  'Requirement',
  'UserStory',
  'Task',
  'CodeFile',
  'Review',
  'Question',
  'GeneralInfo',
  'PullRequest',
  'PRGroup',
  'AgentRun',
];
const VALID_EDGES = [
  'HAS_SPRINT',
  'CONTAINS',
  'HAS_REVIEW',
  'HAS_PR',
  'HAS_PR_GROUP',
  'GROUPS',
  'BREAKS_INTO',
  'IMPLEMENTED_BY',
  'REVIEWS',
  'VALIDATES',
  'INFLUENCES',
  'CARRIED_FROM',
  'DEPENDS_ON',
  'RELATES_TO',
  'HAS_AGENT_RUN',
];

// --- MCP Server ---

const server = new McpServer({ name: 'graph-mcp-server', version: '1.0.0' });

// ─── RESOURCE: data model ───

const DATA_MODEL = `# Graph Data Model

## Node Types
- Project: id, name, description, created_at
- Sprint: id, name, description, phase (INCEPTION|CONSTRUCTION|REVIEW|COMPLETED), created_at, branch, base_branch
- Requirement: id, title, description, acceptance_criteria, sprint_id
- UserStory: id, title, description, story_points, sprint_id
- Task: id, title, description, status, sprint_id
- CodeFile: id, file_path, repository (owner/repo), commit_ref, summary, sprint_id
- Review: id, status (PENDING|PASSED|FAILED|PARTIAL), comments, blind_review, blind_status (PENDING|PASSED|FAILED|PARTIAL), blind_risk_score, blind_risk_reasoning, full_review, full_status (PENDING|PASSED|FAILED|PARTIAL), full_risk_score, full_risk_reasoning, sprint_id, stale (true|false), stale_at
- Question: id, agent, questions (JSON array of structured questions), structured_answer (JSON), sprint_id, created_at
- GeneralInfo: id, type, title, content, sprint_id, created_at
- PullRequest: id, pr_url, pr_number, branch, base_branch, repository (owner/repo), sprint_id, created_at, stale (true|false), stale_at, pr_state (open|closed|merged)
- PRGroup: id, title, sprint_id, created_at — groups related PRs across multiple repos into a single logical unit
- AgentRun: id, phase (INCEPTION|CONSTRUCTION|REVIEW), agent_type, run_number, prompt, execution_id, status (running|completed|failed), started_at, completed_at, sprint_id

## Edge Types
- Project --HAS_SPRINT--> Sprint (1..*)
- Sprint --CONTAINS--> Requirement|UserStory|Task|CodeFile|Question|GeneralInfo (0..*)
- Sprint --HAS_REVIEW--> Review (1..* — one per run; stale=true means superseded)
- Sprint --HAS_PR--> PullRequest (0..* — one active per repo per run; stale=true means superseded/merged)
- Sprint --HAS_PR_GROUP--> PRGroup (0..* — one per construction run in multi-repo projects)
- PRGroup --GROUPS--> PullRequest (1..* — links a group to its individual per-repo PRs)
- Sprint --HAS_AGENT_RUN--> AgentRun (0..*)
- Requirement --BREAKS_INTO--> UserStory (1..*), Task (0..*)
- UserStory --BREAKS_INTO--> Task (1..*)
- Task --IMPLEMENTED_BY--> CodeFile (1..*)
- UserStory --IMPLEMENTED_BY--> CodeFile (0..*, shortcut)
- Review --REVIEWS--> CodeFile (0..*)
- Review --VALIDATES--> Requirement|UserStory (0..*)
- Question --INFLUENCES--> Requirement|UserStory|Task (0..*)
- Task --DEPENDS_ON--> Task (0..*, task must complete before this one can start)
- Requirement --CARRIED_FROM--> Requirement (0..1, cross-sprint lineage)
- GeneralInfo --CARRIED_FROM--> GeneralInfo (0..1, cross-sprint knowledge carry-forward)
- GeneralInfo --RELATES_TO--> Requirement|UserStory|Task (0..*, general info can relate to any artifact)
`;

server.resource('data-model', 'graph://data-model', { mimeType: 'text/plain' }, async () => ({
  contents: [{ uri: 'graph://data-model', text: DATA_MODEL, mimeType: 'text/plain' }],
}));

// ─── READ ───

server.tool(
  'get_node',
  `Fetch a single node by its label and id property. Returns all properties of the node.
Use this when you know the exact node you need (e.g. a specific Requirement or Task).
Valid labels: ${VALID_LABELS.join(', ')}.`,
  {
    label: z.enum(VALID_LABELS).describe('The vertex label (e.g. "Requirement", "Task")'),
    id: z.string().describe('The id property value of the node'),
  },
  async ({ label, id }) => {
    try {
      return await withGraph(async (g) => {
        const r = await g.V().has(label, 'id', id).valueMap(true).next();
        if (!r.value) return err(`${label} with id "${id}" not found`);
        return ok(propsToObj(r.value));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'list_nodes',
  `List all nodes of a given label within the current sprint. Returns id, title/name, and status for each.
Use this to get an overview of all artifacts of a type (e.g. all Tasks in the sprint).
Valid labels: ${VALID_LABELS.join(', ')}.`,
  {
    label: z.enum(VALID_LABELS).describe('The vertex label to list'),
  },
  async ({ label }) => {
    try {
      return await withGraph(async (g) => {
        let q;
        if (label === 'Sprint') {
          q = g.V().has('Project', 'id', env.projectId).out('HAS_SPRINT');
        } else if (label === 'Project') {
          q = g.V().has('Project', 'id', env.projectId);
        } else if (label === 'Review') {
          q = g.V().has('Sprint', 'id', env.sprintId).out('HAS_REVIEW');
        } else if (label === 'PullRequest') {
          q = g.V().has('Sprint', 'id', env.sprintId).out('HAS_PR');
        } else if (label === 'PRGroup') {
          q = g.V().has('Sprint', 'id', env.sprintId).out('HAS_PR_GROUP');
        } else {
          q = g.V().has('Sprint', 'id', env.sprintId).out('CONTAINS').hasLabel(label);
        }
        const list = await q.valueMap(true).toList();
        return ok(list.map(propsToObj));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

// ─── TRAVERSE ───

server.tool(
  'get_neighbors',
  `Get all nodes directly connected to a given node, optionally filtered by edge direction and label.
Use this to traverse the graph — e.g. find all Tasks that a Requirement BREAKS_INTO,
or all CodeFiles that IMPLEMENTED_BY a Task.
Valid edge labels: ${VALID_EDGES.join(', ')}.`,
  {
    label: z.enum(VALID_LABELS).describe('Label of the starting node'),
    id: z.string().describe('The id property of the starting node'),
    direction: z
      .enum(['out', 'in', 'both'])
      .default('out')
      .describe('Edge direction: out (default), in, or both'),
    edgeLabel: z
      .string()
      .optional()
      .describe('Optional: filter to a specific edge label (e.g. "BREAKS_INTO")'),
  },
  async ({ label, id, direction, edgeLabel }) => {
    try {
      return await withGraph(async (g) => {
        let q = g.V().has(label, 'id', id);
        const step = direction === 'in' ? 'in_' : direction === 'both' ? 'both' : 'out';
        q = edgeLabel ? q[step](edgeLabel) : q[step]();
        const list = await q.valueMap(true).toList();
        return ok(list.map(propsToObj));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'get_sprint_graph',
  `Get the full subgraph for the current sprint: all contained nodes and the edges between them.
Returns { nodes: [...], edges: [...] }. Use this to understand the complete structure and
dependency chain of the sprint at a glance.`,
  {},
  async () => {
    try {
      return await withGraph(async (g) => {
        const vertices = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .union(__.out('CONTAINS'), __.out('HAS_REVIEW'), __.out('HAS_PR'), __.out('HAS_PR_GROUP'))
          .project('id', 'label', 'props')
          .by('id')
          .by(T_label)
          .by(__.valueMap())
          .toList();

        const nodeIds = vertices.map((v) => v.get('id'));
        if (!nodeIds.length) return ok({ nodes: [], edges: [] });

        const edges = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .union(__.out('CONTAINS'), __.out('HAS_REVIEW'), __.out('HAS_PR'), __.out('HAS_PR_GROUP'))
          .bothE()
          .where(__.otherV().has('id', P.within(...nodeIds)))
          .project('source', 'target', 'label')
          .by(__.outV().values('id'))
          .by(__.inV().values('id'))
          .by(T_label)
          .dedup()
          .toList();

        const nodes = vertices.map((v) => ({
          id: v.get('id'),
          label: v.get('label'),
          ...propsToObj(v.get('props')),
        }));
        const edgeList = edges
          .filter(
            (e) => !['CONTAINS', 'HAS_REVIEW', 'HAS_PR', 'HAS_PR_GROUP'].includes(e.get('label')),
          )
          .map((e) => ({
            source: e.get('source'),
            target: e.get('target'),
            label: e.get('label'),
          }));

        return ok({ nodes, edges: edgeList });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

// ─── LOOKUP ───

server.tool(
  'find_nodes',
  `Search for nodes by matching a property value (exact or substring).
Use this when you need to find nodes by title, status, file_path, or any other property.`,
  {
    label: z.enum(VALID_LABELS).describe('Label to search within'),
    property: z.string().describe('Property name to match (e.g. "title", "status", "file_path")'),
    value: z.string().describe('Value to search for (exact match)'),
  },
  async ({ label, property, value }) => {
    try {
      return await withGraph(async (g) => {
        const list = await g.V().hasLabel(label).has(property, value).valueMap(true).toList();
        return ok(list.map(propsToObj));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'get_dependency_chain',
  `Trace the full dependency chain from a Requirement down to CodeFiles.
Returns the tree: Requirement → UserStories → Tasks → CodeFiles.
Use this to understand the full implementation lineage of a requirement.`,
  {
    requirementId: z.string().describe('The id of the Requirement node'),
  },
  async ({ requirementId }) => {
    try {
      return await withGraph(async (g) => {
        const req = await g.V().has('Requirement', 'id', requirementId).valueMap(true).next();
        if (!req.value) return err(`Requirement "${requirementId}" not found`);

        const stories = await g
          .V()
          .has('Requirement', 'id', requirementId)
          .out('BREAKS_INTO')
          .hasLabel('UserStory')
          .valueMap(true)
          .toList();

        const chain = { requirement: propsToObj(req.value), stories: [] };
        for (const s of stories) {
          const storyObj = propsToObj(s);
          const tasks = await g
            .V()
            .has('UserStory', 'id', storyObj.id)
            .out('BREAKS_INTO')
            .hasLabel('Task')
            .valueMap(true)
            .toList();
          const taskList = [];
          for (const t of tasks) {
            const taskObj = propsToObj(t);
            const files = await g
              .V()
              .has('Task', 'id', taskObj.id)
              .out('IMPLEMENTED_BY')
              .hasLabel('CodeFile')
              .valueMap(true)
              .toList();
            taskList.push({ ...taskObj, codeFiles: files.map(propsToObj) });
          }
          chain.stories.push({ ...storyObj, tasks: taskList });
        }
        return ok(chain);
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

// ─── UPDATE ───

server.tool(
  'update_node',
  `Update one or more properties on an existing node. Cannot change the node's label or id.
Use this to update status, description, title, or any mutable property.`,
  {
    label: z.enum(VALID_LABELS).describe('Label of the node to update'),
    id: z.string().describe('The id property of the node'),
    properties: z
      .record(z.string(), z.string())
      .describe(
        'Key-value pairs of properties to set (e.g. {"status": "done", "title": "Updated title"})',
      ),
  },
  async ({ label, id, properties }) => {
    try {
      if (properties.id || properties.label) return err('Cannot change id or label');

      // Whitelist guard: a Review's machine verdict drives downstream styling and
      // gating, so reject any value outside the known set rather than letting an
      // agent write a free-form status the frontend/validation can't interpret.
      // Canonical list: lambda/shared/review-statuses.js (used by reviews lambda).
      // Inlined here because the ECS container build doesn't include lambda/shared — update both.
      if (label === 'Review' && properties.status !== undefined) {
        const VALID_REVIEW_STATUSES = ['PENDING', 'PASSED', 'FAILED', 'PARTIAL'];
        if (!VALID_REVIEW_STATUSES.includes(properties.status)) {
          return err(
            `Invalid Review status "${properties.status}". Must be one of: ${VALID_REVIEW_STATUSES.join(', ')}`,
          );
        }
      }

      return await withGraph(async (g) => {
        const exists = await g.V().has(label, 'id', id).hasNext();
        if (!exists) return err(`${label} with id "${id}" not found`);

        // Auto-clear task_execution_status when a Task reaches a terminal status.
        // This prevents done/failed tasks from appearing as "RUNNING" and blocking
        // get_unblocked_tasks from finding dependent tasks.
        if (label === 'Task' && properties.status && !properties.task_execution_status) {
          const terminalMap = { done: 'COMPLETED', failed: 'FAILED' };
          if (terminalMap[properties.status]) {
            properties.task_execution_status = terminalMap[properties.status];
          }
        }

        let q = g.V().has(label, 'id', id);
        for (const [k, v] of Object.entries(properties)) {
          q = q.property(cardinality.single, k, v);
        }
        await q.next();
        const updated = await g.V().has(label, 'id', id).valueMap(true).next();

        // Broadcast artifact.updated so the frontend Kanban board refreshes immediately
        // (e.g. when a Task moves to in_progress, done, or failed).
        broadcastEvent('artifact.updated', {
          sprintId: env.sprintId,
          artifactType: label,
          artifactId: id,
        }).catch(() => {});

        return ok(propsToObj(updated.value));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'add_node',
  `Create a new node in the graph and link it to the current sprint via a CONTAINS edge (or HAS_REVIEW for Review nodes).
The node is automatically scoped to the current project and sprint.
Valid labels: ${VALID_LABELS.filter((l) => !['Project', 'Sprint', 'Question'].includes(l)).join(', ')}.
Optionally pass \`edges\` to link the new node to existing nodes in the same call (e.g. link a UserStory FROM its parent Requirement via BREAKS_INTO).
To ask questions, use the \`ask_question\` tool instead — do NOT create Question nodes directly.`,
  {
    label: z
      .enum(VALID_LABELS.filter((l) => !['Project', 'Sprint', 'Question'].includes(l)))
      .describe('Label for the new node'),
    id: z.string().describe('Unique id for the node'),
    properties: z
      .record(z.string(), z.string())
      .describe('Properties to set on the node (e.g. {"title": "...", "description": "..."})'),
    edges: z
      .array(
        z.object({
          direction: z.enum(['from', 'to']),
          label: z.enum(VALID_LABELS),
          id: z.string(),
          edgeLabel: z.enum(VALID_EDGES),
        }),
      )
      .optional()
      .describe(
        'Optional edges to create. "from" = existing node -> new node. "to" = new node -> existing node.',
      ),
  },
  async ({ label, id, properties, edges: edgeDefs }) => {
    try {
      return await withGraph(async (g) => {
        let q = g
          .addV(label)
          .property(cardinality.single, 'id', id)
          .property(cardinality.single, 'sprint_id', env.sprintId);
        for (const [k, v] of Object.entries(properties)) q = q.property(cardinality.single, k, v);
        q = q.property(cardinality.single, 'createdAt', new Date().toISOString());
        await q.next();

        const sprintEdgeLabel =
          label === 'Review'
            ? 'HAS_REVIEW'
            : label === 'PullRequest'
              ? 'HAS_PR'
              : label === 'PRGroup'
                ? 'HAS_PR_GROUP'
                : 'CONTAINS';
        await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .addE(sprintEdgeLabel)
          .to(__.V().has(label, 'id', id))
          .next();

        // Create optional edges to/from existing nodes
        if (edgeDefs && edgeDefs.length > 0) {
          for (const edge of edgeDefs) {
            const otherExists = await g.V().has(edge.label, 'id', edge.id).hasNext();
            if (!otherExists) {
              const allIds = await g
                .V()
                .hasLabel(edge.label)
                .has('sprint_id', env.sprintId)
                .values('id')
                .toList();
              console.error(
                `[add_node] Edge target ${edge.label} "${edge.id}" not found. Available: ${JSON.stringify(allIds)}`,
              );
              return err(
                `Edge target ${edge.label} "${edge.id}" not found. Available ids: ${JSON.stringify(allIds)}`,
              );
            }
            if (edge.direction === 'from') {
              // existing node -> new node
              await g
                .V()
                .has(edge.label, 'id', edge.id)
                .addE(edge.edgeLabel)
                .to(__.V().has(label, 'id', id))
                .next();
            } else {
              // new node -> existing node
              await g
                .V()
                .has(label, 'id', id)
                .addE(edge.edgeLabel)
                .to(__.V().has(edge.label, 'id', edge.id))
                .next();
            }
          }
        }

        const created = await g.V().has(label, 'id', id).valueMap(true).next();
        return ok(propsToObj(created.value));
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'add_edge',
  `Create a directed edge between two existing nodes.
Use this to establish relationships like BREAKS_INTO, IMPLEMENTED_BY, VALIDATES, etc.
Valid edge labels: ${VALID_EDGES.join(', ')}.`,
  {
    fromLabel: z.enum(VALID_LABELS).describe('Label of the source node'),
    fromId: z.string().describe('id of the source node'),
    edgeLabel: z.enum(VALID_EDGES).describe('The relationship type'),
    toLabel: z.enum(VALID_LABELS).describe('Label of the target node'),
    toId: z.string().describe('id of the target node'),
  },
  async ({ fromLabel, fromId, edgeLabel, toLabel, toId }) => {
    try {
      return await withGraph(async (g) => {
        const fromExists = await g.V().has(fromLabel, 'id', fromId).hasNext();
        if (!fromExists) {
          const allIds = await g
            .V()
            .hasLabel(fromLabel)
            .has('sprint_id', env.sprintId)
            .values('id')
            .toList();
          console.error(
            `[add_edge] Source ${fromLabel} "${fromId}" not found. Available: ${JSON.stringify(allIds)}`,
          );
          return err(
            `Source ${fromLabel} "${fromId}" not found. Available ids: ${JSON.stringify(allIds)}`,
          );
        }

        const toExists = await g.V().has(toLabel, 'id', toId).hasNext();
        if (!toExists) {
          const allIds = await g
            .V()
            .hasLabel(toLabel)
            .has('sprint_id', env.sprintId)
            .values('id')
            .toList();
          console.error(
            `[add_edge] Target ${toLabel} "${toId}" not found. Available: ${JSON.stringify(allIds)}`,
          );
          return err(
            `Target ${toLabel} "${toId}" not found. Available ids: ${JSON.stringify(allIds)}`,
          );
        }

        await g
          .V()
          .has(fromLabel, 'id', fromId)
          .addE(edgeLabel)
          .to(__.V().has(toLabel, 'id', toId))
          .next();

        return ok({ created: true, from: fromId, edge: edgeLabel, to: toId });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

// ─── COLLABORATION ───

async function broadcastEvent(type, data) {
  try {
    const ddbRaw = new DynamoDBClient({});
    const conns = await ddbRaw.send(
      new DDBRawQueryCommand({
        TableName: env.connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: env.projectId } },
      }),
    );
    const wsClient = new ApiGatewayManagementApiClient({ endpoint: env.websocketEndpoint });
    const payload = JSON.stringify({ type, ...data });
    // Never target connections whose scope token has expired (plan §4a).
    // Inline copy of shared/realtime-token.js#isTokenLive — the agents-ecs
    // Docker build context cannot reach lambda/shared. Rows without tokenExp
    // are pre-enforcement legacy rows (TTL ≤1h) — allow.
    const nowMs = Date.now();
    const liveItems = (conns.Items || []).filter((item) => {
      const raw = item.tokenExp?.N;
      const exp = Number(raw);
      return !raw || !Number.isFinite(exp) || exp * 1000 > nowMs;
    });
    await Promise.all(
      liveItems.map((item) =>
        wsClient
          .send(
            new PostToConnectionCommand({
              ConnectionId: item.connectionId.S,
              Data: payload,
            }),
          )
          .catch(() => {}),
      ),
    );
  } catch (e) {
    console.error('Broadcast failed:', e.message);
  }
}

server.tool(
  'ask_question',
  `Ask one or more structured questions to the collaborating users. Blocks indefinitely until answered.
Use this whenever you need human input — ambiguous requirements, design decisions, priority calls, etc.
Each question has predefined options the user can select from. Users can always provide free-text answers instead.`,
  {
    questions: z
      .array(
        z.object({
          text: z.string().describe('The question text (markdown OK)'),
          type: z
            .enum(['single', 'multi'])
            .describe('single = pick one option, multi = pick many options'),
          options: z
            .array(
              z.object({
                label: z.string().describe('Short option label'),
                description: z.string().optional().describe('Longer explanation of the option'),
              }),
            )
            .describe('Predefined answer options. Users can always provide free text instead.'),
        }),
      )
      .describe('One or more questions to ask the team'),
  },
  async ({ questions }) => {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const questionsJson = JSON.stringify(questions);
    try {
      // Create question in DynamoDB (for polling) and broadcast via WebSocket
      await lambda.send(
        new InvokeCommand({
          FunctionName: env.submitQuestionLambda,
          Payload: Buffer.from(
            JSON.stringify({
              body: JSON.stringify({
                questionId,
                agentTaskId: process.env.EXECUTION_ID,
                projectId: env.projectId,
                sprintId: env.sprintId,
                questions: questionsJson,
              }),
            }),
          ),
        }),
      );

      // Also create a Question node in Neptune so the Sprint page can display it
      try {
        await withGraph(async (g) => {
          const __ = gremlin.process.statics;
          await g
            .addV('Question')
            .property(cardinality.single, 'id', questionId)
            .property(cardinality.single, 'agent', env.projectId ? 'inception' : 'agent')
            .property(cardinality.single, 'questions', questionsJson)
            .property(cardinality.single, 'structured_answer', '')
            .property(cardinality.single, 'sprint_id', env.sprintId)
            .property(cardinality.single, 'created_at', new Date().toISOString())
            .next();
          await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .addE('CONTAINS')
            .to(__.V().has('Question', 'id', questionId))
            .next();
        });
      } catch (e) {
        console.error('Failed to create Neptune Question node:', e.message);
      }

      // Poll indefinitely - user can answer at any time
      while (true) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const result = await ddb.send(
          new GetCommand({ TableName: env.questionsTable, Key: { questionId } }),
        );
        if (result.Item?.status === 'answered') {
          // Format structured answer as readable text for the agent
          const answerText = formatStructuredAnswer(questions, result.Item.structuredAnswer);
          return { content: [{ type: 'text', text: answerText }] };
        }
      }
    } catch (e) {
      return err(`Error asking question: ${e.message}`);
    }
  },
);

/**
 * Format a structured answer into human-readable text for the agent.
 * @param {Array} questions - The original structured questions array.
 * @param {string} structuredAnswerJson - JSON string of the StructuredAnswer object.
 * @returns {string} Formatted answer text.
 */
function formatStructuredAnswer(questions, structuredAnswerJson) {
  try {
    const parsed =
      typeof structuredAnswerJson === 'string'
        ? JSON.parse(structuredAnswerJson)
        : structuredAnswerJson;
    const answers = parsed.answers || [];
    return questions
      .map((q, i) => {
        const a = answers[i];
        if (!a) return `Q${i + 1}: ${q.text}\n→ (no answer)`;
        const parts = [];
        if (a.selectedOptions && a.selectedOptions.length > 0) {
          const labels = a.selectedOptions.map((idx) => q.options[idx]?.label || `Option ${idx}`);
          parts.push(labels.join(', '));
        }
        if (a.freeText) {
          parts.push(`[Custom] ${a.freeText}`);
        }
        return `Q${i + 1}: ${q.text}\n→ ${parts.join(' | ') || '(no answer)'}`;
      })
      .join('\n\n');
  } catch {
    return String(structuredAnswerJson);
  }
}

// ─── ORCHESTRATION TOOLS ───

server.tool(
  'get_unblocked_tasks',
  `Find all tasks that are ready for implementation: status is "todo", task_execution_status is NOT "RUNNING",
and all DEPENDS_ON targets have status "done" (or no dependencies at all).
Tasks with task_execution_status="RUNNING" are excluded because they already have an agent dispatched.
Use this to determine which tasks can be launched in parallel.`,
  {},
  async () => {
    try {
      return await withGraph(async (g) => {
        // Get all tasks in the sprint
        const tasks = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .valueMap(true)
          .toList();

        // Get all DEPENDS_ON edges between tasks in this sprint
        const deps = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .as('t')
          .out('DEPENDS_ON')
          .hasLabel('Task')
          .as('d')
          .select('t', 'd')
          .by('id')
          .toList();

        const taskMap = {};
        for (const t of tasks) {
          const obj = propsToObj(t);
          taskMap[obj.id] = obj;
        }

        const depMap = {};
        for (const d of deps) {
          const from = d.get('t');
          const to = d.get('d');
          if (!depMap[from]) depMap[from] = [];
          depMap[from].push(to);
        }

        const unblocked = Object.values(taskMap).filter((t) => {
          if (t.status !== 'todo') return false;
          // Skip tasks that already have an agent dispatched (RUNNING) to avoid double-dispatch.
          // Tasks with COMPLETED/FAILED/orphaned_reset/reset execution status are fine to re-dispatch.
          if (t.task_execution_status === 'RUNNING') return false;
          const dependencies = depMap[t.id] || [];
          return dependencies.every((depId) => taskMap[depId]?.status === 'done');
        });

        return ok({ unblocked, total: tasks.length, depMap });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'recover_stuck_tasks',
  `Detect and recover tasks stuck with no running agent.
Checks three categories:
1. Tasks with status="in_progress" — agent started work but may have crashed
2. Tasks with status="todo" but task_execution_status="RUNNING" — agent was dispatched but crashed before starting
3. Tasks with status="done" but task_execution_status="RUNNING" — agent completed but didn't clear execution status
For categories 1 and 2, checks the worker pool (DynamoDB) to see if a worker is actively running the task.
If no worker is found OR the task has been RUNNING for more than 20 minutes, resets the task to
status="todo" and task_execution_status="orphaned_reset" so the orchestrator can re-dispatch it.
For category 3, cleans up stale execution status on completed tasks.
Call this before get_unblocked_tasks to self-heal from agent crashes, push failures, or missed re-triggers.`,
  {},
  async () => {
    const poolTable = process.env.POOL_TABLE;
    if (!poolTable) return err('POOL_TABLE not configured — cannot check worker pool');
    try {
      return await withGraph(async (g) => {
        const STUCK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes — if a task has been RUNNING this long with no progress, force-recover

        // 1. Find all tasks that might be stuck:
        //    a) status=in_progress (agent started work but may have crashed)
        //    b) status=todo but task_execution_status=RUNNING (agent was dispatched but crashed before starting)
        const inProgress = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .has('status', 'in_progress')
          .valueMap(true)
          .toList();

        const dispatchedButTodo = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .has('status', 'todo')
          .has('task_execution_status', 'RUNNING')
          .valueMap(true)
          .toList();

        const candidateTasks = [...inProgress, ...dispatchedButTodo].map(propsToObj);

        // 1c. Clean up done tasks that still have task_execution_status="RUNNING"
        //     (agent set status="done" but didn't clear execution status)
        const doneButRunning = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .has('status', 'done')
          .has('task_execution_status', 'RUNNING')
          .valueMap(true)
          .toList();
        const cleanedUp = [];
        for (const raw of doneButRunning) {
          const task = propsToObj(raw);
          await g
            .V()
            .has('Task', 'id', task.id)
            .property(cardinality.single, 'task_execution_status', 'COMPLETED')
            .next();
          cleanedUp.push(task.id);
          console.error(
            `[recover_stuck_tasks] Cleaned up done task ${task.id} — set task_execution_status from RUNNING to COMPLETED`,
          );
        }

        if (!candidateTasks.length)
          return ok({
            recovered: [],
            cleanedUpDoneTasks: cleanedUp,
            message: cleanedUp.length
              ? `No stuck tasks found. Cleaned up ${cleanedUp.length} done task(s) with stale RUNNING execution status.`
              : 'No stuck tasks found',
          });

        // 2. Get all busy/assigned workers from the pool
        const poolScan = await ddb.send(new ScanCommand({ TableName: poolTable }));
        const activeWorkers = (poolScan.Items || []).filter(
          (w) => w.status === 'busy' || w.status === 'assigned',
        );
        // Map taskId -> worker for detailed checks
        const activeWorkerByTaskId = {};
        for (const w of activeWorkers) {
          if (w.job?.taskId) activeWorkerByTaskId[w.job.taskId] = w;
        }

        // 3. Reset orphaned tasks (no running worker OR stuck too long)
        const recovered = [];
        const stillRunning = [];
        const now = Date.now();
        for (const task of candidateTasks) {
          const worker = activeWorkerByTaskId[task.id];
          let shouldRecover = false;
          let reason = '';

          if (!worker) {
            // No worker found for this task — it's orphaned
            shouldRecover = true;
            reason = 'no active worker found';
          } else {
            // Worker exists — check if it's been running too long (likely hung)
            // Prefer task_dispatched_at ISO timestamp, fall back to parsing exec ID
            let dispatchedAt = task.task_dispatched_at
              ? new Date(task.task_dispatched_at).getTime()
              : 0;
            if (!dispatchedAt) {
              const execId = task.task_execution_id || '';
              dispatchedAt = parseInt(execId.split('-')[1], 10) || 0;
            }
            const elapsed = dispatchedAt ? now - dispatchedAt : Infinity;
            if (elapsed > STUCK_TIMEOUT_MS) {
              shouldRecover = true;
              reason = `worker stuck for ${Math.round(elapsed / 60000)}m (threshold: ${STUCK_TIMEOUT_MS / 60000}m)`;
            }
          }

          if (shouldRecover) {
            await g
              .V()
              .has('Task', 'id', task.id)
              .property(cardinality.single, 'status', 'todo')
              .property(cardinality.single, 'task_execution_status', 'orphaned_reset')
              .next();
            recovered.push({
              id: task.id,
              title: task.title,
              previousStatus: task.status,
              newStatus: 'todo',
              reason,
            });
            console.error(
              `[recover_stuck_tasks] Reset orphaned task ${task.id} ("${task.title}") from ${task.status} (exec_status=${task.task_execution_status}) -> todo (reason: ${reason})`,
            );
          } else {
            stillRunning.push(task.id);
          }
        }

        return ok({
          recovered,
          cleanedUpDoneTasks: cleanedUp,
          stillRunning,
          message: recovered.length
            ? `Recovered ${recovered.length} stuck task(s). They will appear in get_unblocked_tasks.`
            : 'All candidate tasks have running agents — no recovery needed.',
        });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'launch_construction_agent',
  `Launch a construction sub-agent for a specific task. Assigns the task to an idle pool worker.
The sub-agent will work on a per-task branch. Only use this from the construction orchestrator.
Respects the 50% pool cap — will not use more than half of available idle workers.`,
  {
    taskId: z.string().describe('The task id to assign to the sub-agent'),
    branch: z
      .string()
      .describe('The sprint branch name (sub-agent will work on {branch}--task-{taskId})'),
    baseBranch: z
      .string()
      .default('main')
      .describe('The base branch to create the task branch from'),
  },
  async ({ taskId, branch, baseBranch }) => {
    const agentsLambda = process.env.AGENTS_LAMBDA_NAME;
    if (!agentsLambda) return err('AGENTS_LAMBDA_NAME not configured');
    try {
      // Use "--task-" separator instead of "/task-" to avoid git ref conflicts.
      // Git cannot have refs/heads/foo AND refs/heads/foo/bar simultaneously.
      const cleanId = taskId.replace(/^task-/, '');
      const taskBranch = `${branch}--task-${cleanId}`;
      const payload = {
        httpMethod: 'POST',
        path: `/projects/${env.projectId}/agents`,
        pathParameters: { projectId: env.projectId },
        body: JSON.stringify({
          phase: 'construction',
          sprintId: env.sprintId,
          taskId,
          branch: taskBranch,
          baseBranch,
          gitToken: env.gitToken,
        }),
        requestContext: { authorizer: { claims: { sub: 'orchestrator' } } },
      };
      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: agentsLambda,
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
      const resp = JSON.parse(Buffer.from(result.Payload).toString());
      const body = JSON.parse(resp.body || '{}');
      if (resp.statusCode >= 400)
        return err(`Failed to launch agent: ${body.error || body.message}`);
      return ok({
        taskId,
        branch: taskBranch,
        executionId: body.executionId,
        executionArn: body.executionArn,
      });
    } catch (e) {
      return err(`Failed to launch construction agent: ${e.message}`);
    }
  },
);

server.tool(
  'trigger_pr_creation',
  `Trigger PR creation after all construction tasks are complete. Invokes the create-pr Lambda.
Only call this when all tasks have status "done" and branches have been merged.
In multi-repo projects, creates one PR per repository and groups them in a PRGroup vertex.`,
  {
    branch: z.string().describe('The sprint branch to create a PR from'),
    baseBranch: z.string().default('main').describe('The target branch for the PR'),
    title: z.string().optional().describe('PR title'),
  },
  async ({ branch, baseBranch, title }) => {
    const createPrLambda = process.env.CREATE_PR_LAMBDA_NAME;
    if (!createPrLambda) return err('CREATE_PR_LAMBDA_NAME not configured');
    if (!env.gitToken)
      return err('GIT_TOKEN not available — cannot create PR without authentication');
    if (!env.gitRepo && env.gitRepos.length === 0)
      return err('GIT_REPO not available — cannot create PR without repository info');

    // --- Multi-repo path: create one PR per repo, group them ---
    if (env.gitRepos.length > 1) {
      try {
        // Check for existing open PRGroup for this sprint to prevent duplicates on re-runs
        const existingGroup = await withGraph(async (g) => {
          const groups = await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .out('HAS_PR_GROUP')
            .hasLabel('PRGroup')
            .not(__.has('stale', 'true'))
            .order()
            .by('created_at', Order.desc)
            .valueMap(true)
            .toList();
          if (groups.length === 0) return null;
          // groups[0] is the most recent non-stale group (toList() order is NOT
          // guaranteed by the graph engine, so we order() explicitly above).
          const latestGroup = propsToObj(groups[0]);
          const linkedPrs = await g
            .V()
            .has('PRGroup', 'id', latestGroup.id)
            .out('GROUPS')
            .hasLabel('PullRequest')
            .not(__.has('stale', 'true'))
            .valueMap(true)
            .toList();
          return { group: latestGroup, prs: linkedPrs.map(propsToObj) };
        }).catch(() => null);

        // If a PRGroup exists with open PRs, verify they're still open on GitHub
        if (existingGroup && existingGroup.prs.length > 0) {
          let allOpen = true;
          for (const pr of existingGroup.prs) {
            try {
              const repoUrl = pr.repository || env.gitRepo;
              const { owner, repo } = parseOwnerRepo(repoUrl);
              const ghRes = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.pr_number}`,
                {
                  headers: {
                    Authorization: `token ${env.gitToken}`,
                    Accept: 'application/vnd.github.v3+json',
                  },
                },
              );
              if (ghRes.ok) {
                const ghPr = await ghRes.json();
                if (ghPr.state !== 'open') {
                  allOpen = false;
                  // Mark as stale
                  await withGraph(async (g) => {
                    await g
                      .V()
                      .has('PullRequest', 'id', pr.id)
                      .property(cardinality.single, 'stale', 'true')
                      .property(cardinality.single, 'stale_at', new Date().toISOString())
                      .property(
                        cardinality.single,
                        'pr_state',
                        ghPr.merged_at ? 'merged' : 'closed',
                      )
                      .next();
                  }).catch(() => {});
                }
              }
            } catch {
              // Can't verify — assume open
            }
          }
          if (allOpen) {
            console.error(
              `[trigger_pr_creation] Multi-repo: existing PRGroup ${existingGroup.group.id} still has all open PRs — reusing`,
            );
            return ok({
              multiRepo: true,
              existing: true,
              pullRequests: existingGroup.prs.map((p) => ({
                prUrl: p.pr_url,
                prNumber: p.pr_number,
                repository: p.repository,
              })),
            });
          }
          // Some PRs are stale — supersede the old PRGroup so we don't leave
          // multiple live PRGroups for one sprint (which would double-link the
          // still-open PRs and violate "one PRGroup per logical change").
          await withGraph(async (g) => {
            await g
              .V()
              .has('PRGroup', 'id', existingGroup.group.id)
              .property(cardinality.single, 'stale', 'true')
              .property(cardinality.single, 'stale_at', new Date().toISOString())
              .next();
            // Clear the denormalized PR copy on the Sprint vertex so it can't keep
            // pointing at a now-stale/closed PR after the re-run (mirrors the
            // single-repo stale path below). Fresh values are written when the new
            // PRGroup's PRs are persisted further down.
            await g
              .V()
              .has('Sprint', 'id', env.sprintId)
              .property(cardinality.single, 'pr_url', '')
              .property(cardinality.single, 'pr_number', '')
              .next();
          }).catch(() => {});
        }

        const prResults = [];
        for (const repo of env.gitRepos) {
          const result = await lambda.send(
            new InvokeCommand({
              FunctionName: createPrLambda,
              Payload: Buffer.from(
                JSON.stringify({
                  projectId: env.projectId,
                  branch,
                  baseBranch,
                  title:
                    title || `Construction: ${env.sprintId} (${parseOwnerRepo(repo.url).repo})`,
                  gitToken: env.gitToken,
                  gitRepo: repo.url,
                  executionId: process.env.EXECUTION_ID || '',
                }),
              ),
            }),
          );
          const resp = JSON.parse(Buffer.from(result.Payload).toString());
          if (resp.prUrl && resp.prNumber) {
            prResults.push({ ...resp, repository: repo.url });
          } else {
            console.error(`[trigger_pr_creation] No PR created for ${repo.url}:`, resp);
          }
        }

        if (prResults.length === 0) return err('No PRs were created across any repository');

        // Persist each PR to Neptune and create a PRGroup
        await withGraph(async (g) => {
          const groupId = `prg-${env.sprintId}-${Date.now()}`;
          const prIds = [];

          for (const pr of prResults) {
            // Include the FULL owner/repo in the id. GitHub PR numbers are per-repository,
            // so prNumber alone collides across repos (e.g. acme/api#1 and globex/api#1), and
            // repo-name-only (split('/')[1]) collides across orgs. owner/repo is the unique key
            // and matches the convention used everywhere else (clone dirs, `repository` prop).
            // The id is opaque (never parsed or used as a path), so the slash is safe.
            const prId = `pr-${env.sprintId}-${pr.repository}-${pr.prNumber}`;
            prIds.push(prId);

            await g
              .V()
              .has('PullRequest', 'id', prId)
              .fold()
              .coalesce(
                __.unfold(),
                __.addV('PullRequest')
                  .property(cardinality.single, 'id', prId)
                  .property(cardinality.single, 'sprint_id', env.sprintId)
                  .property(cardinality.single, 'created_at', new Date().toISOString()),
              )
              .property(cardinality.single, 'pr_url', pr.prUrl)
              .property(cardinality.single, 'pr_number', String(pr.prNumber))
              .property(cardinality.single, 'branch', branch)
              .property(cardinality.single, 'base_branch', baseBranch || 'main')
              .property(cardinality.single, 'repository', pr.repository)
              .property(cardinality.single, 'pr_state', 'open')
              .next();

            // Link Sprint --HAS_PR--> PullRequest
            const edgeExists = await g
              .V()
              .has('Sprint', 'id', env.sprintId)
              .outE('HAS_PR')
              .inV()
              .has('PullRequest', 'id', prId)
              .hasNext();
            if (!edgeExists) {
              await g
                .V()
                .has('Sprint', 'id', env.sprintId)
                .addE('HAS_PR')
                .to(__.V().has('PullRequest', 'id', prId))
                .next();
            }
          }

          // Create PRGroup vertex
          await g
            .addV('PRGroup')
            .property(cardinality.single, 'id', groupId)
            .property(cardinality.single, 'title', title || `Construction: ${env.sprintId}`)
            .property(cardinality.single, 'sprint_id', env.sprintId)
            .property(cardinality.single, 'created_at', new Date().toISOString())
            .next();

          // Link Sprint --HAS_PR_GROUP--> PRGroup
          await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .addE('HAS_PR_GROUP')
            .to(__.V().has('PRGroup', 'id', groupId))
            .next();

          // Link PRGroup --GROUPS--> each PullRequest
          for (const prId of prIds) {
            await g
              .V()
              .has('PRGroup', 'id', groupId)
              .addE('GROUPS')
              .to(__.V().has('PullRequest', 'id', prId))
              .next();
          }

          // Store first PR on Sprint vertex for backward compat (UI quick-access)
          await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .property(cardinality.single, 'pr_url', prResults[0].prUrl)
            .property(cardinality.single, 'pr_number', String(prResults[0].prNumber))
            .next();

          console.error(
            `[trigger_pr_creation] Multi-repo: created ${prIds.length} PRs in group ${groupId}`,
          );
        });

        // Broadcast PR creation event
        broadcastEvent('pr.created', {
          prUrl: prResults[0].prUrl,
          prNumber: prResults[0].prNumber,
          branch,
          prGroup: prResults.map((p) => ({
            prUrl: p.prUrl,
            prNumber: p.prNumber,
            repository: p.repository,
          })),
        }).catch(() => {});

        return ok({
          multiRepo: true,
          pullRequests: prResults.map((p) => ({
            prUrl: p.prUrl,
            prNumber: p.prNumber,
            repository: p.repository,
          })),
        });
      } catch (e) {
        return err(`Failed to trigger multi-repo PR creation: ${e.message}`);
      }
    }

    // --- Single-repo path (original behavior) ---
    try {
      // Check Neptune first — if an open PR node already exists for this sprint+branch, return it immediately
      // This prevents duplicate PR creation on construction re-runs
      const existingPr = await withGraph(async (g) => {
        const prNodes = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('HAS_PR')
          .has('PullRequest', 'branch', branch)
          .not(__.has('stale', 'true'))
          .valueMap(true)
          .toList();
        if (prNodes.length > 0) {
          const node = prNodes[0];
          const get = (k) => (node?.get ? node.get(k)?.[0] : node?.[k]?.[0]);
          return { prUrl: get('pr_url'), prNumber: get('pr_number') };
        }
        return null;
      }).catch(() => null);

      if (existingPr?.prUrl) {
        console.error(`[trigger_pr_creation] PR already exists in graph: ${existingPr.prUrl}`);

        // Verify the PR is still open on GitHub — it may have been merged/closed since we stored it
        let prIsOpen = true;
        try {
          const { owner, repo } = parseOwnerRepo(env.gitRepo);
          const ghRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${existingPr.prNumber}`,
            {
              headers: {
                Authorization: `token ${env.gitToken}`,
                Accept: 'application/vnd.github.v3+json',
              },
            },
          );
          if (ghRes.ok) {
            const ghPr = await ghRes.json();
            if (ghPr.state !== 'open') {
              prIsOpen = false;
              const prState = ghPr.merged_at ? 'merged' : 'closed';
              console.error(
                `[trigger_pr_creation] Existing PR #${existingPr.prNumber} is ${prState} — marking stale and creating a new one`,
              );

              // Mark the existing PullRequest node as stale in Neptune
              const prId = `pr-${env.sprintId}-${existingPr.prNumber}`;
              await withGraph(async (g) => {
                await g
                  .V()
                  .has('PullRequest', 'id', prId)
                  .property(cardinality.single, 'stale', 'true')
                  .property(cardinality.single, 'stale_at', new Date().toISOString())
                  .property(cardinality.single, 'pr_state', prState)
                  .next();
                // Also clear pr_url/pr_number from the Sprint vertex so a fresh PR can be stored
                await g
                  .V()
                  .has('Sprint', 'id', env.sprintId)
                  .property(cardinality.single, 'pr_url', '')
                  .property(cardinality.single, 'pr_number', '')
                  .next();
              }).catch((e) =>
                console.error('[trigger_pr_creation] Failed to mark PR as stale:', e.message),
              );
            } else {
              console.error(
                `[trigger_pr_creation] Existing PR #${existingPr.prNumber} is still open — reusing it`,
              );
            }
          }
        } catch (ghCheckErr) {
          console.error(
            '[trigger_pr_creation] Could not verify PR state on GitHub — reusing cached PR:',
            ghCheckErr.message,
          );
        }

        if (prIsOpen) {
          return ok({ prUrl: existingPr.prUrl, prNumber: existingPr.prNumber, existing: true });
        }
        // Fall through to create a new PR below
      }

      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: createPrLambda,
          Payload: Buffer.from(
            JSON.stringify({
              projectId: env.projectId,
              branch,
              baseBranch,
              title: title || `Construction: ${env.sprintId}`,
              gitToken: env.gitToken,
              gitRepo: env.gitRepo,
              executionId: process.env.EXECUTION_ID || '',
            }),
          ),
        }),
      );
      const resp = JSON.parse(Buffer.from(result.Payload).toString());
      if (resp.statusCode >= 400) {
        return err(
          resp.error || resp.body || `create-pr Lambda returned status ${resp.statusCode}`,
        );
      }

      // Persist PR data to Neptune: upsert a PullRequest node and link to Sprint
      if (resp.prUrl && resp.prNumber) {
        try {
          await withGraph(async (g) => {
            const prId = `pr-${env.sprintId}-${resp.prNumber}`;

            // Upsert PullRequest node (coalesce handles both new and existing)
            await g
              .V()
              .has('PullRequest', 'id', prId)
              .fold()
              .coalesce(
                __.unfold(),
                __.addV('PullRequest')
                  .property(cardinality.single, 'id', prId)
                  .property(cardinality.single, 'sprint_id', env.sprintId)
                  .property(cardinality.single, 'created_at', new Date().toISOString()),
              )
              .property(cardinality.single, 'pr_url', resp.prUrl)
              .property(cardinality.single, 'pr_number', String(resp.prNumber))
              .property(cardinality.single, 'branch', branch)
              .property(cardinality.single, 'base_branch', baseBranch || 'main')
              .property(cardinality.single, 'pr_state', 'open')
              .next();

            // Link Sprint --HAS_PR--> PullRequest (only if edge doesn't already exist)
            const edgeExists = await g
              .V()
              .has('Sprint', 'id', env.sprintId)
              .outE('HAS_PR')
              .inV()
              .has('PullRequest', 'id', prId)
              .hasNext();
            if (!edgeExists) {
              await g
                .V()
                .has('Sprint', 'id', env.sprintId)
                .addE('HAS_PR')
                .to(__.V().has('PullRequest', 'id', prId))
                .next();
            }

            // Also store pr_url and pr_number on the Sprint vertex for quick access
            await g
              .V()
              .has('Sprint', 'id', env.sprintId)
              .property(cardinality.single, 'pr_url', resp.prUrl)
              .property(cardinality.single, 'pr_number', String(resp.prNumber))
              .next();

            console.error(`[trigger_pr_creation] PR saved to graph: ${prId} -> ${resp.prUrl}`);
          });
        } catch (graphErr) {
          console.error('[trigger_pr_creation] Failed to save PR to graph:', graphErr.message);
        }

        // Broadcast PR creation event so the frontend can update in real-time
        try {
          await broadcastEvent('pr.created', {
            prUrl: resp.prUrl,
            prNumber: resp.prNumber,
            branch,
          });
        } catch (bcastErr) {
          console.error('[trigger_pr_creation] Failed to broadcast PR event:', bcastErr.message);
        }
      }

      return ok(resp);
    } catch (e) {
      return err(`Failed to trigger PR creation: ${e.message}`);
    }
  },
);

server.tool(
  'post_pr_comment',
  `Post a comment to a GitHub Pull Request associated with the current sprint.
Use this after completing a review to post the review summary (including risk score) to the PR.
In multi-repo projects, specify the repository parameter to target a specific repo's PR.
If repository is omitted, posts to the primary PR (stored on the Sprint vertex).`,
  {
    body: z.string().describe('The markdown comment body to post to the PR'),
    repository: z
      .string()
      .optional()
      .describe('Optional: target repo in "owner/repo" format. If omitted, uses primary PR.'),
  },
  async ({ body: commentBody, repository }) => {
    if (!env.gitToken) return err('GIT_TOKEN not available — cannot post PR comment');
    try {
      let targetRepo = repository || env.gitRepo;
      let prNumber = null;

      if (repository) {
        // Multi-repo: look up the PR number from the PullRequest node for this specific repo
        const prData = await withGraph(async (g) => {
          const prNodes = await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .out('HAS_PR')
            .has('PullRequest', 'repository', repository)
            .not(__.has('stale', 'true'))
            .valueMap(true)
            .toList();
          if (prNodes.length > 0) {
            const node = prNodes[0];
            const get = (k) => (node?.get ? node.get(k)?.[0] : null);
            return { prNumber: get('pr_number'), prUrl: get('pr_url') };
          }
          return null;
        });
        if (!prData?.prNumber)
          return err(`No open PR found for repository "${repository}" in this sprint`);
        prNumber = prData.prNumber;
      } else {
        // Single-repo: look up from Sprint vertex (backward compat)
        if (!env.gitRepo) return err('GIT_REPO not available — cannot post PR comment');
        const sprintData = await withGraph(async (g) => {
          const result = await g.V().has('Sprint', 'id', env.sprintId).valueMap().next();
          const v = result.value;
          if (!v?.get) return null;
          return { prNumber: v.get('pr_number')?.[0] || null };
        });
        if (!sprintData?.prNumber)
          return err('No PR found for this sprint — create a PR before posting a comment');
        prNumber = sprintData.prNumber;
      }

      const { owner, repo } = parseOwnerRepo(targetRepo);
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${env.gitToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body: commentBody }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        return err(`GitHub API error posting comment: ${response.status} ${errorText}`);
      }

      const comment = await response.json();
      console.error(
        `[post_pr_comment] Posted comment to PR #${prNumber} on ${targetRepo}: ${comment.html_url}`,
      );
      return ok({ commentUrl: comment.html_url, prNumber, repository: targetRepo });
    } catch (e) {
      return err(`Failed to post PR comment: ${e.message}`);
    }
  },
);

server.tool(
  'get_pr_comments',
  `Read all comments from the GitHub Pull Request associated with the current sprint.
Returns both inline review comments and general PR comments, sorted chronologically.
Use this to understand reviewer feedback before making modifications.`,
  {},
  async () => {
    if (!env.gitToken) return err('GIT_TOKEN not available — cannot read PR comments');
    if (!env.gitRepo) return err('GIT_REPO not available — cannot read PR comments');
    try {
      const sprintData = await withGraph(async (g) => {
        const result = await g.V().has('Sprint', 'id', env.sprintId).valueMap().next();
        const v = result.value;
        if (!v?.get) return null;
        return { prNumber: v.get('pr_number')?.[0] || null };
      });

      if (!sprintData?.prNumber) return err('No PR found for this sprint');

      const { owner, repo } = parseOwnerRepo(env.gitRepo);
      const headers = {
        Authorization: `token ${env.gitToken}`,
        Accept: 'application/vnd.github.v3+json',
      };

      const [reviewRes, issueRes] = await Promise.all([
        fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${sprintData.prNumber}/comments`,
          { headers },
        ),
        fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${sprintData.prNumber}/comments`,
          { headers },
        ),
      ]);

      if (!reviewRes.ok || !issueRes.ok)
        return err(`GitHub API error: review=${reviewRes.status} issue=${issueRes.status}`);

      const reviewComments = await reviewRes.json();
      const issueComments = await issueRes.json();

      const mapComment = (c, type) => ({
        id: c.id,
        type,
        author: c.user?.login || 'unknown',
        body: c.body,
        path: c.path || null,
        line: c.line || c.original_line || null,
        createdAt: c.created_at,
      });

      const comments = [
        ...(Array.isArray(reviewComments)
          ? reviewComments.map((c) => mapComment(c, 'review'))
          : []),
        ...(Array.isArray(issueComments) ? issueComments.map((c) => mapComment(c, 'general')) : []),
      ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      console.error(
        `[get_pr_comments] Fetched ${comments.length} comments from PR #${sprintData.prNumber}`,
      );
      return ok({ prNumber: sprintData.prNumber, comments });
    } catch (e) {
      return err(`Failed to get PR comments: ${e.message}`);
    }
  },
);

// ─── CROSS-SPRINT CONTEXT TOOLS ───

server.tool(
  'get_previous_sprint_summary',
  `Get a condensed summary of all previous sprints in the current project.
For each sprint, returns: name, description, final phase, artifact counts,
all GeneralInfo nodes (titles + content — design decisions, RE findings, architecture notes),
all Requirement nodes (title + description + acceptance_criteria), and key metrics (tasks done/total, review status).
Results are ordered by creation date (newest first). Use this at sprint start to understand project history.`,
  {},
  async () => {
    try {
      return await withGraph(async (g) => {
        // Get all sprints for this project except the current one
        const sprints = await g
          .V()
          .has('Project', 'id', env.projectId)
          .out('HAS_SPRINT')
          .has('id', P.neq(env.sprintId))
          .order()
          .by('created_at', Order.desc)
          .valueMap(true)
          .toList();

        if (!sprints.length)
          return ok({ sprints: [], message: 'No previous sprints found for this project.' });

        const summaries = [];
        for (const s of sprints) {
          const sprint = propsToObj(s);

          // Get artifact counts by label
          const contained = await g
            .V()
            .has('Sprint', 'id', sprint.id)
            .out('CONTAINS')
            .groupCount()
            .by(T_label)
            .next();
          const counts = {};
          if (contained.value) {
            contained.value.forEach((count, label) => {
              counts[label] = count;
            });
          }

          // Get all GeneralInfo nodes (full content — these are design decisions and RE findings)
          const generalInfoNodes = await g
            .V()
            .has('Sprint', 'id', sprint.id)
            .out('CONTAINS')
            .hasLabel('GeneralInfo')
            .valueMap(true)
            .toList();

          // Get all Requirement nodes
          const requirementNodes = await g
            .V()
            .has('Sprint', 'id', sprint.id)
            .out('CONTAINS')
            .hasLabel('Requirement')
            .valueMap(true)
            .toList();

          // Get task completion metrics
          const tasks = await g
            .V()
            .has('Sprint', 'id', sprint.id)
            .out('CONTAINS')
            .hasLabel('Task')
            .values('status')
            .toList();
          const tasksDone = tasks.filter((s) => s === 'done').length;

          // Get review status
          const reviews = await g
            .V()
            .has('Sprint', 'id', sprint.id)
            .out('HAS_REVIEW')
            .valueMap(true)
            .toList();

          summaries.push({
            sprintId: sprint.id,
            name: sprint.name || '',
            description: sprint.description || '',
            phase: sprint.phase || 'INCEPTION',
            createdAt: sprint.created_at || sprint.createdAt || '',
            artifactCounts: counts,
            metrics: {
              totalTasks: tasks.length,
              tasksDone,
              reviewStatus: reviews.length > 0 ? propsToObj(reviews[0]).status || 'NONE' : 'NONE',
            },
            generalInfo: generalInfoNodes.map((n) => {
              const obj = propsToObj(n);
              return { id: obj.id, type: obj.type, title: obj.title, content: obj.content };
            }),
            requirements: requirementNodes.map((n) => {
              const obj = propsToObj(n);
              return {
                id: obj.id,
                title: obj.title,
                description: obj.description,
                acceptance_criteria: obj.acceptance_criteria,
                category: obj.category,
                priority: obj.priority,
              };
            }),
          });
        }

        return ok({ sprints: summaries });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'get_previous_sprint_graph',
  `Get the full subgraph for a specific previous sprint: all contained nodes and the edges between them.
Returns { nodes: [...], edges: [...] } — same structure as get_sprint_graph but for any sprint in the project.
Use this when you need detailed information about a specific previous sprint's artifacts and their relationships.
The sprint must belong to the current project.`,
  {
    sprintId: z.string().describe('The id of the previous sprint to retrieve'),
  },
  async ({ sprintId }) => {
    try {
      return await withGraph(async (g) => {
        // Validate the sprint belongs to this project
        const belongsToProject = await g
          .V()
          .has('Project', 'id', env.projectId)
          .out('HAS_SPRINT')
          .has('Sprint', 'id', sprintId)
          .hasNext();
        if (!belongsToProject)
          return err(`Sprint "${sprintId}" not found in project "${env.projectId}"`);

        const vertices = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .union(__.out('CONTAINS'), __.out('HAS_REVIEW'), __.out('HAS_PR'), __.out('HAS_PR_GROUP'))
          .project('id', 'label', 'props')
          .by('id')
          .by(T_label)
          .by(__.valueMap())
          .toList();

        const nodeIds = vertices.map((v) => v.get('id'));
        if (!nodeIds.length) return ok({ sprintId, nodes: [], edges: [] });

        const edges = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .union(__.out('CONTAINS'), __.out('HAS_REVIEW'), __.out('HAS_PR'), __.out('HAS_PR_GROUP'))
          .bothE()
          .where(__.otherV().has('id', P.within(...nodeIds)))
          .project('source', 'target', 'label')
          .by(__.outV().values('id'))
          .by(__.inV().values('id'))
          .by(T_label)
          .dedup()
          .toList();

        const nodes = vertices.map((v) => ({
          id: v.get('id'),
          label: v.get('label'),
          ...propsToObj(v.get('props')),
        }));
        const edgeList = edges
          .filter(
            (e) => !['CONTAINS', 'HAS_REVIEW', 'HAS_PR', 'HAS_PR_GROUP'].includes(e.get('label')),
          )
          .map((e) => ({
            source: e.get('source'),
            target: e.get('target'),
            label: e.get('label'),
          }));

        return ok({ sprintId, nodes, edges: edgeList });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.tool(
  'carry_forward_knowledge',
  `Carry forward knowledge from the most recent completed sprint into the current sprint.
Copies all GeneralInfo nodes (reverse-engineering findings, design decisions, architecture notes)
and all Requirement nodes from the most recent previous sprint, creating new nodes in the current sprint
with a \`carried_from_sprint\` property and CARRIED_FROM edges linking back to the originals.
Returns a summary of what was carried forward. Call this once at sprint start during Workspace Detection.`,
  {},
  async () => {
    try {
      return await withGraph(async (g) => {
        // Find the most recent previous sprint (by created_at, excluding current)
        const prevSprints = await g
          .V()
          .has('Project', 'id', env.projectId)
          .out('HAS_SPRINT')
          .has('id', P.neq(env.sprintId))
          .order()
          .by('created_at', Order.desc)
          .limit(1)
          .valueMap(true)
          .toList();

        if (!prevSprints.length) {
          return ok({
            carried: false,
            message: 'No previous sprints found. Nothing to carry forward.',
          });
        }

        const prevSprint = propsToObj(prevSprints[0]);

        // Check if carry-forward was already done for this sprint
        const existingCarried = await g
          .V()
          .has('Sprint', 'id', env.sprintId)
          .out('CONTAINS')
          .hasLabel('GeneralInfo')
          .has('carried_from_sprint', prevSprint.id)
          .count()
          .next();
        if (existingCarried.value > 0) {
          return ok({
            carried: false,
            message: `Knowledge from sprint "${prevSprint.name || prevSprint.id}" was already carried forward (${existingCarried.value} artifacts exist).`,
          });
        }

        // Get all GeneralInfo nodes from the previous sprint
        const generalInfoNodes = await g
          .V()
          .has('Sprint', 'id', prevSprint.id)
          .out('CONTAINS')
          .hasLabel('GeneralInfo')
          .valueMap(true)
          .toList();

        // Get all Requirement nodes from the previous sprint
        const requirementNodes = await g
          .V()
          .has('Sprint', 'id', prevSprint.id)
          .out('CONTAINS')
          .hasLabel('Requirement')
          .valueMap(true)
          .toList();

        const carriedGeneralInfo = [];
        const carriedRequirements = [];

        // Carry forward GeneralInfo nodes
        for (const node of generalInfoNodes) {
          const orig = propsToObj(node);
          const newId = `cf-${orig.id}`;

          // Create new node in current sprint
          let addQ = g
            .addV('GeneralInfo')
            .property(cardinality.single, 'id', newId)
            .property(cardinality.single, 'sprint_id', env.sprintId)
            .property(cardinality.single, 'carried_from_sprint', prevSprint.id)
            .property(cardinality.single, 'carried_from_id', orig.id)
            .property(cardinality.single, 'createdAt', new Date().toISOString());

          // Copy relevant properties
          for (const prop of ['type', 'title', 'content']) {
            if (orig[prop]) addQ = addQ.property(cardinality.single, prop, orig[prop]);
          }
          await addQ.next();

          // Link to current sprint via CONTAINS
          await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .addE('CONTAINS')
            .to(__.V().has('GeneralInfo', 'id', newId))
            .next();

          // Link back to original via CARRIED_FROM
          await g
            .V()
            .has('GeneralInfo', 'id', newId)
            .addE('CARRIED_FROM')
            .to(__.V().has('GeneralInfo', 'id', orig.id))
            .next();

          carriedGeneralInfo.push({
            id: newId,
            originalId: orig.id,
            title: orig.title,
            type: orig.type,
          });
        }

        // Carry forward Requirement nodes
        for (const node of requirementNodes) {
          const orig = propsToObj(node);
          const newId = `cf-${orig.id}`;

          let addQ = g
            .addV('Requirement')
            .property(cardinality.single, 'id', newId)
            .property(cardinality.single, 'sprint_id', env.sprintId)
            .property(cardinality.single, 'carried_from_sprint', prevSprint.id)
            .property(cardinality.single, 'carried_from_id', orig.id)
            .property(cardinality.single, 'createdAt', new Date().toISOString());

          // Copy relevant properties
          for (const prop of [
            'title',
            'description',
            'acceptance_criteria',
            'category',
            'priority',
          ]) {
            if (orig[prop]) addQ = addQ.property(cardinality.single, prop, orig[prop]);
          }
          await addQ.next();

          // Link to current sprint via CONTAINS
          await g
            .V()
            .has('Sprint', 'id', env.sprintId)
            .addE('CONTAINS')
            .to(__.V().has('Requirement', 'id', newId))
            .next();

          // Link back to original via CARRIED_FROM
          await g
            .V()
            .has('Requirement', 'id', newId)
            .addE('CARRIED_FROM')
            .to(__.V().has('Requirement', 'id', orig.id))
            .next();

          carriedRequirements.push({
            id: newId,
            originalId: orig.id,
            title: orig.title,
            category: orig.category,
          });
        }

        return ok({
          carried: true,
          fromSprint: { id: prevSprint.id, name: prevSprint.name || '' },
          summary: {
            generalInfoCount: carriedGeneralInfo.length,
            requirementCount: carriedRequirements.length,
            totalCarried: carriedGeneralInfo.length + carriedRequirements.length,
          },
          generalInfo: carriedGeneralInfo,
          requirements: carriedRequirements,
        });
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Graph MCP server started on stdio');
}

main().catch((e) => {
  console.error('Graph MCP server failed:', e);
  process.exit(1);
});
