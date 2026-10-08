import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import gremlin from 'gremlin';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from './helpers/v2-table.js';
import { contextFromEnv, validateStartupContext } from '../mcp/startup-context.js';

const entrypoint = fileURLToPath(new URL('./fixtures/mcp-stdio-entry.js', import.meta.url));
const transports = [];
const id = `stdio-${randomUUID()}`;
let db;
let conn;
let g;
let env;
let execution;
let stage;

beforeAll(async () => {
  db = makeDdb();
  await createV2Table(db.client, id);
  const store = createProcessStore({ ddb: db.doc, tableName: id });
  execution = await store.createExecution({ executionId: id, intentId: id, projectId: id });
  stage = await store.putStage({
    executionId: id,
    stageInstanceId: 'si-1',
    stageId: 'design',
    sectionIndex: 0,
    unitSlug: 'api',
    state: 'RUNNING',
  });
  await store.putStage({
    executionId: id,
    stageInstanceId: 'si-resumed',
    stageId: 'design',
    state: 'WAITING_FOR_HUMAN',
  });
  await db.doc.send(
    new PutCommand({
      TableName: id,
      Item: { ...execution, pk: 'EXEC#bad-meta', executionId: 'bad-meta', intentId: 'foreign' },
    }),
  );
  await db.doc.send(
    new PutCommand({
      TableName: id,
      Item: {
        ...stage,
        sk: 'STAGE#bad-stage',
        stageInstanceId: 'bad-stage',
        executionId: 'foreign',
      },
    }),
  );
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(conn);
  await g.addV('Intent').property('id', id).property('project_id', id).next();
  await g.addV('Intent').property('id', `${id}-foreign`).property('project_id', 'foreign').next();
  env = {
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_MAX_ATTEMPTS: '1',
    AWS_REGION: 'us-east-1',
    POWERTOOLS_SERVICE_NAME: 'collaborative-aidlc',
    DYNAMODB_LOCAL_ENDPOINT: process.env.DYNAMODB_LOCAL_ENDPOINT,
    NEPTUNE_ENDPOINT: process.env.NEPTUNE_ENDPOINT,
    GREMLIN_PORT: process.env.GREMLIN_PORT,
    GREMLIN_PROTOCOL: 'ws',
    V2_EXECUTION_ID: id,
    V2_INTENT_ID: id,
    V2_PROJECT_ID: id,
    V2_PROCESS_TABLE: id,
    V2_STAGE_ID: 'design',
    V2_STAGE_INSTANCE_ID: 'si-1',
    V2_SECTION_INDEX: '0',
    V2_UNIT_SLUG: 'api',
    V2_MCP_ROLE: 'author',
    V2_MCP_MODE: 'stage',
  };
});

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
});

afterAll(async () => {
  await g?.V().has('Intent', 'id', id).drop().next();
  await g?.V().has('Intent', 'id', `${id}-foreign`).drop().next();
  await conn?.close();
  if (db) {
    await deleteV2Table(db.client, id);
    db.client.destroy();
  }
});

const child = (overrides = {}) => {
  const stderr = [];
  const protocolErrors = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    stderr: 'pipe',
    env: { ...env, ...overrides },
  });
  transports.push(transport);
  transport.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'stdio-regression-client', version: '1.0.0' });
  // MCP SDK exposes a callback property, not the DOM EventTarget API.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onerror = (error) => protocolErrors.push(error);
  return { client, transport, stderr, protocolErrors };
};

const nonStage = {
  V2_STAGE_ID: '',
  V2_STAGE_INSTANCE_ID: '',
  V2_SECTION_INDEX: '',
  V2_UNIT_SLUG: '',
};

describe('MCP startup read retries', () => {
  const setup = () => {
    const scope = {
      executionId: id,
      intentId: id,
      projectId: id,
      stageId: 'design',
      stageInstanceId: 'si-1',
      unitSlug: 'api',
      sectionIndex: 0,
    };
    const graph = {
      V: vi.fn().mockReturnThis(),
      has: vi.fn().mockReturnThis(),
      hasNext: vi.fn().mockResolvedValue(true),
    };
    return {
      scope,
      mode: 'stage',
      store: {
        getExecution: vi.fn().mockResolvedValue(execution),
        getStage: vi.fn().mockResolvedValue(stage),
      },
      openGraph: vi.fn().mockResolvedValue(graph),
      closeGraphSource: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      graph,
    };
  };
  const errorWith = (fields) => Object.assign(new Error('read failed'), fields);

  it.each(['getExecution', 'getStage', 'openGraph', 'hasNext'])(
    'recovers from a transient %s failure',
    async (operation) => {
      const deps = setup();
      const read = deps.store[operation] ?? deps[operation] ?? deps.graph[operation];
      read.mockRejectedValueOnce(errorWith({ code: 'ECONNRESET' }));
      await expect(validateStartupContext(deps)).resolves.toBeUndefined();
      expect(read).toHaveBeenCalledTimes(2);
      expect(deps.sleep.mock.calls).toEqual([[250]]);
      expect(deps.closeGraphSource).toHaveBeenCalledTimes(operation === 'hasNext' ? 2 : 1);
    },
  );

  it.each([
    { name: 'ThrottlingException' },
    { name: 'ProvisionedThroughputExceededException' },
    { name: 'RequestLimitExceeded' },
    { name: 'TimeoutError' },
    { name: 'RequestTimeout' },
    { code: 'ECONNREFUSED' },
    { code: 'ETIMEDOUT' },
    { code: 'EPIPE' },
    { code: 'EAI_AGAIN' },
    { $metadata: { httpStatusCode: 503 } },
    { statusCode: 429 },
    { statusCode: 500 },
    { message: 'Unexpected server response code 502 with body:\nunavailable' },
    { message: 'Unexpected server response: 504' },
    { message: 'Connection has been closed.' },
  ])('bounds retries for transient errors: %j', async (fields) => {
    const deps = setup();
    const error = errorWith(fields);
    deps.graph.hasNext.mockRejectedValue(error);
    await expect(validateStartupContext(deps)).rejects.toBe(error);
    expect(deps.sleep.mock.calls).toEqual([[250], [500]]);
    expect(deps.openGraph).toHaveBeenCalledTimes(3);
    expect(deps.closeGraphSource).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } },
    { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 400 } },
    { name: 'ValidationException' },
    { code: 'ENOTFOUND' },
    { message: 'Unexpected server response code 403 with body:\nForbidden' },
    { message: 'Unexpected server response: 401' },
    {},
  ])('does not retry permanent or unknown errors: %j', async (fields) => {
    const deps = setup();
    const error = errorWith(fields);
    deps.graph.hasNext.mockRejectedValue(error);
    await expect(validateStartupContext(deps)).rejects.toBe(error);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.closeGraphSource).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['getExecution', null, 'execution'],
    ['getExecution', { executionId: 'foreign' }, 'execution'],
    ['getStage', null, 'stage'],
    ['getStage', { executionId: 'foreign' }, 'stage'],
    ['hasNext', false, 'intent'],
  ])('fails immediately on %s returning %j', async (operation, result, record) => {
    const deps = setup();
    (deps.store[operation] ?? deps.graph[operation]).mockResolvedValue(result);
    await expect(validateStartupContext(deps)).rejects.toThrow(`MCP ${record} scope mismatch`);
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe('MCP stdio transport', () => {
  it('preserves trusted persona identity and policy scope during startup parsing', () => {
    const policy = { learnings: 'off', summaryConfirmation: 'required', planApproval: 'required' };
    const { scope } = contextFromEnv({
      ...env,
      V2_STAGE_POLICY: JSON.stringify(policy),
      V2_AGENT_REF: 'support-agent',
      V2_VALIDATION_ROUND: '2',
      V2_CHECKPOINT_OWNER: '0',
      V2_ASK_QUESTION: '0',
    });
    expect(scope).toMatchObject({
      policy,
      agentRef: 'support-agent',
      validationRound: 2,
      checkpointOwner: false,
      canAsk: false,
    });
  });

  it.each([true, false])(
    'keeps policy tool restrictions after validation (checkpoint owner: %s)',
    async (checkpointOwner) => {
      const { client, transport } = child({
        V2_STAGE_POLICY: JSON.stringify({
          learnings: 'off',
          summaryConfirmation: 'required',
          planApproval: 'required',
        }),
        ...(checkpointOwner ? {} : { V2_CHECKPOINT_OWNER: '0', V2_ASK_QUESTION: '0' }),
      });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.includes('confirm_summary')).toBe(checkpointOwner);
      expect(names.includes('request_plan_approval')).toBe(checkpointOwner);
      expect(names.includes('ask_question')).toBe(checkpointOwner);
      expect(names).not.toContain('record_team_knowledge');
      expect(names).not.toContain('record_learning_rule');
      expect(names).toContain('create_artifact');
    },
  );

  it('keeps startup and tool-trace diagnostics off the JSON-RPC stdout stream', async () => {
    const { client, transport, stderr, protocolErrors } = child();
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const call = await client.callTool({
      name: 'collect_metric',
      arguments: { metrics: { tokensInput: 1 } },
    });
    expect(call.isError).not.toBe(true);
    expect(protocolErrors).toEqual([]);
    expect(stderr.join('')).toContain('[agentcore-mcp] connected');
    expect(stderr.join('')).toContain('[mcp-trace] collect_metric');
  }, 10_000);

  it('recovers before exposing tools and keeps retry diagnostics on stderr', async () => {
    const { client, transport, stderr, protocolErrors } = child({
      TEST_MCP_EXECUTION_READ_FAILURES: '2',
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(protocolErrors).toEqual([]);
    expect(stderr.join('')).toContain('retrying startup read (1/2)');
    expect(stderr.join('')).toContain('retrying startup read (2/2)');
    expect(stderr.join('')).toContain('[agentcore-mcp] connected');
  });

  it.each(['author', 'reviewer', 'reader'])(
    'starts a valid %s stage against real records',
    async (role) => {
      const { client, transport } = child({ V2_MCP_ROLE: role });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('get_artifact');
      expect(names.includes('create_artifact')).toBe(role === 'author');
      expect(names.includes('submit_review')).toBe(role === 'reviewer');
    },
  );

  it('supports execution-backed conflict review without a stage row', async () => {
    const { client, transport } = child({
      ...nonStage,
      V2_MCP_MODE: 'conflict',
      V2_MCP_ROLE: 'reviewer',
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('submit_review');
  });

  it('supports a resumed stage with no unit or section attribution', async () => {
    const { client, transport } = child({
      V2_STAGE_INSTANCE_ID: 'si-resumed',
      V2_UNIT_SLUG: '',
      V2_SECTION_INDEX: '',
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_artifact');
  });

  it('supports pre-execution discussion readers without DynamoDB access', async () => {
    const { client, transport } = child({
      ...nonStage,
      V2_MCP_MODE: 'discussion',
      V2_MCP_ROLE: 'reader',
      V2_EXECUTION_ID: '',
      V2_PROCESS_TABLE: '',
      DYNAMODB_LOCAL_ENDPOINT: 'http://127.0.0.1:9',
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'collect_metric',
    );
    expect((await client.callTool({ name: 'get_intent_graph', arguments: {} })).isError).not.toBe(
      true,
    );
  });

  it.each([
    ['unknown role', { V2_MCP_ROLE: 'admin' }],
    ['missing role', { V2_MCP_ROLE: '' }],
    ['unknown mode', { V2_MCP_MODE: 'unrestricted' }],
    ['missing project', { V2_PROJECT_ID: '' }],
    ['missing intent', { V2_INTENT_ID: '' }],
    ['missing execution ID', { V2_EXECUTION_ID: '' }],
    ['missing process table', { V2_PROCESS_TABLE: '' }],
    ['missing execution', { V2_EXECUTION_ID: 'missing' }],
    ['mismatched execution intent', { V2_EXECUTION_ID: 'bad-meta' }],
    ['mismatched execution project', { V2_PROJECT_ID: 'foreign' }],
    ['missing stage ID', { V2_STAGE_ID: '' }],
    ['missing stage instance', { V2_STAGE_INSTANCE_ID: '' }],
    ['missing stage', { V2_STAGE_INSTANCE_ID: 'missing' }],
    ['foreign stage row', { V2_STAGE_INSTANCE_ID: 'bad-stage' }],
    ['mismatched stage', { V2_STAGE_ID: 'other-stage' }],
    ['mismatched unit', { V2_UNIT_SLUG: 'other-unit' }],
    ['mismatched section', { V2_SECTION_INDEX: '1' }],
    ['omitted section', { V2_SECTION_INDEX: '' }],
    ['invalid section', { V2_SECTION_INDEX: 'NaN' }],
    ['unavailable authorization read', { DYNAMODB_LOCAL_ENDPOINT: 'http://127.0.0.1:9' }],
    ['unavailable graph read', { GREMLIN_PORT: '9' }],
    ['exhausted startup retries', { TEST_MCP_EXECUTION_READ_FAILURES: '3' }],
    [
      'foreign intent project',
      {
        ...nonStage,
        V2_MCP_MODE: 'discussion',
        V2_MCP_ROLE: 'reader',
        V2_INTENT_ID: `${id}-foreign`,
      },
    ],
    [
      'missing graph intent',
      { ...nonStage, V2_MCP_MODE: 'discussion', V2_MCP_ROLE: 'reader', V2_INTENT_ID: 'missing' },
    ],
    ['discussion author', { ...nonStage, V2_MCP_MODE: 'discussion' }],
    ['conflict author', { ...nonStage, V2_MCP_MODE: 'conflict' }],
  ])('rejects %s before exposing the MCP transport', async (_name, overrides) => {
    const { client, transport, stderr } = child(overrides);
    await expect(client.connect(transport)).rejects.toThrow();
    expect(stderr.join('')).toContain('[agentcore-mcp] fatal:');
    expect(stderr.join('')).not.toContain('[agentcore-mcp] connected');
    const store = createProcessStore({ ddb: db.doc, tableName: id });
    expect(await store.getExecution(id)).toEqual(execution);
    expect(await store.getStage(id, 'si-1')).toEqual(stage);
  });
});
