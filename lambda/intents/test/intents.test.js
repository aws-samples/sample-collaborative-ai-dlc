import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  GetDurableExecutionCommand,
  InvokeCommand,
  ListDurableExecutionsByFunctionCommand,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
// Used to compute the deterministic stage-instance ids the rewind flow resets/supersedes.
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';

const { archiveArtifactsSpy } = vi.hoisted(() => ({
  archiveArtifactsSpy: vi.fn(),
}));
vi.mock('../../shared/artifact-versioning.js', async (importOriginal) => {
  const actual = await importOriginal();
  archiveArtifactsSpy.mockImplementation(actual.archiveArtifactsForStages);
  return {
    ...actual,
    archiveArtifactsForStages: archiveArtifactsSpy,
  };
});

const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const ssmMock = mockClient(SSMClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
let sourceControlReviewComments = [];
let sourceControlValidationResponse = { ready: true, repositories: [] };

// In-memory single-table fake for the v2 process table + blocks table.
const procStore = new Map();
// Separate fake for the yjs-documents table (hash key `documentId` only).
const yjsStore = new Map();
const keyOf = (pk, sk) => `${pk}|${sk}`;

const installDdbFakes = () => {
  ddbMock.reset();
  procStore.clear();
  yjsStore.clear();
  ddbMock.on(GetCommand).callsFake((input) => {
    const key =
      input.Key.pk !== undefined
        ? keyOf(input.Key.pk, input.Key.sk)
        : input.Key.providerInstance !== undefined
          ? `CONN#${input.Key.userId}#${input.Key.providerInstance}`
          : `CONN#${input.Key.userId}`;
    const item = procStore.get(key);
    return { Item: item ? { ...item } : undefined };
  });
  ddbMock.on(PutCommand).callsFake((input) => {
    const item = input.Item;
    const k = keyOf(item.pk, item.sk);
    if (input.ConditionExpression?.includes('attribute_not_exists') && procStore.has(k)) {
      const e = new Error('cond');
      e.name = 'ConditionalCheckFailedException';
      throw e;
    }
    procStore.set(k, { ...item });
    return {};
  });
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    const puts = (input.TransactItems ?? []).map((item) => item.Put).filter(Boolean);
    if (
      puts.some(
        (put) =>
          put.ConditionExpression?.includes('attribute_not_exists') &&
          procStore.has(keyOf(put.Item.pk, put.Item.sk)),
      )
    ) {
      const error = new Error('transaction cancelled');
      error.name = 'TransactionCanceledException';
      throw error;
    }
    for (const put of puts) procStore.set(keyOf(put.Item.pk, put.Item.sk), { ...put.Item });
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    let items = [...procStore.values()];
    if (input.IndexName === 'GSI1') {
      items = items.filter((i) => i.GSI1PK === values[':pk']);
      if (values[':sk']) items = items.filter((i) => (i.GSI1SK || '').startsWith(values[':sk']));
    } else {
      items = items.filter((i) => i.pk === values[':pk']);
      // SK conditions the store actually issues: begins_with prefix reads and
      // the OUTPUT#-excluding range pair (getExecutionRecords includeOutputs:false).
      const cond = input.KeyConditionExpression || '';
      const prefix = /begins_with\(sk,\s*(:\w+)\)/.exec(cond);
      if (prefix) {
        items = items.filter((i) => (i.sk || '').startsWith(values[prefix[1]]));
      }
      if (cond.includes('sk < :lo')) items = items.filter((i) => i.sk < values[':lo']);
      if (cond.includes('sk >= :hi')) items = items.filter((i) => i.sk >= values[':hi']);
      items.sort((a, b) => (a.sk || '').localeCompare(b.sk || ''));
    }
    // FilterExpression subset used by getOutputs (stage attribution + seq cursor).
    const filter = input.FilterExpression || '';
    if (filter.includes('stageInstanceId = :sid')) {
      items = items.filter((i) => i.stageInstanceId === values[':sid']);
    }
    if (filter.includes('attribute_not_exists(stageInstanceId)')) {
      items = items.filter((i) => i.stageInstanceId == null);
    }
    if (filter.includes('seq > :after')) {
      items = items.filter((i) => Number(i.seq) > values[':after']);
    }
    if (input.ScanIndexForward === false) items.reverse();
    return { Items: items.map((i) => ({ ...i })) };
  });
  ddbMock.on(ScanCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    let items = [...procStore.values()];
    if ((input.FilterExpression || '').includes('sk = :meta')) {
      items = items.filter((i) => i.sk === values[':meta']);
    }
    return { Items: items.map((i) => ({ ...i })) };
  });
  ddbMock.on(UpdateCommand).callsFake((input) => {
    const k = keyOf(input.Key.pk, input.Key.sk);
    const existing = procStore.get(k);
    const values = input.ExpressionAttributeValues || {};
    const names = input.ExpressionAttributeNames || {};
    const cond = input.ConditionExpression || '';
    const casFail = () => {
      const e = new Error('cas');
      e.name = 'ConditionalCheckFailedException';
      throw e;
    };
    if (cond.includes(':fromStatus') && (!existing || existing.status !== values[':fromStatus'])) {
      casFail();
    }
    if (cond.includes('#status = :pending') && (!existing || existing.status !== 'pending')) {
      casFail();
    }
    if (cond.includes('#status <> :pending') && (!existing || existing.status === 'pending')) {
      casFail();
    }
    if (cond.includes('attribute_exists(pk)') && !existing) casFail();
    // Lifecycle CAS used by updateUnitState / updateQuorumEdit: `#state IN (:from0, …)`.
    const inMatch = /#state IN \(([^)]+)\)/.exec(cond);
    if (inMatch) {
      const allowed = inMatch[1].split(',').map((ref) => values[ref.trim()]);
      if (!existing || !allowed.includes(existing.state)) casFail();
    }
    if (
      cond.includes(':ifOrid') &&
      (!existing || existing.orchestratorRunId !== values[':ifOrid'])
    ) {
      casFail();
    }
    const next = { ...(existing || { pk: input.Key.pk, sk: input.Key.sk }) };
    // Generic SET applier: "SET a = :x, b = :y, #n = :z" (names resolved).
    const setMatch = /SET (.+)$/.exec(input.UpdateExpression || '');
    if (setMatch) {
      for (const clause of setMatch[1].split(',')) {
        const [lhs, rhs] = clause.split('=').map((s) => s.trim());
        if (!lhs || !rhs) continue;
        const field = names[lhs] ?? lhs;
        if (rhs in values) next[field] = values[rhs];
      }
    }
    procStore.set(k, next);
    return { Attributes: { ...next } };
  });
  ddbMock.on(DeleteCommand).callsFake((input) => {
    // Yjs docs are keyed by documentId alone; everything else is pk|sk.
    if (input.Key.documentId !== undefined) yjsStore.delete(input.Key.documentId);
    else procStore.delete(keyOf(input.Key.pk, input.Key.sk));
    return {};
  });
  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    for (const requests of Object.values(input.RequestItems || {})) {
      for (const req of requests) {
        const key = req.DeleteRequest?.Key;
        if (key) procStore.delete(keyOf(key.pk, key.sk));
      }
    }
    return { UnprocessedItems: {} };
  });
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).callsFake((input) => {
    if (input.FunctionName === 'source-control-test') {
      const request = JSON.parse(Buffer.from(input.Payload).toString());
      const response =
        request.action === 'validate-project'
          ? sourceControlValidationResponse
          : request.operation === 'list-review-comments'
            ? { ok: true, result: sourceControlReviewComments }
            : { ok: true, result: null };
      return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(response)) };
    }
    return { StatusCode: 202 };
  });
  lambdaMock.on(SendDurableExecutionCallbackSuccessCommand).resolves({});
  lambdaMock.on(GetDurableExecutionCommand).resolves({ Status: 'TIMED_OUT' });
  lambdaMock.on(ListDurableExecutionsByFunctionCommand).resolves({ DurableExecutions: [] });
  lambdaMock.on(StopDurableExecutionCommand).resolves({
    StopTimestamp: new Date('2026-07-17T00:00:00.000Z'),
  });
};

// Seed a HUMAN# gate row straight into the fake table (the runtime writes these;
// the intents lambda only reads/answers them).
const seedGate = (
  intentId,
  humanTaskId,
  { status = 'pending', callbackId = null, stageInstanceId = 'si-req' } = {},
) => {
  procStore.set(keyOf(`EXEC#${intentId}`, `HUMAN#${humanTaskId}`), {
    pk: `EXEC#${intentId}`,
    sk: `HUMAN#${humanTaskId}`,
    type: 'HumanTask',
    executionId: intentId,
    humanTaskId,
    stageInstanceId,
    kind: 'question',
    status,
    questions: '[{"text":"?","type":"single","options":[{"label":"Yes"}]}]',
    answer: null,
    callbackId,
  });
};

const answerGate = (sub, projectId, intentId, humanTaskId, bodyObj = { answer: { ok: 1 } }) =>
  handler({
    httpMethod: 'POST',
    path: `/projects/${projectId}/intents/${intentId}/gates/${humanTaskId}/answer`,
    pathParameters: { projectId, intentId, humanTaskId },
    body: JSON.stringify(bodyObj),
    ...claims(sub),
  });

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('V2_PROCESS_TABLE', 'v2-proc-test');
  vi.stubEnv('BLOCKS_TABLE', 'blocks-test');
  vi.stubEnv('V2_ORCHESTRATOR_FUNCTION', 'orchestrator-test');
  vi.stubEnv('SOURCE_CONTROL_FUNCTION', 'source-control-test');
  vi.stubEnv('REALTIME_DOC_SECRET', 'test-secret');
  vi.stubEnv('YJS_DOCUMENTS_TABLE', 'yjs-test');
  ({ handler } = await import('../index.js'));

  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.close();
});

beforeEach(() => {
  installDdbFakes();
  sourceControlReviewComments = [];
  sourceControlValidationResponse = { ready: true, repositories: [] };
  ssmMock.reset();
  agentcoreMock.reset();
  archiveArtifactsSpy.mockClear();
});

const claims = (sub) => ({
  requestContext: { authorizer: { claims: { sub, email: `${sub}@x` } } },
});

const orchestratorInvokes = () =>
  lambdaMock
    .commandCalls(InvokeCommand)
    .filter((call) => call.args[0].input.FunctionName === 'orchestrator-test');

// Seed a v2 project with an owner member + a primary repo + a workflow META row.
const seedV2Project = async (sub) => {
  const projectId = randomUUID();
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', 'V2 P')
    .property('kind', 'v2')
    .property('workflow_id', 'aidlc-v2')
    .property('workflow_version', '')
    .property('park_release_seconds', '120')
    .property('max_parallel_units', '3')
    .property('agent_cli', 'kiro')
    .property('cli_models', JSON.stringify({ claude: 'us.anthropic.claude-opus-4-8' }))
    .property('git_provider', 'github')
    .next();
  const repoId = `repo-${randomUUID()}`;
  await g
    .addV('Repository')
    .property('id', repoId)
    .property('url', 'owner/repo')
    .property('role', 'primary')
    .property('added_at', '2026-01-01')
    .as('r')
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_REPO')
    .to('r')
    .next();
  await g.addV('User').property('id', sub).property('email', `${sub}@x`).next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', 'owner')
    .to(gremlin.process.statics.V().has('User', 'id', sub))
    .next();
  // Workflow META row (latest version) so create can pin it, plus a version-4
  // snapshot with a single 'feature' scope ref so scope validation passes.
  procStore.set(keyOf('WF#default#aidlc-v2', 'META'), {
    pk: 'WF#default#aidlc-v2',
    sk: 'META',
    version: 4,
  });
  procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#SCOPEREF#feature'), {
    pk: 'WF#default#aidlc-v2',
    sk: 'V#4#SCOPEREF#feature',
    scopeId: 'feature',
  });
  return projectId;
};

// Attach an additional Repository vertex to an existing v2 project (secondary
// repo, e.g. to exercise per-repo baseBranches validation/resolution).
const addRepo = async (projectId, url, role = 'secondary') => {
  const repoId = `repo-${randomUUID()}`;
  await g
    .addV('Repository')
    .property('id', repoId)
    .property('url', url)
    .property('role', role)
    .property('added_at', '2026-01-02')
    .as('r')
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_REPO')
    .to('r')
    .next();
};

// Attach a TrackerBinding vertex to a project via HAS_TRACKER (mirrors the
// tracker abstraction's projection shape). Returns the binding id.
const seedTrackerBinding = async (projectId, { provider = 'github-issues' } = {}) => {
  const bindingId = `tb-${randomUUID()}`;
  await g
    .addV('TrackerBinding')
    .property('id', bindingId)
    .property('provider', provider)
    .property('instance', 'public')
    .property('external_project_key', 'owner/repo')
    .property('display_name', 'owner/repo')
    .as('t')
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_TRACKER')
    .to('t')
    .next();
  return bindingId;
};

const createIntent = async (
  sub,
  projectId,
  body = { title: 'I', prompt: 'Build X', scope: 'feature' },
) => {
  const res = await handler({
    httpMethod: 'POST',
    path: `/projects/${projectId}/intents`,
    pathParameters: { projectId },
    body: JSON.stringify(body),
    ...claims(sub),
  });
  return res;
};

describe('POST /projects/{id}/intents', () => {
  it('creates a DRAFT intent, pinning the workflow latest version', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId);
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.status).toBe('DRAFT');
    expect(intent.workflowId).toBe('aidlc-v2');
    expect(intent.workflowVersion).toBe(4);
    expect(intent.scope).toBe('feature');
    expect(intent.prompt).toBe('Build X');
    expect(intent.repos).toEqual(['owner/repo']);
    expect(intent.branch).toBe('aidlc/i'); // slug of the title 'I'
    // Project run-config snapshotted onto the intent at create.
    expect(intent.agentCli).toBe('kiro');
    expect(intent.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(intent.parkReleaseSeconds).toBe(120);
    // WP5: lane concurrency cap snapshotted; the ladder decision starts unset.
    expect(intent.maxParallelUnits).toBe(3);
    expect(intent.constructionAutonomyMode).toBeNull();
    // WP6: PR strategy snapshotted (project default = intent-pr).
    expect(intent.prStrategy).toBe('intent-pr');
  });

  it('derives the branch from the title slug (single hyphens, no `--`)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Add User Login — OAuth & SSO!',
      prompt: 'Build the login flow',
      scope: 'feature',
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    // Punctuation/em-dash runs collapse to a single hyphen: the `--` separator
    // is reserved for unit-lane branches (`<branch>--s<k>-unit-<slug>`).
    expect(intent.branch).toBe('aidlc/add-user-login-oauth-sso');
  });

  it('resolves project PR strategy precedence and snapshots it on the intent', async () => {
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
    ssmMock
      .on(GetParameterCommand, { Name: '/collab/dev/pr-strategy' })
      .resolves({ Parameter: { Value: 'pr-per-unit' } });
    try {
      const sub = `u-${randomUUID()}`;
      const inheritedProject = await seedV2Project(sub);
      await g
        .V()
        .has('Project', 'id', inheritedProject)
        .property(gremlin.process.cardinality.single, 'pr_strategy', 'default')
        .next();
      const inherited = JSON.parse((await createIntent(sub, inheritedProject)).body);
      expect(inherited.prStrategy).toBe('pr-per-unit');

      const explicitProject = await seedV2Project(sub);
      await g
        .V()
        .has('Project', 'id', explicitProject)
        .property(gremlin.process.cardinality.single, 'pr_strategy', 'intent-pr')
        .next();
      const explicit = JSON.parse((await createIntent(sub, explicitProject)).body);
      expect(explicit.prStrategy).toBe('intent-pr');
    } finally {
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', undefined);
    }
  });

  it('falls back to the prompt slug when there is no title', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      prompt: 'Fix the checkout crash',
      scope: 'feature',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).branch).toBe('aidlc/fix-the-checkout-crash');
  });

  it('appends a short id suffix only when the slug collides within the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const body = { title: 'Same Title', prompt: 'Build X', scope: 'feature' };
    const first = JSON.parse((await createIntent(sub, projectId, body)).body);
    const second = JSON.parse((await createIntent(sub, projectId, body)).body);
    expect(first.branch).toBe('aidlc/same-title');
    const shortId = second.id.replace(/-/g, '').slice(0, 8);
    expect(second.branch).toBe(`aidlc/same-title-${shortId}`);
  });

  it('falls back to a short id when the title yields no slug', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: '🚀🚀🚀',
      prompt: '🔥',
      scope: 'feature',
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.branch).toBe(`aidlc/${intent.id.replace(/-/g, '').slice(0, 8)}`);
  });

  it('honors a caller-supplied branch verbatim', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      branch: 'custom/my-branch',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).branch).toBe('custom/my-branch');
  });

  it('defaults baseBranch/baseBranches to null (never hardcodes "main") when the caller omits them', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId);
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.baseBranch).toBeNull();
    expect(intent.baseBranches).toBeNull();
  });

  it('honors a caller-supplied per-repo baseBranches map', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await addRepo(projectId, 'owner/web');
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      baseBranches: { 'owner/repo': 'develop', 'owner/web': 'release' },
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.baseBranches).toEqual({ 'owner/repo': 'develop', 'owner/web': 'release' });
  });

  it('honors the legacy single baseBranch alongside a partial baseBranches override', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      baseBranch: 'main',
      baseBranches: { 'owner/repo': 'develop' },
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.baseBranch).toBe('main');
    expect(intent.baseBranches).toEqual({ 'owner/repo': 'develop' });
  });

  it('rejects a baseBranches map that references a repo not on the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      baseBranches: { 'owner/not-a-project-repo': 'develop' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('owner/not-a-project-repo');
  });

  it('rejects a malformed baseBranches (not an object of repoUrl -> branchName)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      baseBranches: ['owner/repo'],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('baseBranches');
  });

  it('rejects a baseBranches entry with a blank branch name', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'Whatever',
      prompt: 'Build X',
      scope: 'feature',
      baseBranches: { 'owner/repo': '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('owner/repo');
  });

  it('merges the Admin global model under the project selection at create', async () => {
    // Global default sets kiro (which the project leaves unset) and claude (which
    // the project overrides). Effective snapshot = project wins for claude, global
    // fills kiro — i.e. project > global.
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
    ssmMock.on(GetParameterCommand, { Name: '/collab/dev/cli-models' }).resolves({
      Parameter: {
        Value: JSON.stringify({
          kiro: 'claude-sonnet-4.6',
          claude: 'us.anthropic.claude-sonnet-4-6',
        }),
      },
    });
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const res = await createIntent(sub, projectId);
      expect(res.statusCode).toBe(201);
      const intent = JSON.parse(res.body);
      expect(intent.cliModels).toEqual({
        claude: 'us.anthropic.claude-opus-4-8', // project override wins
        kiro: 'claude-sonnet-4.6', // global fills the gap
      });
    } finally {
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', undefined);
    }
  });

  it('snapshots MCP servers as two SEPARATE tiers on META (not pre-merged), values-free', async () => {
    // Global tier: a server referencing a `${VAR}` (no value inline). Project
    // tier: a distinct server. The META row must carry both tiers apart, so the
    // runtime can resolve each tier's refs against its own SSM prefix.
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
    ssmMock.on(GetParameterCommand, { Name: '/collab/dev/custom-mcp-servers' }).resolves({
      Parameter: {
        Value: JSON.stringify({
          globalCtx: { type: 'http', url: 'https://g.example/mcp', headers: { A: 'Bearer ${GK}' } },
        }),
      },
    });
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      await g
        .V()
        .has('Project', 'id', projectId)
        .property(
          gremlin.process.cardinality.single,
          'custom_mcp_servers',
          JSON.stringify({ projTool: { command: 'npx', env: { K: '${PK}' } } }),
        )
        .next();
      const res = await createIntent(sub, projectId);
      expect(res.statusCode).toBe(201);
      const executionId = JSON.parse(res.body).executionId;
      const meta = procStore.get(keyOf(`EXEC#${executionId}`, 'META'));
      expect(meta.mcpServersByTier).toEqual({
        global: {
          globalCtx: {
            type: 'http',
            url: 'https://g.example/mcp',
            headers: { A: 'Bearer ${GK}' },
          },
        },
        project: { projTool: { command: 'npx', env: { K: '${PK}' } } },
      });
      // Old single merged field is no longer written.
      expect(meta.customMcpServers ?? null).toBeNull();
    } finally {
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', undefined);
    }
  });

  it('records a tracker source when seeded from a bound issue', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const bindingId = await seedTrackerBinding(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'From issue #42',
      prompt: '# Bug\n\nFix the thing',
      scope: 'feature',
      source: {
        bindingId,
        resourceType: 'issue',
        resourceId: '42',
        resourceUrl: 'https://github.com/owner/repo/issues/42',
      },
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.source).toEqual({
      bindingId,
      provider: 'github-issues',
      instance: 'public',
      resourceType: 'issue',
      resourceId: '42',
      resourceUrl: 'https://github.com/owner/repo/issues/42',
    });
  });

  it('drops a source whose binding is not on the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'Build X',
      scope: 'feature',
      source: { bindingId: 'tb-fabricated', resourceId: '7' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).source).toBeNull();
  });

  it('rejects a non-member', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(`other-${randomUUID()}`, projectId);
    expect(res.statusCode).toBe(403);
  });

  it('defaults the scope when absent (DRAFT-first flow) — "feature" when offered', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, { title: 'I', prompt: 'Build X' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).scope).toBe('feature');
  });

  it('rejects a scope not offered by the workflow', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'Build X',
      scope: 'nonsense',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Unknown scope/);
    expect(body.scopes).toEqual(['feature']);
  });

  // ── Create-time plan validation ("required when in scope") ──
  // Seed a workflow snapshot with real placements + STAGE catalog blocks so
  // loadExecutionPlan resolves an actual plan at create.
  const seedPlanFixtures = (projectId, { scopes, placements, stages }) => {
    void projectId;
    for (const scopeId of scopes) {
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#SCOPEREF#${scopeId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#SCOPEREF#${scopeId}`,
        scopeId,
      });
    }
    for (const p of placements) {
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${p.stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${p.stageId}`,
        stageId: p.stageId,
        order: p.order ?? 0,
        scopeMembership: p.scopeMembership,
      });
    }
    for (const s of stages) {
      procStore.set(keyOf(`BLOCK#SYSTEM#STAGE#${s.id}`, 'V#latest'), {
        pk: `BLOCK#SYSTEM#STAGE#${s.id}`,
        sk: 'V#latest',
        GSI1PK: 'TENANT#SYSTEM#STAGE',
        GSI1SK: s.id,
        blockId: s.id,
        id: s.id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator', // reserved ref — no AGENT block needed
        produces: s.produces ?? [],
        consumes: s.consumes ?? [],
        sensors: [],
        humanValidation: 'none',
      });
    }
  };

  it('rejects a scope whose plan cannot resolve (genuinely dangling consume) with a 400', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlanFixtures(projectId, {
      scopes: ['broken'],
      placements: [{ stageId: 'consumer', scopeMembership: { broken: 'EXECUTE' } }],
      stages: [{ id: 'consumer', consumes: [{ artifact: 'ghost', required: true }] }],
    });
    const res = await createIntent(sub, projectId, { title: 'I', prompt: 'X', scope: 'broken' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not runnable/);
    expect(body.errors.map((e) => e.code)).toContain('dangling_consume');
    // Nothing was written — the DRAFT row must not exist.
    const metas = [...procStore.values()].filter(
      (i) => i.type === 'Execution' && i.projectId === projectId,
    );
    expect(metas).toEqual([]);
  });

  it('persists non-fatal plan warnings on the intent and returns them in the 201 (lean scope)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlanFixtures(projectId, {
      scopes: ['lean'],
      placements: [
        // Producer exists in the workflow but is SKIP for the lean scope
        // (EXECUTE elsewhere — a designed scope shortcut, not an un-wired stage).
        { stageId: 'producer', scopeMembership: { lean: 'SKIP', full: 'EXECUTE' } },
        { stageId: 'consumer', order: 1, scopeMembership: { lean: 'EXECUTE' } },
      ],
      stages: [
        { id: 'producer', produces: ['unit-of-work'] },
        { id: 'consumer', consumes: [{ artifact: 'unit-of-work', required: true }] },
      ],
    });
    const res = await createIntent(sub, projectId, { title: 'I', prompt: 'X', scope: 'lean' });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.planWarnings).toHaveLength(1);
    expect(intent.planWarnings[0]).toMatchObject({
      code: 'scope_absent_consume',
      stageId: 'consumer',
      ref: 'unit-of-work',
    });
    // Persisted on META (not just echoed) so GETs carry it after navigation.
    const meta = [...procStore.values()].find(
      (i) => i.type === 'Execution' && i.intentId === intent.id,
    );
    expect(meta.planWarnings).toHaveLength(1);
  });

  it('leaves planWarnings null for a clean scope', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).planWarnings).toBeNull();
  });

  it('rejects a v1 project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    await g
      .addV('Project')
      .property('id', projectId)
      .property('name', 'v1')
      .property('kind', 'v1')
      .next();
    await g.addV('User').property('id', sub).property('email', `${sub}@x`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_MEMBER')
      .property('role', 'owner')
      .to(gremlin.process.statics.V().has('User', 'id', sub))
      .next();
    const res = await createIntent(sub, projectId);
    expect(res.statusCode).toBe(400);
  });
});

describe('unit PR review feedback', () => {
  const seedActiveReview = async (sub) => {
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const metaKey = keyOf(`EXEC#${intent.id}`, 'META');
    procStore.set(metaKey, {
      ...procStore.get(metaKey),
      status: 'RUNNING',
      prStrategy: 'pr-per-unit',
      startedBy: sub,
      gitProvider: 'github',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#auth'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNIT#S1#auth',
      type: 'Unit',
      executionId: intent.id,
      sectionIndex: 1,
      slug: 'auth',
      state: 'PR_DRAFT',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPR#S1#auth#owner%2Frepo'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPR#S1#auth#owner%2Frepo',
      type: 'UnitPullRequest',
      executionId: intent.id,
      sectionIndex: 1,
      unitSlug: 'auth',
      repository: 'owner/repo',
      provider: 'github',
      number: 7,
      state: 'DRAFT',
      sourceBranch: 'unit',
      targetBranch: 'intent',
    });
    return { projectId, intent };
  };

  it('refetches selectable comments and queues an idempotent versioned batch', async () => {
    sourceControlReviewComments = [
      {
        id: 101,
        type: 'review',
        body: 'Handle the empty state',
        user: { login: 'reviewer' },
        bot: false,
        system: false,
        path: 'src/view.tsx',
        line: 42,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:01:00Z',
        version: '2026-01-01T00:01:00Z',
      },
      {
        id: 102,
        type: 'issue',
        body: 'Automated note',
        user: { login: 'ci[bot]' },
        bot: true,
        system: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        version: '2026-01-01T00:00:00Z',
      },
    ];
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedActiveReview(sub);
    const path = `/projects/${projectId}/intents/${intent.id}/units/1/auth/feedback`;
    const get = await handler({
      httpMethod: 'GET',
      path,
      pathParameters: { projectId, intentId: intent.id, sectionIndex: '1', unitSlug: 'auth' },
      ...claims(sub),
    });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).comments).toHaveLength(1);

    const post = await handler({
      httpMethod: 'POST',
      path,
      pathParameters: { projectId, intentId: intent.id, sectionIndex: '1', unitSlug: 'auth' },
      body: JSON.stringify({
        comments: [{ repository: 'owner/repo', commentId: '101' }],
      }),
      ...claims(sub),
    });
    expect(post.statusCode).toBe(202);
    const batch = JSON.parse(post.body);
    expect(batch).toMatchObject({
      sectionIndex: 1,
      unitSlug: 'auth',
      state: 'QUEUED',
      requestedBy: sub,
    });
    expect(batch.comments[0]).toMatchObject({
      id: '101',
      repository: 'owner/repo',
      version: '2026-01-01T00:01:00Z',
    });
  });

  it('atomically rejects concurrent feedback batches that overlap on a comment version', async () => {
    sourceControlReviewComments = [
      {
        id: 101,
        type: 'review',
        body: 'Handle the empty state',
        user: { login: 'reviewer' },
        bot: false,
        system: false,
        path: 'src/view.tsx',
        line: 42,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:01:00Z',
        version: '2026-01-01T00:01:00Z',
      },
      {
        id: 103,
        type: 'review',
        body: 'Cover the loading state',
        user: { login: 'reviewer' },
        bot: false,
        system: false,
        path: 'src/view.tsx',
        line: 51,
        createdAt: '2026-01-01T00:02:00Z',
        updatedAt: '2026-01-01T00:03:00Z',
        version: '2026-01-01T00:03:00Z',
      },
    ];
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedActiveReview(sub);
    const path = `/projects/${projectId}/intents/${intent.id}/units/1/auth/feedback`;
    const request = (comments) =>
      handler({
        httpMethod: 'POST',
        path,
        pathParameters: {
          projectId,
          intentId: intent.id,
          sectionIndex: '1',
          unitSlug: 'auth',
        },
        body: JSON.stringify({ comments }),
        ...claims(sub),
      });
    const responses = await Promise.all([
      request([{ repository: 'owner/repo', commentId: '101' }]),
      request([
        { repository: 'owner/repo', commentId: '101' },
        { repository: 'owner/repo', commentId: '103' },
      ]),
    ]);
    expect(responses.map((response) => response.statusCode).toSorted()).toEqual([202, 409]);
    const batches = [...procStore.values()].filter((row) => row.type === 'FeedbackBatch');
    expect(batches).toHaveLength(1);
    const claimsFor101 = [...procStore.values()].filter(
      (row) => row.type === 'FeedbackCommentClaim' && row.commentId === '101',
    );
    expect(claimsFor101).toHaveLength(1);
  });
});

describe('composed grids + DRAFT PATCH', () => {
  // Two construction stages: analyze produces what build requires — the
  // starvation fixture for grid validation.
  const seedGridFixtures = (projectId) => {
    void projectId;
    for (const p of [
      { stageId: 'analyze', order: 0, scopeMembership: { feature: 'EXECUTE' } },
      { stageId: 'build', order: 1, scopeMembership: { feature: 'EXECUTE' } },
    ]) {
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${p.stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${p.stageId}`,
        stageId: p.stageId,
        order: p.order,
        scopeMembership: p.scopeMembership,
      });
    }
    for (const s of [
      { id: 'analyze', produces: ['spec'], consumes: [] },
      { id: 'build', produces: [], consumes: [{ artifact: 'spec', required: true }] },
    ]) {
      procStore.set(keyOf(`BLOCK#SYSTEM#STAGE#${s.id}`, 'V#latest'), {
        pk: `BLOCK#SYSTEM#STAGE#${s.id}`,
        sk: 'V#latest',
        GSI1PK: 'TENANT#SYSTEM#STAGE',
        GSI1SK: s.id,
        blockId: s.id,
        id: s.id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator', // reserved ref — no AGENT block needed
        produces: s.produces,
        consumes: s.consumes,
        sensors: [],
        humanValidation: 'none',
      });
    }
  };

  // Flip a persisted META row's status directly (simulating a run outcome).
  const procStoreSetStatus = (intentId, status) => {
    const k = keyOf(`EXEC#${intentId}`, 'META');
    procStore.set(k, { ...procStore.get(k), status });
  };

  const patchIntent = (sub, projectId, intentId, body) =>
    handler({
      httpMethod: 'PATCH',
      path: `/projects/${projectId}/intents/${intentId}`,
      pathParameters: { projectId, intentId },
      body: JSON.stringify(body),
      ...claims(sub),
    });

  it('creates an intent from a composed grid with a custom scope label', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      scope: 'my-custom-fix',
      composedGrid: { analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.scope).toBe('my-custom-fix');
    expect(intent.composedGrid).toEqual({ analyze: 'EXECUTE', build: 'EXECUTE' });
  });

  it('defaults the scope label to "composed" when a grid arrives without one', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      composedGrid: { analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).scope).toBe('composed');
  });

  it('rejects a grid naming an unknown stage at create', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      composedGrid: { analyze: 'EXECUTE', ghost: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not runnable/);
    expect(body.errors.map((e) => e.code)).toContain('composed_grid_unknown_stage');
  });

  it('a grid that starves a required input stays creatable (lenient) with the warning persisted', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      composedGrid: { analyze: 'SKIP', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.planWarnings.map((w) => w.code)).toContain('scope_absent_consume');
  });

  it('PATCH updates title/prompt on a DRAFT', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await patchIntent(sub, projectId, intent.id, {
      title: 'New title',
      prompt: 'Refined prompt',
    });
    expect(res.statusCode).toBe(200);
    const updated = JSON.parse(res.body);
    expect(updated.title).toBe('New title');
    expect(updated.prompt).toBe('Refined prompt');
  });

  it('PATCH sets and clears the composed grid with plan re-validation', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const set = await patchIntent(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', build: 'SKIP' },
      scope: 'composed-lean',
    });
    expect(set.statusCode).toBe(200);
    const afterSet = JSON.parse(set.body);
    expect(afterSet.composedGrid).toEqual({ analyze: 'EXECUTE', build: 'SKIP' });
    expect(afterSet.scope).toBe('composed-lean');

    const clear = await patchIntent(sub, projectId, intent.id, {
      composedGrid: null,
      scope: 'feature',
    });
    expect(clear.statusCode).toBe(200);
    expect(JSON.parse(clear.body).composedGrid).toBeNull();
  });

  it('PATCH rejects an invalid grid with the resolver errors', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await patchIntent(sub, projectId, intent.id, {
      composedGrid: { ghost: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors.map((e) => e.code)).toContain('composed_grid_unknown_stage');
  });

  it('PATCH rejects a scope the workflow does not offer (no grid in play)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await patchIntent(sub, projectId, intent.id, { scope: 'nonsense' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unknown scope/);
  });

  it('PATCH 409s on a non-DRAFT intent', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    const res = await patchIntent(sub, projectId, intent.id, { title: 'Too late' });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH 404s across projects and 400s an empty patch', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProject = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const cross = await patchIntent(sub, otherProject, intent.id, { title: 'X' });
    expect(cross.statusCode).toBe(404);
    const empty = await patchIntent(sub, projectId, intent.id, {});
    expect(empty.statusCode).toBe(400);
  });

  it('start accepts a composedGrid override on a DRAFT and pins it', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({ composedGrid: { analyze: 'EXECUTE', build: 'EXECUTE' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).composedGrid).toEqual({
      analyze: 'EXECUTE',
      build: 'EXECUTE',
    });
  });

  it('start rejects a composedGrid override on a restart (non-DRAFT)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedGridFixtures(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    // Flip to FAILED so it is startable again, then try to smuggle a grid in.
    procStoreSetStatus(intent.id, 'FAILED');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({ composedGrid: { analyze: 'EXECUTE', build: 'EXECUTE' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Skip overlay × composed grid coexistence ──
  // The two mechanisms deliberately compose: the grid is the pinned
  // projection, the overlay deselects stages the projection WOULD run. A
  // redundant overlay entry (a stage the grid already excludes) is ABSORBED
  // by the grid at every write path — without the prune the resolver's
  // skip_stage_not_in_scope guard would poison the pinned combination.

  const seedSkippableGridFixtures = (projectId) => {
    seedGridFixtures(projectId);
    // Make analyze CONDITIONAL so the skip overlay may target it, and add a
    // third CONDITIONAL stage so something remains to absorb.
    const k = keyOf('BLOCK#SYSTEM#STAGE#analyze', 'V#latest');
    procStore.set(k, { ...procStore.get(k), execution: 'CONDITIONAL' });
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#extra'), {
      pk: 'WF#default#aidlc-v2',
      sk: 'V#4#PLACEMENT#extra',
      stageId: 'extra',
      order: 2,
      scopeMembership: { feature: 'EXECUTE' },
    });
    procStore.set(keyOf('BLOCK#SYSTEM#STAGE#extra', 'V#latest'), {
      pk: 'BLOCK#SYSTEM#STAGE#extra',
      sk: 'V#latest',
      GSI1PK: 'TENANT#SYSTEM#STAGE',
      GSI1SK: 'extra',
      blockId: 'extra',
      id: 'extra',
      version: 1,
      phase: 'construction',
      mode: 'inline',
      leadAgent: 'orchestrator',
      produces: [],
      consumes: [],
      execution: 'CONDITIONAL',
      sensors: [],
      humanValidation: 'none',
    });
  };

  it('create: the grid absorbs an overlay skip of a stage it already excludes', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(gremlin.process.cardinality.single, 'stage_skipping', 'enabled')
      .next();
    seedSkippableGridFixtures(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      scope: 'lean',
      // analyze is grid-SKIPped AND overlay-skipped; extra is a real overlay
      // skip of a grid-EXECUTE stage.
      composedGrid: { analyze: 'SKIP', extra: 'EXECUTE', build: 'SKIP' },
      skipStageIds: ['analyze', 'extra'],
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.skipStageIds).toEqual(['extra']); // analyze absorbed
  });

  it('PATCH: applying a grid prunes now-redundant overlay skips from the draft', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(gremlin.process.cardinality.single, 'stage_skipping', 'enabled')
      .next();
    seedSkippableGridFixtures(projectId);
    const intent = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'I',
          prompt: 'X',
          scope: 'feature',
          skipStageIds: ['analyze'],
        })
      ).body,
    );
    expect(intent.skipStageIds).toEqual(['analyze']);
    // A grid arrives (e.g. an applied composer proposal) that SKIPs analyze.
    const res = await patchIntent(sub, projectId, intent.id, {
      composedGrid: { analyze: 'SKIP', extra: 'EXECUTE', build: 'SKIP' },
      scope: 'composed-lean',
    });
    expect(res.statusCode).toBe(200);
    const updated = JSON.parse(res.body);
    expect(updated.composedGrid).toEqual({ analyze: 'SKIP', extra: 'EXECUTE', build: 'SKIP' });
    expect(updated.skipStageIds).toBeNull(); // absorbed, combination resolves
  });

  it('start: a launch grid override prunes the pinned overlay before validation', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(gremlin.process.cardinality.single, 'stage_skipping', 'enabled')
      .next();
    seedSkippableGridFixtures(projectId);
    const intent = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'I',
          prompt: 'X',
          scope: 'feature',
          skipStageIds: ['analyze', 'extra'],
        })
      ).body,
    );
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({
        composedGrid: { analyze: 'SKIP', extra: 'EXECUTE', build: 'EXECUTE' },
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    const updated = JSON.parse(res.body);
    expect(updated.skipStageIds).toEqual(['extra']);
    expect(updated.composedGrid).toEqual({
      analyze: 'SKIP',
      extra: 'EXECUTE',
      build: 'EXECUTE',
    });
  });
});

describe('POST /compose — composer sessions', () => {
  // Workflow: bugfix scope EXECUTEs both stages; SCOPE block carries the
  // keyword that the deterministic bypass matches.
  const seedComposeFixtures = () => {
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#SCOPEREF#bugfix'), {
      pk: 'WF#default#aidlc-v2',
      sk: 'V#4#SCOPEREF#bugfix',
      scopeId: 'bugfix',
    });
    for (const p of [
      { stageId: 'analyze', order: 0 },
      { stageId: 'build', order: 1 },
    ]) {
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${p.stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${p.stageId}`,
        stageId: p.stageId,
        order: p.order,
        scopeMembership: { feature: 'EXECUTE', bugfix: 'EXECUTE' },
      });
    }
    for (const s of [
      { id: 'analyze', produces: ['spec'], consumes: [] },
      { id: 'build', produces: [], consumes: [{ artifact: 'spec', required: true }] },
    ]) {
      procStore.set(keyOf(`BLOCK#SYSTEM#STAGE#${s.id}`, 'V#latest'), {
        pk: `BLOCK#SYSTEM#STAGE#${s.id}`,
        sk: 'V#latest',
        GSI1PK: 'TENANT#SYSTEM#STAGE',
        GSI1SK: s.id,
        blockId: s.id,
        id: s.id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        produces: s.produces,
        consumes: s.consumes,
        sensors: [],
        humanValidation: 'none',
      });
    }
    procStore.set(keyOf('BLOCK#SYSTEM#SCOPE#bugfix', 'V#latest'), {
      pk: 'BLOCK#SYSTEM#SCOPE#bugfix',
      sk: 'V#latest',
      GSI1PK: 'TENANT#SYSTEM#SCOPE',
      GSI1SK: 'bugfix',
      blockId: 'bugfix',
      id: 'bugfix',
      keywords: ['hotfix'],
      description: 'Fix and ship.',
    });
  };

  const composeReq = (sub, projectId, intentId, body = {}) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/compose`,
      pathParameters: { projectId, intentId },
      body: JSON.stringify(body),
      ...claims(sub),
    });

  it('a clean keyword match completes deterministically without the composer runtime', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedComposeFixtures();
    const intent = JSON.parse(
      (await createIntent(sub, projectId, { title: 'I', prompt: 'Ship a hotfix for login' })).body,
    );
    const res = await composeReq(sub, projectId, intent.id);
    expect(res.statusCode).toBe(201);
    const compose = JSON.parse(res.body);
    expect(compose.state).toBe('COMPLETED');
    expect(compose.source).toBe('match');
    expect(compose.proposal).toMatchObject({ mode: 'matched', scope: 'bugfix' });
    expect(compose.validation.valid).toBe(true);
    expect(compose.validation.summary.executedStages).toBe(2);
    // No LLM dispatch happened.
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('dispatches the composer agent when no clean keyword match exists', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
        response: { transformToString: async () => JSON.stringify({ ok: true, accepted: true }) },
      });
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedComposeFixtures();
      const intent = JSON.parse(
        (await createIntent(sub, projectId, { title: 'I', prompt: 'Do something ambiguous' })).body,
      );
      const res = await composeReq(sub, projectId, intent.id, { instructions: 'be lean' });
      expect(res.statusCode).toBe(202);
      const compose = JSON.parse(res.body);
      expect(compose.state).toBe('PENDING');
      expect(compose.source).toBe('llm');
      const call = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
      // A FRESH throwaway session per compose — never the intent's session
      // (an existing intent microVM would serve a stale image after a
      // redeploy, and spawning the intent session early would pin the future
      // run to compose-time code).
      expect(call.runtimeSessionId).toBe(`aidlc-compose-${compose.composeId}`.padEnd(33, '0'));
      expect(call.runtimeSessionId).not.toContain(intent.id);
      const payload = JSON.parse(Buffer.from(call.payload).toString());
      expect(payload).toMatchObject({
        command: 'compose-plan-start',
        intentId: intent.id,
        mode: 'front',
        workflowId: 'aidlc-v2',
        instructions: 'be lean',
      });
      expect(payload.prompt).toContain('Do something ambiguous');
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('the Admin bypass switch forces the LLM path even on a clean match', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
    try {
      ssmMock
        .on(GetParameterCommand, { Name: '/collab/dev/compose-llm-bypass' })
        .resolves({ Parameter: { Value: 'disabled' } });
      agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
        response: { transformToString: async () => JSON.stringify({ ok: true }) },
      });
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedComposeFixtures();
      const intent = JSON.parse(
        (await createIntent(sub, projectId, { title: 'I', prompt: 'Ship a hotfix' })).body,
      );
      const res = await composeReq(sub, projectId, intent.id);
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).source).toBe('llm');
    } finally {
      vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', undefined);
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('marks the row FAILED when the dispatch is refused', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error('runtime down'));
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse(
        (await createIntent(sub, projectId, { title: 'I', prompt: 'Ambiguous ask' })).body,
      );
      const res = await composeReq(sub, projectId, intent.id);
      expect(res.statusCode).toBe(503);
      const rows = [...procStore.values()].filter((i) => (i.sk || '').startsWith('COMPOSE#'));
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('FAILED');
      expect(rows[0].failureReason).toMatch(/dispatch failed/);
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('409s compose on a non-DRAFT intent and 400s an empty draft', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    const res = await composeReq(sub, projectId, intent.id);
    expect(res.statusCode).toBe(409);
  });

  it('GET /composes lists the intent sessions; detail DTO carries them too', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedComposeFixtures();
    const intent = JSON.parse(
      (await createIntent(sub, projectId, { title: 'I', prompt: 'hotfix the crash' })).body,
    );
    await composeReq(sub, projectId, intent.id);
    const list = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/composes`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(list.statusCode).toBe(200);
    const { composes } = JSON.parse(list.body);
    expect(composes).toHaveLength(1);
    expect(composes[0].state).toBe('COMPLETED');
    const detail = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(JSON.parse(detail.body).composes).toHaveLength(1);
  });

  it('presigns a namespaced report upload for a DRAFT', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'artifacts-test');
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      const res = await handler({
        httpMethod: 'POST',
        path: `/projects/${projectId}/intents/${intent.id}/compose-report-upload`,
        pathParameters: { projectId, intentId: intent.id },
        ...claims(sub),
      });
      expect(res.statusCode).toBe(200);
      const { uploadUrl, key } = JSON.parse(res.body);
      expect(key).toMatch(new RegExp(`^compose-reports/${intent.id}/`));
      expect(uploadUrl).toContain('artifacts-test');
    } finally {
      vi.stubEnv('ARTIFACTS_BUCKET', undefined);
    }
  });

  it('rejects a reportKey outside this intent namespace', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await composeReq(sub, projectId, intent.id, {
      reportKey: 'compose-reports/other-intent/x.json',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not belong/);
  });
});

describe('POST /recompose — in-flight reshape', () => {
  // analyze (produces spec) → optional (CONDITIONAL, produces extra) →
  // build (requires spec; optionally consumes extra) — all EXECUTE in feature.
  const seedRecomposeFixtures = ({ buildRequiresExtra = false } = {}) => {
    for (const p of [
      { stageId: 'analyze', order: 0 },
      { stageId: 'optional', order: 1 },
      { stageId: 'build', order: 2 },
    ]) {
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${p.stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${p.stageId}`,
        stageId: p.stageId,
        order: p.order,
        scopeMembership: { feature: 'EXECUTE' },
      });
    }
    const stages = [
      { id: 'analyze', produces: ['spec'], consumes: [], execution: 'ALWAYS' },
      { id: 'optional', produces: ['extra'], consumes: [], execution: 'CONDITIONAL' },
      {
        id: 'build',
        produces: [],
        consumes: [
          { artifact: 'spec', required: true },
          { artifact: 'extra', required: buildRequiresExtra },
        ],
        execution: 'ALWAYS',
      },
    ];
    for (const s of stages) {
      procStore.set(keyOf(`BLOCK#SYSTEM#STAGE#${s.id}`, 'V#latest'), {
        pk: `BLOCK#SYSTEM#STAGE#${s.id}`,
        sk: 'V#latest',
        GSI1PK: 'TENANT#SYSTEM#STAGE',
        GSI1SK: s.id,
        blockId: s.id,
        id: s.id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        produces: s.produces,
        consumes: s.consumes,
        execution: s.execution,
        sensors: [],
        humanValidation: 'none',
      });
    }
  };

  const seedRun = async (sub, projectId, { status = 'WAITING', rows = [], metaOver = {} }) => {
    const intent = JSON.parse(
      (await createIntent(sub, projectId, { title: 'I', prompt: 'X', scope: 'feature' })).body,
    );
    const k = keyOf(`EXEC#${intent.id}`, 'META');
    procStore.set(k, { ...procStore.get(k), status, ...metaOver });
    for (const row of rows) {
      procStore.set(keyOf(`EXEC#${intent.id}`, `STAGE#${row.stageInstanceId}`), {
        pk: `EXEC#${intent.id}`,
        sk: `STAGE#${row.stageInstanceId}`,
        type: 'Stage',
        executionId: intent.id,
        attempt: 0,
        ...row,
      });
    }
    return intent;
  };

  const recomposeReq = (sub, projectId, intentId, body) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/recompose`,
      pathParameters: { projectId, intentId },
      body: JSON.stringify(body),
      ...claims(sub),
    });

  it('replaces the projection, relaunches at the first not-yet-done stage, pins the grid', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const intent = await seedRun(sub, projectId, {
      rows: [
        { stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' },
        { stageInstanceId: 'si-optional', stageId: 'optional', state: 'WAITING_FOR_HUMAN' },
      ],
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'EXECUTE', build: 'SKIP' },
      scope: 'feature-lean',
    });
    expect(res.statusCode).toBe(202);
    const updated = JSON.parse(res.body);
    expect(updated.status).toBe('CREATED');
    expect(updated.scope).toBe('feature-lean');
    expect(updated.composedGrid).toEqual({
      analyze: 'EXECUTE',
      optional: 'EXECUTE',
      build: 'SKIP',
    });
    // Relaunched at the parked stage (the first not-yet-done one).
    const calls = orchestratorInvokes();
    const payload = JSON.parse(Buffer.from(calls.at(-1).args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'optional' });
    // The parked instance was reset for its fresh attempt.
    const row = procStore.get(keyOf(`EXEC#${intent.id}`, 'STAGE#si-optional'));
    expect(row.state).toBe('PENDING');
    // Audit trail carries the reshape.
    const events = [...procStore.values()].filter((i) => (i.sk || '').startsWith('EVENT#'));
    expect(events.map((e) => e.eventType)).toContain('v2.execution.recomposed');
  });

  it('freezes the past: a stage that ran cannot flip to SKIP', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const intent = await seedRun(sub, projectId, {
      rows: [{ stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' }],
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'SKIP', optional: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.violations.join(' ')).toMatch(/"analyze" already ran/);
  });

  it('freezes an already-skipped stage: un-skipping is rewind territory', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const intent = await seedRun(sub, projectId, {
      status: 'FAILED',
      rows: [
        { stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' },
        { stageInstanceId: 'si-optional', stageId: 'optional', state: 'SKIPPED' },
        { stageInstanceId: 'si-build', stageId: 'build', state: 'FAILED' },
      ],
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).violations.join(' ')).toMatch(/rewind to it to un-skip/);
  });

  it('rejects a grid that STRICTLY starves a pending required input', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures({ buildRequiresExtra: true });
    const intent = await seedRun(sub, projectId, {
      rows: [{ stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' }],
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'SKIP', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errors.map((e) => e.code)).toContain('starved_consume');
  });

  it('refuses recompose under autonomous construction and mid-RUN', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const autonomous = await seedRun(sub, projectId, {
      metaOver: { constructionAutonomyMode: 'autonomous' },
    });
    const guard = await recomposeReq(sub, projectId, autonomous.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'SKIP', build: 'EXECUTE' },
    });
    expect(guard.statusCode).toBe(409);
    expect(JSON.parse(guard.body).code).toBe('autonomous_construction');

    const running = await seedRun(sub, projectId, { status: 'RUNNING' });
    const mid = await recomposeReq(sub, projectId, running.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'SKIP', build: 'EXECUTE' },
    });
    expect(mid.statusCode).toBe(409);
  });

  it('409s when the recomposed grid leaves nothing to run', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const intent = await seedRun(sub, projectId, {
      status: 'FAILED',
      rows: [
        { stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' },
        { stageInstanceId: 'si-optional', stageId: 'optional', state: 'SUCCEEDED' },
      ],
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'EXECUTE', build: 'SKIP' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/Nothing left to run/);
  });

  it('the new grid absorbs a standing create-time skip of the same stage (overlay pruned on META)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    // The run was created with optional deselected (overlay) — its SKIPPED
    // row exists; the recomposed grid now expresses the same exclusion.
    const intent = await seedRun(sub, projectId, {
      rows: [
        { stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' },
        { stageInstanceId: 'si-optional', stageId: 'optional', state: 'SKIPPED' },
        { stageInstanceId: 'si-build', stageId: 'build', state: 'WAITING_FOR_HUMAN' },
      ],
      metaOver: { skipStageIds: ['optional'], stageSkipping: 'enabled' },
    });
    const res = await recomposeReq(sub, projectId, intent.id, {
      composedGrid: { analyze: 'EXECUTE', optional: 'SKIP', build: 'EXECUTE' },
    });
    expect(res.statusCode).toBe(202);
    const updated = JSON.parse(res.body);
    // The overlay entry is absorbed by the grid — META never pins a skip the
    // grid already excludes (the resolver would reject the combination).
    expect(updated.skipStageIds).toBeNull();
    expect(updated.composedGrid).toEqual({
      analyze: 'EXECUTE',
      optional: 'SKIP',
      build: 'EXECUTE',
    });
    // Relaunched at the parked stage.
    const calls = orchestratorInvokes();
    const payload = JSON.parse(Buffer.from(calls.at(-1).args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'build' });
  });

  it('in-flight compose dispatches with the frozen grid + live progress', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
        response: { transformToString: async () => JSON.stringify({ ok: true }) },
      });
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedRecomposeFixtures();
      const intent = await seedRun(sub, projectId, {
        rows: [
          { stageInstanceId: 'si-analyze', stageId: 'analyze', state: 'SUCCEEDED' },
          { stageInstanceId: 'si-optional', stageId: 'optional', state: 'SKIPPED' },
        ],
      });
      const res = await handler({
        httpMethod: 'POST',
        path: `/projects/${projectId}/intents/${intent.id}/compose`,
        pathParameters: { projectId, intentId: intent.id },
        body: JSON.stringify({ mode: 'inflight', instructions: 'trim the tail' }),
        ...claims(sub),
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).mode).toBe('inflight');
      const call = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
      const payload = JSON.parse(Buffer.from(call.payload).toString());
      expect(payload).toMatchObject({
        command: 'compose-plan-start',
        mode: 'inflight',
        frozenGrid: { analyze: 'EXECUTE', optional: 'SKIP' },
      });
      expect(payload.progressContext).toContain('analyze: SUCCEEDED');
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('in-flight compose refuses a DRAFT and an autonomous run', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedRecomposeFixtures();
    const draft = JSON.parse(
      (await createIntent(sub, projectId, { title: 'I', prompt: 'X', scope: 'feature' })).body,
    );
    const onDraft = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${draft.id}/compose`,
      pathParameters: { projectId, intentId: draft.id },
      body: JSON.stringify({ mode: 'inflight' }),
      ...claims(sub),
    });
    expect(onDraft.statusCode).toBe(409);

    const autonomous = await seedRun(sub, projectId, {
      metaOver: { constructionAutonomyMode: 'autonomous' },
    });
    const guarded = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${autonomous.id}/compose`,
      pathParameters: { projectId, intentId: autonomous.id },
      body: JSON.stringify({ mode: 'inflight' }),
      ...claims(sub),
    });
    expect(guarded.statusCode).toBe(409);
    expect(JSON.parse(guarded.body).code).toBe('autonomous_construction');
  });
});

describe('POST /start', () => {
  it('returns typed SOURCE_CONTROL_NOT_READY before mutating intent state', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    sourceControlValidationResponse = {
      ready: false,
      repositories: [
        {
          provider: 'github',
          repo: 'owner/repo',
          authType: null,
          ready: false,
          code: 'UNBOUND',
          reason: 'Source control setup is required',
        },
      ],
    };
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'SOURCE_CONTROL_NOT_READY',
      repositories: [expect.objectContaining({ repo: 'owner/repo', code: 'UNBOUND' })],
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).status).toBe('DRAFT');
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('starts repository-free projects without source-control validation', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await g.V().has('Project', 'id', projectId).outE('HAS_REPO').drop().next();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    expect(intent.repos).toEqual([]);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    expect(orchestratorInvokes()).toHaveLength(1);
  });

  it('flips DRAFT → CREATED and invokes the orchestrator', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('CREATED');
    const calls = orchestratorInvokes();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', intentId: intent.id });
    // The durable execution name must satisfy the service's 64-char cap
    // (field incident: intent-<uuid>-<uuid> was 80 chars and every Start
    // failed API validation) while staying unique per launch.
    const durableName = calls[0].args[0].input.DurableExecutionName;
    expect(durableName).toMatch(new RegExp(`^intent-${intent.id}-[0-9a-f]{16}$`));
    expect(durableName.length).toBeLessThanOrEqual(64);
  });

  it('rolls back to DRAFT when the orchestrator invoke fails, so start can be retried', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    // Hand-off throws (e.g. unqualified-ARN / transient invoke error).
    lambdaMock
      .on(InvokeCommand, { FunctionName: 'orchestrator-test' })
      .rejectsOnce(new Error('invoke failed'));
    const failed = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(failed.statusCode).toBe(500);
    // Intent must be back to DRAFT, not stranded in CREATED.
    const after = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(after.intent.status).toBe('DRAFT');
    // Retry now succeeds (invoke mock is back to resolving).
    const retry = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(retry.statusCode).toBe(202);
    expect(JSON.parse(retry.body).status).toBe('CREATED');
  });

  const setStatus = (intentId, status) => {
    const k = keyOf(`EXEC#${intentId}`, 'META');
    procStore.set(k, { ...procStore.get(k), status });
  };

  it.each(['RUNNING', 'WAITING', 'SUCCEEDED', 'CANCELLED'])(
    'refuses to start an intent that is %s',
    async (status) => {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, status);
      const res = await handler({
        httpMethod: 'POST',
        path: `/projects/${projectId}/intents/${intent.id}/start`,
        pathParameters: { projectId, intentId: intent.id },
        ...claims(sub),
      });
      expect(res.statusCode).toBe(409);
    },
  );

  it.each(['FAILED', 'CREATED'])(
    'restarts a %s intent (re-enters the pipeline, clears failureReason)',
    async (status) => {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      // Simulate a stranded/failed prior run.
      const k = keyOf(`EXEC#${intent.id}`, 'META');
      procStore.set(k, { ...procStore.get(k), status, failureReason: 'boom' });
      const res = await handler({
        httpMethod: 'POST',
        path: `/projects/${projectId}/intents/${intent.id}/start`,
        pathParameters: { projectId, intentId: intent.id },
        ...claims(sub),
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).status).toBe('CREATED');
      // Orchestrator was (re-)invoked.
      expect(orchestratorInvokes()).toHaveLength(1);
    },
  );
});

describe('realtime-token', () => {
  it('mints an intent + project scope token for a member', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/realtime-token`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const { scopes, token } = JSON.parse(res.body);
    expect(scopes).toContain(`intent:${intent.id}`);
    expect(scopes).toContain(`project:${projectId}`);
    expect(typeof token).toBe('string');
  });
});

describe('GET list + detail', () => {
  it('lists project intents and returns assembled detail', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);

    const list = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents`,
      pathParameters: { projectId },
      ...claims(sub),
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toHaveLength(1);

    const detail = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(detail.statusCode).toBe(200);
    const dto = JSON.parse(detail.body);
    expect(dto.intent.id).toBe(intent.id);
    expect(dto.stages).toEqual([]);
    expect(dto.artifacts).toEqual([]);
  });

  it('returns the full assembled DTO shape with cliModels/parkReleaseSeconds', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    // The DTO carries every record bucket the IntentView consumes.
    for (const key of [
      'stages',
      'gates',
      'metrics',
      'outputs',
      'sensorRuns',
      'artifacts',
      'pullRequests',
    ]) {
      expect(Array.isArray(detail[key])).toBe(true);
    }
    expect(detail.intent.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(detail.intent.parkReleaseSeconds).toBe(120);
  });

  const seedOutput = (
    intentId,
    seq,
    { stageInstanceId = null, content = '', display = undefined } = {},
  ) => {
    const sk = `OUTPUT#${String(seq).padStart(12, '0')}`;
    procStore.set(keyOf(`EXEC#${intentId}`, sk), {
      pk: `EXEC#${intentId}`,
      sk,
      type: 'Output',
      executionId: intentId,
      stageInstanceId,
      unitSlug: null,
      seq,
      kind: 'stdout',
      content,
      timestamp: `2026-01-01T00:00:0${seq}Z`,
      ...(display ? { display } : {}),
    });
  };

  it('detail DTO excludes OUTPUT rows (the transcript is served by /outputs)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedOutput(intent.id, 1, { stageInstanceId: 'si-req', content: 'hello ' });
    seedOutput(intent.id, 2, { stageInstanceId: 'si-req', content: 'world' });
    const dto = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(dto.outputs).toEqual([]);
    // The rest of the DTO is unaffected by transcript volume.
    expect(dto.intent.id).toBe(intent.id);
  });

  const getOutputs = (sub, projectId, intentId, qs = null) =>
    handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intentId}/outputs`,
      pathParameters: { projectId, intentId },
      queryStringParameters: qs,
      ...claims(sub),
    });

  it('GET /outputs returns the transcript, filterable by stage and afterSeq', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedOutput(intent.id, 1, { stageInstanceId: null, content: 'init-ws ' });
    seedOutput(intent.id, 2, {
      stageInstanceId: 'si-req',
      content: 'req-a ',
      display: { type: 'message', title: 'Req A' },
    });
    seedOutput(intent.id, 3, { stageInstanceId: 'si-req', content: 'req-b' });

    // Unfiltered: everything in seq order.
    const all = JSON.parse((await getOutputs(sub, projectId, intent.id)).body);
    expect(all.outputs.map((o) => o.seq)).toEqual([1, 2, 3]);

    // Per-stage pane.
    const stage = JSON.parse(
      (await getOutputs(sub, projectId, intent.id, { stageInstanceId: 'si-req' })).body,
    );
    expect(stage.outputs.map((o) => o.content)).toEqual(['req-a ', 'req-b']);
    expect(stage.outputs[0].display).toEqual({ type: 'message', title: 'Req A' });
    expect(stage.outputs[1].display).toBeUndefined();

    // "intent" selects the stage-less workspace/init bucket.
    const ws = JSON.parse(
      (await getOutputs(sub, projectId, intent.id, { stageInstanceId: 'intent' })).body,
    );
    expect(ws.outputs.map((o) => o.seq)).toEqual([1]);
    expect(ws.outputs[0].stageInstanceId).toBeNull();

    // afterSeq cursor (incremental catch-up).
    const tail = JSON.parse(
      (await getOutputs(sub, projectId, intent.id, { stageInstanceId: 'si-req', afterSeq: '2' }))
        .body,
    );
    expect(tail.outputs.map((o) => o.seq)).toEqual([3]);

    // Malformed cursor is a 400, not a scan.
    const bad = await getOutputs(sub, projectId, intent.id, { afterSeq: 'x' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /outputs 404s across projects (membership enforced)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProject = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await getOutputs(sub, otherProject, intent.id);
    expect(res.statusCode).toBe(404);
  });

  it('attaches per-sample cost to metrics, joining the stage-row model', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const si = 'si-cost';
    // A stage row carrying the resolved model, and two metric samples: one with
    // its own model stamp (preferred), one relying on the stage-row join.
    procStore.set(keyOf(`EXEC#${intent.id}`, `STAGE#${si}`), {
      pk: `EXEC#${intent.id}`,
      sk: `STAGE#${si}`,
      type: 'Stage',
      executionId: intent.id,
      stageInstanceId: si,
      state: 'SUCCEEDED',
      resolvedModel: 'us.anthropic.claude-sonnet-4-6',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, `METRIC#2026-01-01T00:00:00Z#m1`), {
      pk: `EXEC#${intent.id}`,
      sk: `METRIC#2026-01-01T00:00:00Z#m1`,
      type: 'Metric',
      executionId: intent.id,
      stageInstanceId: si,
      metricId: 'm1',
      resolvedModel: 'us.anthropic.claude-sonnet-4-6',
      metrics: { tokensInput: 1_000_000, tokensOutput: 1_000_000, contextWindowPct: 40 },
      timestamp: '2026-01-01T00:00:00Z',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, `METRIC#2026-01-01T00:00:01Z#m2`), {
      pk: `EXEC#${intent.id}`,
      sk: `METRIC#2026-01-01T00:00:01Z#m2`,
      type: 'Metric',
      executionId: intent.id,
      stageInstanceId: si,
      metricId: 'm2',
      // No own stamp — model must be joined from the stage row.
      metrics: { tokensInput: 500_000 },
      timestamp: '2026-01-01T00:00:01Z',
    });
    const dto = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    const byId = Object.fromEntries(dto.metrics.map((m) => [m.metricId, m]));
    // Sonnet 4.6 = $3/1M in, $15/1M out → 1M+1M = $18. Priced from the fallback.
    expect(byId.m1.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(byId.m1.cost.priced).toBe(true);
    expect(byId.m1.cost.totalCost).toBeCloseTo(18);
    // m2 joined the stage-row model and priced 0.5M input tokens at $3/1M = $1.5.
    expect(byId.m2.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(byId.m2.cost.totalCost).toBeCloseTo(1.5);
  });

  it('rolls project metrics up across intents (tokens sum, context peaks)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const a = JSON.parse((await createIntent(sub, projectId)).body).id;
    const b = JSON.parse((await createIntent(sub, projectId)).body).id;
    const seedMetric = (intentId, id, metrics, model = 'us.anthropic.claude-sonnet-4-6') =>
      procStore.set(keyOf(`EXEC#${intentId}`, `METRIC#2026-01-01T00:00:0${id}Z#${id}`), {
        pk: `EXEC#${intentId}`,
        sk: `METRIC#2026-01-01T00:00:0${id}Z#${id}`,
        type: 'Metric',
        executionId: intentId,
        stageInstanceId: 'si',
        metricId: id,
        resolvedModel: model,
        metrics,
        timestamp: `2026-01-01T00:00:0${id}Z`,
      });
    seedMetric(a, '1', { tokensInput: 1_000_000, tokensOutput: 0, contextWindowPct: 40 });
    seedMetric(b, '2', { tokensInput: 1_000_000, tokensOutput: 0, contextWindowPct: 80 });

    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/metrics`,
      pathParameters: { projectId },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const dto = JSON.parse(res.body);
    expect(dto.perIntent).toHaveLength(2);
    // Tokens sum across intents; context window is peaked (NOT summed to 120%).
    expect(dto.project.metrics.tokensInput).toBe(2_000_000);
    expect(dto.project.metrics.contextWindowPct).toBe(80);
    // 2M input tokens of Sonnet at $3/1M = $6.
    expect(dto.project.cost.totalCost).toBeCloseTo(6);
    expect(dto.project.cost.anyUnpriced).toBe(false);
  });

  it('flags anyUnpriced when an intent ran on an unpriceable model', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const a = JSON.parse((await createIntent(sub, projectId)).body).id;
    // Kiro credit-based model — not token-priceable.
    procStore.set(keyOf(`EXEC#${a}`, `METRIC#2026-01-01T00:00:01Z#k1`), {
      pk: `EXEC#${a}`,
      sk: `METRIC#2026-01-01T00:00:01Z#k1`,
      type: 'Metric',
      executionId: a,
      stageInstanceId: 'si',
      metricId: 'k1',
      resolvedModel: 'claude-opus-4.6',
      metrics: { tokensInput: 500_000 },
      timestamp: '2026-01-01T00:00:01Z',
    });
    const dto = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/metrics`,
          pathParameters: { projectId },
          ...claims(sub),
        })
      ).body,
    );
    expect(dto.project.cost.anyUnpriced).toBe(true);
  });

  it('prices a Kiro credits sample at its stamped rate and covers the token sample', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const si = 'si-kiro';
    // The agent's self-reported token sample (Kiro id — not token-priceable) …
    procStore.set(keyOf(`EXEC#${intent.id}`, `METRIC#2026-01-01T00:00:01Z#t1`), {
      pk: `EXEC#${intent.id}`,
      sk: `METRIC#2026-01-01T00:00:01Z#t1`,
      type: 'Metric',
      executionId: intent.id,
      stageInstanceId: si,
      metricId: 't1',
      resolvedModel: 'claude-opus-4.6',
      metrics: { tokensInput: 500_000, tokensOutput: 20_000 },
      timestamp: '2026-01-01T00:00:01Z',
    });
    // … plus the runner's credits sample, stamped with the $/credit rate.
    procStore.set(keyOf(`EXEC#${intent.id}`, `METRIC#2026-01-01T00:00:02Z#c1`), {
      pk: `EXEC#${intent.id}`,
      sk: `METRIC#2026-01-01T00:00:02Z#c1`,
      type: 'Metric',
      executionId: intent.id,
      stageInstanceId: si,
      metricId: 'c1',
      resolvedModel: 'claude-opus-4.6',
      creditRate: 0.04,
      metrics: { credits: 12.5 },
      timestamp: '2026-01-01T00:00:02Z',
    });
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    const byId = Object.fromEntries(detail.metrics.map((m) => [m.metricId, m]));
    // Credits price as an estimate: 12.5 × $0.04 = $0.50.
    expect(byId.c1.cost.priced).toBe(true);
    expect(byId.c1.cost.estimated).toBe(true);
    expect(byId.c1.cost.totalCost).toBeCloseTo(0.5);
    // The Kiro token sample itself is still unpriced (credits are the spend).
    expect(byId.t1.cost.priced).toBe(false);

    // Rollup: the credit-priced sample covers the same stage's token sample, so
    // the intent is priced (estimated) — not flagged anyUnpriced.
    const dto = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/metrics`,
          pathParameters: { projectId },
          ...claims(sub),
        })
      ).body,
    );
    const mine = dto.perIntent.find((p) => p.intentId === intent.id);
    expect(mine.cost.priced).toBe(true);
    expect(mine.cost.estimated).toBe(true);
    expect(mine.cost.totalCost).toBeCloseTo(0.5);
    expect(mine.metrics.credits).toBeCloseTo(12.5);
    expect(dto.project.cost.anyUnpriced).toBe(false);
    expect(dto.project.cost.anyEstimated).toBe(true);
  });

  it('leaves a rate-less credits sample unpriced (anyUnpriced stays true)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    procStore.set(keyOf(`EXEC#${intent.id}`, `METRIC#2026-01-01T00:00:01Z#c1`), {
      pk: `EXEC#${intent.id}`,
      sk: `METRIC#2026-01-01T00:00:01Z#c1`,
      type: 'Metric',
      executionId: intent.id,
      stageInstanceId: 'si',
      metricId: 'c1',
      resolvedModel: 'claude-opus-4.6',
      // No creditRate — /usage rate could not be captured.
      metrics: { credits: 3 },
      timestamp: '2026-01-01T00:00:01Z',
    });
    const dto = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/metrics`,
          pathParameters: { projectId },
          ...claims(sub),
        })
      ).body,
    );
    expect(dto.project.cost.anyUnpriced).toBe(true);
    expect(dto.project.cost.anyEstimated).toBe(false);
  });

  it('404s a cross-project intent on GET detail', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProjectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    // Same member, but the intent does not belong to otherProjectId.
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${otherProjectId}/intents/${intent.id}`,
      pathParameters: { projectId: otherProjectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /graph returns the knowledge subgraph (empty pre-start, populated after)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);

    // Before init-ws there is no Intent vertex — an empty graph, not an error.
    const pre = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/graph`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(pre.statusCode).toBe(200);
    expect(JSON.parse(pre.body)).toEqual({ nodes: [], edges: [] });

    // Seed the anchor + one artifact (what init-ws + a stage would write).
    await g.addV('Intent').property('id', intent.id).property('title', 'T').next();
    await g
      .addV('Artifact')
      .property('id', 'a1')
      .property('intent_id', intent.id)
      .property('artifact_type', 'requirements-analysis')
      .property('title', 'Reqs')
      .property('content', '# hi')
      .next();
    await g
      .V()
      .has('Intent', 'id', intent.id)
      .addE('CONTAINS')
      .to(gremlin.process.statics.V().has('Artifact', 'id', 'a1'))
      .next();

    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/graph`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const graph = JSON.parse(res.body);
    expect(graph.nodes.map((n) => n.type).toSorted()).toEqual(['Artifact', 'Intent']);
    expect(graph.edges).toContainEqual({ source: intent.id, target: 'a1', label: 'CONTAINS' });
  });

  it('404s GET /graph for a cross-project intent', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProjectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${otherProjectId}/intents/${intent.id}/graph`,
      pathParameters: { projectId: otherProjectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });

  it('list filters by status and returns newest-first', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    await createIntent(sub, projectId);
    await createIntent(sub, projectId);
    // All are DRAFT at create.
    const drafts = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents`,
      pathParameters: { projectId },
      queryStringParameters: { status: 'DRAFT' },
      ...claims(sub),
    });
    expect(drafts.statusCode).toBe(200);
    expect(JSON.parse(drafts.body)).toHaveLength(2);
    // A status nothing matches yields an empty list (proves the filter applies).
    const running = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents`,
      pathParameters: { projectId },
      queryStringParameters: { status: 'RUNNING' },
      ...claims(sub),
    });
    expect(JSON.parse(running.body)).toEqual([]);
  });
});

describe('POST /start — preconditions', () => {
  it('400s when the intent has no prompt', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId, { title: 'No prompt' })).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('404s starting an intent that does not belong to the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProjectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${otherProjectId}/intents/${intent.id}/start`,
      pathParameters: { projectId: otherProjectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s a non-member', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(`outsider-${randomUUID()}`),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /gates/{humanTaskId}/answer', () => {
  it('answers a pending gate (CAS) and resumes the durable callback when bound', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const humanTaskId = `h-${randomUUID()}`;
    const artifactId = `a-${randomUUID()}`;
    seedGate(intent.id, humanTaskId, { status: 'pending', callbackId: 'cb-h1' });
    await g
      .addV('Intent')
      .property('id', intent.id)
      .property('project_id', projectId)
      .property('title', 'Intent')
      .next();
    await g
      .addV('Question')
      .property('id', humanTaskId)
      .property('intent_id', intent.id)
      .property('stage_instance_id', 'si-req')
      .property('questions', '[{"text":"?"}]')
      .as('q')
      .V()
      .has('Intent', 'id', intent.id)
      .addE('CONTAINS')
      .to('q')
      .next();
    await g
      .addV('Artifact')
      .property('id', artifactId)
      .property('intent_id', intent.id)
      .property('artifact_type', 'requirements-analysis')
      .property('title', 'Requirements')
      .property('created_by_stage_instance_id', 'si-req')
      .as('a')
      .V()
      .has('Intent', 'id', intent.id)
      .addE('CONTAINS')
      .to('a')
      .next();

    const res = await answerGate(sub, projectId, intent.id, humanTaskId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('answered');
    expect(
      await g
        .V()
        .has('Question', 'id', humanTaskId)
        .out('INFLUENCES')
        .has('id', artifactId)
        .hasNext(),
    ).toBe(true);
    const question = await g.V().has('Question', 'id', humanTaskId).valueMap().next();
    expect(question.value.get('answered_by_name')[0]).toBe(`${sub}@x`);

    const detail = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    const event = JSON.parse(detail.body).events.find((e) => e.type === 'v2.question.answered');
    expect(event).toMatchObject({
      humanTaskId,
      answeredByName: `${sub}@x`,
      artifacts: [{ id: artifactId, title: 'Requirements' }],
    });
    // The gate carries a callbackId → the suspended orchestrator is resumed via
    // SendDurableExecutionCallbackSuccess (NOT a fresh Invoke).
    const cbCalls = lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand);
    expect(cbCalls).toHaveLength(1);
    expect(cbCalls[0].args[0].input.CallbackId).toBe('cb-h1');
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('does NOT resume when answering a sibling gate without a callbackId (D3)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h-sibling', { status: 'pending', callbackId: null });

    const res = await answerGate(sub, projectId, intent.id, 'h-sibling');
    expect(res.statusCode).toBe(200);
    expect(lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(0);
  });

  it('409s a double-answer of the same gate (CAS on pending)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });

    expect((await answerGate(sub, projectId, intent.id, 'h1')).statusCode).toBe(200);
    expect((await answerGate(sub, projectId, intent.id, 'h1')).statusCode).toBe(409);
  });

  it('repairs WAITING to FAILED when the durable callback has expired', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const metaKey = keyOf(`EXEC#${intent.id}`, 'META');
    procStore.set(metaKey, {
      ...procStore.get(metaKey),
      status: 'WAITING',
      pendingHumanTaskId: 'h1',
      orchestratorRunId: 'run-old',
    });
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    const expired = new Error('callback timed out');
    expired.name = 'CallbackTimeoutException';
    lambdaMock.on(SendDurableExecutionCallbackSuccessCommand).rejectsOnce(expired);

    const res = await answerGate(sub, projectId, intent.id, 'h1');

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'durable_execution_expired' });
    expect(procStore.get(metaKey)).toMatchObject({
      status: 'FAILED',
      pendingHumanTaskId: null,
      failureReason: 'durable_callback_expired',
      orchestratorRunId: 'run-old',
    });
    expect(
      [...procStore.values()].some(
        (row) => row.type === 'Event' && row.eventType === 'v2.execution.repaired',
      ),
    ).toBe(true);
  });

  it('returns 503 and records an event when callback resume fails unexpectedly', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const metaKey = keyOf(`EXEC#${intent.id}`, 'META');
    procStore.set(metaKey, {
      ...procStore.get(metaKey),
      status: 'WAITING',
      pendingHumanTaskId: 'h1',
    });
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    lambdaMock
      .on(SendDurableExecutionCallbackSuccessCommand)
      .rejectsOnce(Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }));

    const res = await answerGate(sub, projectId, intent.id, 'h1');

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'durable_callback_resume_failed',
      retryable: true,
    });
    expect(procStore.get(metaKey).status).toBe('WAITING');
    expect(
      [...procStore.values()].some(
        (row) => row.type === 'Event' && row.eventType === 'v2.gate.resume_failed',
      ),
    ).toBe(true);
  });

  it('404s an unknown gate', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await answerGate(sub, projectId, intent.id, 'h-missing');
    expect(res.statusCode).toBe(404);
  });
});

describe('realtime-token — denial paths', () => {
  it('403s a non-member', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/realtime-token`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(`outsider-${randomUUID()}`),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an intent that does not belong to the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const otherProjectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${otherProjectId}/intents/${intent.id}/realtime-token`,
      pathParameters: { projectId: otherProjectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('durable execution watchdog', () => {
  it('repairs stale active intents whose durable execution is terminal', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const stale = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'Stale',
          prompt: 'Build stale',
          scope: 'feature',
        })
      ).body,
    );
    const live = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'Live',
          prompt: 'Build live',
          scope: 'feature',
        })
      ).body,
    );
    const oldExpiry = '2024-01-01T00:00:00.000Z';
    procStore.set(keyOf(`EXEC#${stale.id}`, 'META'), {
      ...procStore.get(keyOf(`EXEC#${stale.id}`, 'META')),
      status: 'WAITING',
      pendingHumanTaskId: 'h-stale',
      orchestratorRunId: 'run-stale',
      orchestratorExpiresAt: oldExpiry,
      durableExecutionArn: 'arn:aws:lambda:durable:stale',
    });
    procStore.set(keyOf(`EXEC#${live.id}`, 'META'), {
      ...procStore.get(keyOf(`EXEC#${live.id}`, 'META')),
      status: 'WAITING',
      pendingHumanTaskId: 'h-live',
      orchestratorRunId: 'run-live',
      orchestratorExpiresAt: oldExpiry,
      durableExecutionArn: 'arn:aws:lambda:durable:live',
    });
    ddbMock.on(ScanCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      return {
        Items: [...procStore.values()]
          .filter((i) => i.sk === values[':meta'])
          .map((i) => ({ ...i })),
      };
    });
    let durableLookup = 0;
    lambdaMock.on(GetDurableExecutionCommand).callsFake(() => ({
      Status: durableLookup++ === 0 ? 'TIMED_OUT' : 'RUNNING',
    }));

    const out = await handler({
      action: 'repair-durable-executions',
      candidates: [
        procStore.get(keyOf(`EXEC#${stale.id}`, 'META')),
        procStore.get(keyOf(`EXEC#${live.id}`, 'META')),
      ],
    });

    expect(out).toMatchObject({ checked: 2, repaired: 1, skipped: 1 });
    expect(procStore.get(keyOf(`EXEC#${stale.id}`, 'META'))).toMatchObject({
      status: 'FAILED',
      pendingHumanTaskId: null,
      failureReason: 'durable_callback_expired',
    });
    expect(procStore.get(keyOf(`EXEC#${live.id}`, 'META'))).toMatchObject({
      status: 'WAITING',
      pendingHumanTaskId: 'h-live',
    });
  });
});

// ── Steering (docs/v2-steering.md) ──

const setStatus = (intentId, patch) => {
  const k = keyOf(`EXEC#${intentId}`, 'META');
  procStore.set(k, { ...procStore.get(k), ...patch });
};

const seedIntentAnchor = (intentId) =>
  g.addV('Intent').property('id', intentId).property('title', 'Intent').next();

describe('POST /gates/{id}/answer with steering', () => {
  it('records a gate-steer STEER row + Steering vertex and still resumes the callback', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await seedIntentAnchor(intent.id);
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });

    const res = await answerGate(sub, projectId, intent.id, 'h1', {
      answer: { ok: 1 },
      steering: 'Stop building REST — integrate with the event bus instead.',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('answered');
    expect(body.steering).toMatchObject({
      kind: 'gate-steer',
      status: 'pending',
      targetGateId: 'h1',
      message: 'Stop building REST — integrate with the event bus instead.',
    });
    // The callback resume still fires (answer + steering ride together).
    expect(lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(1);
    // STEER row surfaces on the detail DTO; the recorded event is in the feed.
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(detail.steering).toHaveLength(1);
    expect(detail.steering[0]).toMatchObject({ kind: 'gate-steer', status: 'pending' });
    expect(detail.events.some((e) => e.type === 'v2.steering.recorded')).toBe(true);
    // Neptune mirror: Steering vertex anchored to the Intent.
    expect(
      await g
        .V()
        .has('Intent', 'id', intent.id)
        .out('CONTAINS')
        .hasLabel('Steering')
        .has('kind', 'gate-steer')
        .hasNext(),
    ).toBe(true);
  });

  it('a plain answer records NO steering row', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending' });
    const res = await answerGate(sub, projectId, intent.id, 'h1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).steering).toBeNull();
    const steerRows = [...procStore.keys()].filter((k) => k.includes('|STEER#'));
    expect(steerRows).toHaveLength(0);
  });
});

describe('POST /gates/{id}/revise', () => {
  const revise = (sub, projectId, intentId, humanTaskId, message) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/gates/${humanTaskId}/revise`,
      pathParameters: { projectId, intentId, humanTaskId },
      body: JSON.stringify({ message }),
      ...claims(sub),
    });

  it('layers a revision STEER row on an answered gate (original answer immutable)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await seedIntentAnchor(intent.id);
    await g
      .addV('Question')
      .property('id', 'h1')
      .property('intent_id', intent.id)
      .property('questions', '[{"text":"?"}]')
      .as('q')
      .V()
      .has('Intent', 'id', intent.id)
      .addE('CONTAINS')
      .to('q')
      .next();
    seedGate(intent.id, 'h1', { status: 'pending' });
    await answerGate(sub, projectId, intent.id, 'h1', { answer: { freeText: 'use REST' } });
    setStatus(intent.id, { status: 'RUNNING' });

    const res = await revise(sub, projectId, intent.id, 'h1', 'Actually: use the event bus.');
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      kind: 'revision',
      status: 'pending',
      targetGateId: 'h1',
      delivery: 'next-stage-start',
    });
    // The gate carries the revision marker; the original answer is untouched.
    const gateRow = procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1'));
    expect(gateRow.revisionSteerId).toBe(body.steerId);
    expect(gateRow.answer).toEqual({ freeText: 'use REST' });
    // Graph: Steering --REVISES--> Question.
    expect(
      await g
        .V()
        .has('Steering', 'id', body.steerId)
        .out('REVISES')
        .has('Question', 'id', 'h1')
        .hasNext(),
    ).toBe(true);
  });

  it('reports next-resume delivery for a WAITING run', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending' });
    await answerGate(sub, projectId, intent.id, 'h1');
    setStatus(intent.id, { status: 'WAITING' });
    const res = await revise(sub, projectId, intent.id, 'h1', 'correction');
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).delivery).toBe('next-resume');
  });

  it('409s revising a still-pending gate (answer it instead)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending' });
    const res = await revise(sub, projectId, intent.id, 'h1', 'correction');
    expect(res.statusCode).toBe(409);
  });

  it('409s revising after the intent SUCCEEDED (nothing left to steer)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending' });
    await answerGate(sub, projectId, intent.id, 'h1');
    setStatus(intent.id, { status: 'SUCCEEDED' });
    const res = await revise(sub, projectId, intent.id, 'h1', 'correction');
    expect(res.statusCode).toBe(409);
  });

  it('400s an empty message', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'answered' });
    const res = await revise(sub, projectId, intent.id, 'h1', '   ');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cancel', () => {
  const cancel = (sub, projectId, intentId) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/cancel`,
      pathParameters: { projectId, intentId },
      ...claims(sub),
    });

  it('retires a WAITING run: supersedes pending gates, wakes the callback, flips CANCELLED', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    setStatus(intent.id, { status: 'WAITING', pendingHumanTaskId: 'h1' });

    const res = await cancel(sub, projectId, intent.id);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('CANCELLED');
    // The gate is superseded (never answered) and the suspended orchestrator was
    // woken with the cancel sentinel so it can exit quietly.
    const gateRow = procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1'));
    expect(gateRow.status).toBe('superseded');
    const cb = lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand);
    expect(cb).toHaveLength(1);
    expect(JSON.parse(Buffer.from(cb[0].args[0].input.Result).toString())).toMatchObject({
      cancelled: true,
    });
  });

  it.each(['RUNNING', 'DRAFT', 'SUCCEEDED', 'CANCELLED'])(
    '409s cancelling a %s run',
    async (status) => {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, { status });
      const res = await cancel(sub, projectId, intent.id);
      expect(res.statusCode).toBe(409);
    },
  );

  it('stops the intent runtime session (best-effort) so the cancelled run frees its microVM', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, { status: 'WAITING' });
      const res = await cancel(sub, projectId, intent.id);
      expect(res.statusCode).toBe(200);
      const stops = agentcoreMock.commandCalls(StopRuntimeSessionCommand);
      expect(stops).toHaveLength(1);
      expect(stops[0].args[0].input.runtimeSessionId.startsWith(`aidlc-intent-${intent.id}`)).toBe(
        true,
      );
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });
});

describe('DELETE /projects/{id}/intents/{intentId}', () => {
  const del = (sub, projectId, intentId) =>
    handler({
      httpMethod: 'DELETE',
      path: `/projects/${projectId}/intents/${intentId}`,
      pathParameters: { projectId, intentId },
      ...claims(sub),
    });

  const addMember = async (projectId, sub, role) => {
    await g.addV('User').property('id', sub).property('email', `${sub}@x`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_MEMBER')
      .property('role', role)
      .to(gremlin.process.statics.V().has('User', 'id', sub))
      .next();
  };

  it('deletes a DRAFT intent (no Neptune anchor yet) — 204 and the META row is gone', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);

    const res = await del(sub, projectId, intent.id);
    expect(res.statusCode).toBe(204);
    expect(procStore.has(keyOf(`EXEC#${intent.id}`, 'META'))).toBe(false);
    // Idempotent from the caller's view: the intent no longer exists.
    const again = await del(sub, projectId, intent.id);
    expect(again.statusCode).toBe(404);
  });

  it('cascades the Neptune subgraph, drains the DDB partition and removes the Yjs docs', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const intentId = intent.id;
    // Graph: anchor + CONTAINS artifact + a discussion thread with a message.
    await seedIntentAnchor(intentId);
    await g
      .addV('Artifact')
      .property('id', `a-${intentId}`)
      .property('intent_id', intentId)
      .as('a')
      .V()
      .has('Intent', 'id', intentId)
      .addE('CONTAINS')
      .to('a')
      .next();
    await g
      .addV('Discussion')
      .property('id', `d-${intentId}`)
      .as('d')
      .addV('DiscussionMessage')
      .property('id', `m-${intentId}`)
      .as('m')
      .V()
      .has('Intent', 'id', intentId)
      .addE('HAS_DISCUSSION')
      .to('d')
      .select('d')
      .addE('HAS_MESSAGE')
      .to('m')
      .next();
    // Process rows beyond META: an answered gate + an output chunk.
    seedGate(intentId, 'h1', { status: 'answered' });
    procStore.set(keyOf(`EXEC#${intentId}`, 'OUTPUT#000000000001'), {
      pk: `EXEC#${intentId}`,
      sk: 'OUTPUT#000000000001',
      seq: 1,
      content: 'x',
    });
    // Intent-scoped realtime docs (+ one unrelated doc that must survive).
    yjsStore.set(`intent-presence-${intentId}`, {});
    yjsStore.set(`intent-sq-${intentId}-h1`, {});
    yjsStore.set(`intent-review-${intentId}-h1`, {});
    yjsStore.set(`intent-discussion-${intentId}-d-${intentId}`, {});
    yjsStore.set('unrelated-doc', {});
    setStatus(intentId, { status: 'SUCCEEDED' });

    const res = await del(sub, projectId, intentId);
    expect(res.statusCode).toBe(204);
    // Neptune: anchor + everything it contained is gone.
    expect(await g.V().has('Intent', 'id', intentId).hasNext()).toBe(false);
    expect(await g.V().has('Artifact', 'id', `a-${intentId}`).hasNext()).toBe(false);
    expect(await g.V().has('Discussion', 'id', `d-${intentId}`).hasNext()).toBe(false);
    expect(await g.V().has('DiscussionMessage', 'id', `m-${intentId}`).hasNext()).toBe(false);
    // DynamoDB: the whole EXEC# partition is drained.
    const leftover = [...procStore.keys()].filter((k) => k.startsWith(`EXEC#${intentId}|`));
    expect(leftover).toEqual([]);
    // Yjs: only the intent-scoped docs are removed.
    expect([...yjsStore.keys()]).toEqual(['unrelated-doc']);
  });

  it('cascade sweeps the derived layer AND spares a sibling intent that shares an artifact id', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const victim = JSON.parse((await createIntent(sub, projectId)).body).id;
    const sibling = JSON.parse((await createIntent(sub, projectId)).body).id;
    await seedIntentAnchor(victim);
    await seedIntentAnchor(sibling);

    // Both intents own an Artifact with the SAME agent-chosen id 'requirements'
    // (the field-incident collision), each with a Section + a Story hanging off
    // it. Distinct vertices only because intent_id differs.
    const seedArtifactWithDerived = async (intentId) => {
      await g
        .addV('Artifact')
        .property('id', 'requirements')
        .property('intent_id', intentId)
        .property('artifact_type', 'requirements')
        .as('a')
        .V()
        .has('Intent', 'id', intentId)
        .addE('CONTAINS')
        .to('a')
        .next();
      await g
        .addV('Section')
        .property('id', 'section:requirements:overview')
        .property('intent_id', intentId)
        .as('sec')
        .V()
        .has('Artifact', 'id', 'requirements')
        .has('intent_id', intentId)
        .addE('HAS_SECTION')
        .to('sec')
        .next();
      await g
        .addV('Story')
        .property('id', `story:${intentId}:s-login`)
        .property('intent_id', intentId)
        .as('it')
        .V()
        .has('Artifact', 'id', 'requirements')
        .has('intent_id', intentId)
        .addE('HAS_ITEM')
        .to('it')
        .next();
    };
    await seedArtifactWithDerived(victim);
    await seedArtifactWithDerived(sibling);
    setStatus(victim, { status: 'SUCCEEDED' });

    const res = await del(sub, projectId, victim);
    expect(res.statusCode).toBe(204);

    // Victim's whole subtree is gone — including the derived layer (no orphan
    // leak: the previous cascade left Section/Story behind).
    expect(
      await g.V().has('Artifact', 'id', 'requirements').has('intent_id', victim).hasNext(),
    ).toBe(false);
    expect(
      await g
        .V()
        .has('Section', 'id', 'section:requirements:overview')
        .has('intent_id', victim)
        .hasNext(),
    ).toBe(false);
    expect(await g.V().has('Story', 'id', `story:${victim}:s-login`).hasNext()).toBe(false);

    // The sibling's same-id artifact and its derived layer SURVIVE intact.
    expect(
      await g.V().has('Artifact', 'id', 'requirements').has('intent_id', sibling).hasNext(),
    ).toBe(true);
    expect(
      await g
        .V()
        .has('Section', 'id', 'section:requirements:overview')
        .has('intent_id', sibling)
        .hasNext(),
    ).toBe(true);
    expect(await g.V().has('Story', 'id', `story:${sibling}:s-login`).hasNext()).toBe(true);
  });

  it('retires a WAITING run first: supersedes the pending gate and wakes the callback', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await seedIntentAnchor(intent.id);
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    setStatus(intent.id, { status: 'WAITING', pendingHumanTaskId: 'h1' });

    const res = await del(sub, projectId, intent.id);
    expect(res.statusCode).toBe(204);
    // The suspended orchestrator was woken with the cancel sentinel so it can
    // exit quietly instead of writing into the deleted partition.
    const cb = lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand);
    expect(cb).toHaveLength(1);
    expect(JSON.parse(Buffer.from(cb[0].args[0].input.Result).toString())).toMatchObject({
      cancelled: true,
    });
    expect(procStore.has(keyOf(`EXEC#${intent.id}`, 'META'))).toBe(false);
  });

  it('409s deleting a RUNNING run (live orchestrator + agent session)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'RUNNING' });
    const res = await del(sub, projectId, intent.id);
    expect(res.statusCode).toBe(409);
    expect(procStore.has(keyOf(`EXEC#${intent.id}`, 'META'))).toBe(true);
  });

  it('403s a plain member (owner/admin only); admin may delete', async () => {
    const owner = `u-${randomUUID()}`;
    const projectId = await seedV2Project(owner);
    const intent = JSON.parse((await createIntent(owner, projectId)).body);
    const member = `u-${randomUUID()}`;
    await addMember(projectId, member, 'member');
    const denied = await del(member, projectId, intent.id);
    expect(denied.statusCode).toBe(403);
    expect(procStore.has(keyOf(`EXEC#${intent.id}`, 'META'))).toBe(true);

    const admin = `u-${randomUUID()}`;
    await addMember(projectId, admin, 'admin');
    const allowed = await del(admin, projectId, intent.id);
    expect(allowed.statusCode).toBe(204);
  });

  it('404s an intent that belongs to a different project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectA = await seedV2Project(sub);
    const projectB = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectA)).body);
    const res = await del(sub, projectB, intent.id);
    expect(res.statusCode).toBe(404);
    expect(procStore.has(keyOf(`EXEC#${intent.id}`, 'META'))).toBe(true);
  });
});

describe('POST /derive — manual graph-projection backfill', () => {
  // The route sits behind BOTH gates: project membership (like every intent
  // route) AND the platform-admin group.
  const adminClaims = (sub) => ({
    requestContext: {
      authorizer: { claims: { sub, email: `${sub}@x`, 'cognito:groups': 'platform-admin' } },
    },
  });
  const derive = (claimsBag, projectId, intentId) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/derive`,
      pathParameters: { projectId, intentId },
      body: null,
      ...claimsBag,
    });
  const seedMeta = (projectId, intentId, extra = {}) => {
    procStore.set(keyOf(`EXEC#${intentId}`, 'META'), {
      pk: `EXEC#${intentId}`,
      sk: 'META',
      type: 'Execution',
      executionId: intentId,
      intentId,
      projectId,
      status: 'WAITING',
      ...extra,
    });
  };

  beforeEach(() => {
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu:1:runtime/x');
  });

  it('requires platform admin (a plain project owner is refused)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedMeta(projectId, 'i-plain');
    const res = await derive(claims(sub), projectId, 'i-plain');
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
  });

  it('refuses while RUNNING and 404s a project mismatch', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedMeta(projectId, 'i-run', { status: 'RUNNING' });
    expect((await derive(adminClaims(sub), projectId, 'i-run')).statusCode).toBe(409);
    seedMeta('another-project', 'i-other');
    expect((await derive(adminClaims(sub), projectId, 'i-other')).statusCode).toBe(404);
  });

  it('dispatches derive-artifacts to the runtime with the META enrichment/CLI snapshot', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedMeta(projectId, 'i-done', {
      status: 'SUCCEEDED',
      deriveEnrichment: 'llm',
      agentCli: 'claude',
      cliModels: { claude: 'us.anthropic.claude-haiku-4-5' },
    });
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({
            ok: true,
            artifacts: ['a1'],
            sections: 2,
            items: 3,
            enrichment: 'llm',
            enriched: 1,
          }),
      },
    });
    const res = await derive(adminClaims(sub), projectId, 'i-done');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      artifacts: ['a1'],
      items: 3,
      enriched: 1,
    });
    const call = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(call.runtimeSessionId.startsWith('aidlc-intent-i-done')).toBe(true);
    expect(call.runtimeSessionId.length).toBeGreaterThanOrEqual(33);
    expect(JSON.parse(Buffer.from(call.payload).toString('utf8'))).toMatchObject({
      command: 'derive-artifacts',
      projectId,
      intentId: 'i-done',
      executionId: 'i-done',
      enrichment: 'llm',
      requestedCli: 'claude',
      cliModels: { claude: 'us.anthropic.claude-haiku-4-5' },
    });
  });

  it('maps a command-level failure to 422', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedMeta(projectId, 'i-fail', { status: 'FAILED' });
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({ ok: false, reason: 'derive_failed', detail: 'neptune down' }),
      },
    });
    const res = await derive(adminClaims(sub), projectId, 'i-fail');
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'derive_failed', detail: 'neptune down' });
  });
});

describe('POST /rewind', () => {
  // Two-stage plan for the pinned workflow (version 4, scope 'feature'):
  // design → implement, both led by the reserved 'orchestrator' ref so no AGENT
  // blocks are needed. Placement rows + catalog STAGE blocks feed the same
  // loadExecutionPlan the orchestrator uses.
  const seedPlan = () => {
    const placement = (stageId, order) =>
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${stageId}`,
        stageId,
        order,
        scopeMembership: { feature: 'EXECUTE' },
      });
    placement('design', 1);
    placement('implement', 2);
    const stageBlock = (stageId) =>
      procStore.set(keyOf(`BLOCK#${stageId}`, 'META'), {
        pk: `BLOCK#${stageId}`,
        sk: 'META',
        GSI1PK: 'TENANT#default#STAGE',
        GSI1SK: `NAME#${stageId}`,
        id: stageId,
        blockId: stageId,
        type: 'STAGE',
        version: 1,
        mode: 'inline',
        leadAgent: 'orchestrator',
        produces: [],
        consumes: [],
      });
    stageBlock('design');
    stageBlock('implement');
  };

  const siOf = (stageId) => planStageInstanceId('aidlc-v2@4', stageId);

  const seedStageRow = (intentId, stageId, state = 'SUCCEEDED') =>
    procStore.set(keyOf(`EXEC#${intentId}`, `STAGE#${siOf(stageId)}`), {
      pk: `EXEC#${intentId}`,
      sk: `STAGE#${siOf(stageId)}`,
      type: 'Stage',
      executionId: intentId,
      stageInstanceId: siOf(stageId),
      stageId,
      state,
      attempt: 0,
      cli: 'claude',
      cliSessionId: 'sess-1',
    });

  const rewind = (sub, projectId, intentId, body) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/rewind`,
      pathParameters: { projectId, intentId },
      body: JSON.stringify(body),
      ...claims(sub),
    });

  it('resets the target stage + downstream, supersedes their artifacts, relaunches at the stage', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'SUCCEEDED' });
    seedStageRow(intent.id, 'design');
    seedStageRow(intent.id, 'implement');
    await seedIntentAnchor(intent.id);
    const seedArtifact = async (id, stageId) => {
      await g
        .addV('Artifact')
        .property('id', id)
        .property('intent_id', intent.id)
        .property('artifact_type', 'doc')
        .property('title', id)
        .property('content', `content:${id}`)
        .property('created_at', '2026-01-01T00:00:00.000Z')
        .property('created_by_stage_instance_id', siOf(stageId))
        .as('a')
        .V()
        .has('Intent', 'id', intent.id)
        .addE('CONTAINS')
        .to('a')
        .next();
    };
    await seedArtifact('a-design', 'design');
    await seedArtifact('a-impl', 'implement');

    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance:
        'The implementation used REST; redo it against the event bus and revert the REST commits.',
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.intent.status).toBe('CREATED');
    expect(body.intent.rewindFromStageId).toBe('implement');
    expect(body.steering).toMatchObject({ kind: 'rewind', targetStageId: 'implement' });

    // The target stage is reset (attempt+1, session cleared); upstream is untouched.
    const implRow = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('implement')}`));
    expect(implRow).toMatchObject({ state: 'PENDING', attempt: 1, cliSessionId: null });
    const designRow = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('design')}`));
    expect(designRow.state).toBe('SUCCEEDED');

    // Only the reset stage's artifact is superseded (lineage kept, not deleted).
    const impl = await g.V().has('Artifact', 'id', 'a-impl').valueMap().next();
    expect(impl.value.get('superseded_at')).toBeDefined();
    const design = await g.V().has('Artifact', 'id', 'a-design').valueMap().next();
    expect(design.value.get('superseded_at')).toBeUndefined();

    // The prior head is immutable history, linked by deterministic generation.
    const archived = await g
      .V()
      .has('Artifact', 'id', 'a-impl')
      .out('HAS_VERSION')
      .valueMap()
      .next();
    expect(archived.value.get('id')[0]).toBe('a-impl:v1');
    expect(archived.value.get('content')[0]).toBe('content:a-impl');
    expect(archived.value.get('generation')[0]).toBe(1);

    // Normal detail excludes the superseded head while history remains
    // authenticated and read-only.
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(detail.artifacts.map((artifact) => artifact.id)).toEqual(['a-design']);
    const versionsRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/artifacts/a-impl/versions`,
      pathParameters: { projectId, intentId: intent.id, artifactId: 'a-impl' },
      ...claims(sub),
    });
    expect(versionsRes.statusCode).toBe(200);
    const versions = JSON.parse(versionsRes.body);
    expect(versions.current).toBeNull();
    expect(versions.versions[0]).toMatchObject({
      versionId: 'a-impl:v1',
      generation: 1,
      stageAttempt: 0,
      restartReason: expect.stringContaining('Rewind to implement'),
    });
    const versionRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/artifacts/a-impl/versions/a-impl%3Av1`,
      pathParameters: {
        projectId,
        intentId: intent.id,
        artifactId: 'a-impl',
        versionId: 'a-impl:v1',
      },
      ...claims(sub),
    });
    expect(versionRes.statusCode).toBe(200);
    expect(JSON.parse(versionRes.body)).toMatchObject({
      versionId: 'a-impl:v1',
      content: 'content:a-impl',
      current: false,
    });

    // Relaunched at the rewind point.
    const calls = orchestratorInvokes();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'implement' });
  });

  it('retires a parked WAITING run before relaunching (gate superseded + sentinel)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedStageRow(intent.id, 'design');
    seedStageRow(intent.id, 'implement', 'WAITING_FOR_HUMAN');
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    setStatus(intent.id, { status: 'WAITING', pendingHumanTaskId: 'h1' });

    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance: 'wrong direction',
    });
    expect(res.statusCode).toBe(202);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1')).status).toBe('superseded');
    const cb = lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand);
    expect(cb).toHaveLength(1);
    expect(JSON.parse(Buffer.from(cb[0].args[0].input.Result).toString())).toMatchObject({
      cancelled: true,
    });
    // META cleared of the pending gate pointer.
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).pendingHumanTaskId).toBeNull();
  });

  it('leaves restart state untouched and does not relaunch when archival fails', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedStageRow(intent.id, 'design');
    seedStageRow(intent.id, 'implement', 'WAITING_FOR_HUMAN');
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    setStatus(intent.id, { status: 'WAITING', pendingHumanTaskId: 'h1' });
    const metaBefore = structuredClone(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')));
    const stageBefore = structuredClone(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('implement')}`)),
    );
    const gateBefore = structuredClone(procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1')));
    archiveArtifactsSpy.mockRejectedValueOnce(new Error('archive unavailable'));

    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance: 'redo it',
    });

    expect(res.statusCode).toBe(500);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META'))).toEqual(metaBefore);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('implement')}`))).toEqual(
      stageBefore,
    );
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1'))).toEqual(gateBefore);
    expect(orchestratorInvokes()).toHaveLength(0);
    expect(lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(0);
    expect(agentcoreMock.commandCalls(StopRuntimeSessionCommand)).toHaveLength(0);
    expect([...procStore.keys()].filter((key) => key.includes('|STEER#'))).toHaveLength(0);
  });

  it('409s a rewind while RUNNING (steering is deterministic — wait for the stage)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'RUNNING' });
    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance: 'nope',
    });
    expect(res.statusCode).toBe(409);
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('400s an unknown stage, listing the plan stages', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'nonsense',
      guidance: 'x',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).stages).toEqual(['design', 'implement']);
  });

  it('accepts a guidance-less rewind as a plain retry (no steering row)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    seedStageRow(intent.id, 'design');
    seedStageRow(intent.id, 'implement', 'FAILED');
    setStatus(intent.id, { status: 'FAILED' });
    const res = await rewind(sub, projectId, intent.id, { fromStageId: 'implement' });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.intent.status).toBe('CREATED');
    expect(body.steering).toBeNull();
    // No STEER row — a retry injects nothing into the restarted stage.
    expect([...procStore.keys()].filter((k) => k.includes('|STEER#'))).toHaveLength(0);
    // The failed stage is reset for attempt 2; upstream is untouched.
    const implRow = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('implement')}`));
    expect(implRow).toMatchObject({ state: 'PENDING', attempt: 1 });
    const designRow = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('design')}`));
    expect(designRow.state).toBe('SUCCEEDED');
    // Relaunched at the retried stage.
    const calls = orchestratorInvokes();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'implement' });
  });

  it('leaves a failed relaunch recoverable instead of restoring WAITING on a superseded gate', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'WAITING', pendingHumanTaskId: 'h1' });
    seedStageRow(intent.id, 'implement', 'FAILED');
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });
    lambdaMock
      .on(InvokeCommand, { FunctionName: 'orchestrator-test' })
      .rejectsOnce(new Error('invoke failed'));
    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance: 'x',
    });
    expect(res.statusCode).toBe(500);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META'))).toMatchObject({
      status: 'FAILED',
      pendingHumanTaskId: null,
      failureReason: 'rewind_relaunch_failed',
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#h1')).status).toBe('superseded');
  });

  it('stops the intent runtime session BEFORE relaunching (zombie-session fix)', async () => {
    // Field incident: an image redeploy does not kill a live session — the
    // rewound run kept executing on the pre-fix microVM. The rewind must stop
    // the session so the relaunch starts fresh on the current image.
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedPlan();
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, { status: 'FAILED' });
      seedStageRow(intent.id, 'implement', 'FAILED');
      const res = await rewind(sub, projectId, intent.id, { fromStageId: 'implement' });
      expect(res.statusCode).toBe(202);
      const stops = agentcoreMock.commandCalls(StopRuntimeSessionCommand);
      expect(stops).toHaveLength(1);
      expect(stops[0].args[0].input.runtimeSessionId.startsWith(`aidlc-intent-${intent.id}`)).toBe(
        true,
      );
      // The relaunch still went out after the stop.
      expect(orchestratorInvokes()).toHaveLength(1);
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('a failed session stop never blocks the rewind (best-effort)', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedPlan();
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, { status: 'FAILED' });
      seedStageRow(intent.id, 'implement', 'FAILED');
      agentcoreMock.on(StopRuntimeSessionCommand).rejects(new Error('already stopped'));
      const res = await rewind(sub, projectId, intent.id, { fromStageId: 'implement' });
      expect(res.statusCode).toBe(202);
      expect(orchestratorInvokes()).toHaveLength(1);
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('409s a rewind to a stage the run scope does not EXECUTE (out-of-scope guard)', async () => {
    // Field incident follow-up: a rewind must not execute a stage the scope
    // excludes (e.g. brownfield-only reverse-engineering on a greenfield run).
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    // Placed in the workflow but SKIP for the run's 'feature' scope.
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#reverse-engineering'), {
      pk: 'WF#default#aidlc-v2',
      sk: 'V#4#PLACEMENT#reverse-engineering',
      stageId: 'reverse-engineering',
      order: 0,
      scopeMembership: { feature: 'SKIP', enterprise: 'EXECUTE' },
    });
    procStore.set(keyOf('BLOCK#reverse-engineering', 'META'), {
      pk: 'BLOCK#reverse-engineering',
      sk: 'META',
      GSI1PK: 'TENANT#default#STAGE',
      GSI1SK: 'NAME#reverse-engineering',
      id: 'reverse-engineering',
      blockId: 'reverse-engineering',
      type: 'STAGE',
      version: 1,
      mode: 'inline',
      leadAgent: 'orchestrator',
      produces: [],
      consumes: [],
    });
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    const res = await rewind(sub, projectId, intent.id, { fromStageId: 'reverse-engineering' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('not executed in scope');
    // Nothing was reset or relaunched.
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('still 400s a genuinely unknown rewind target (with the in-scope stage list)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    const res = await rewind(sub, projectId, intent.id, { fromStageId: 'no-such-stage' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).stages).toEqual(['design', 'implement']);
  });
});

// ── WP4: the unit dimension on the API surface (docs/v2-parallel.md) ─────────

describe('WP4 — unit lanes in the detail DTO', () => {
  it('surfaces unitPlan + units and lane attribution on stages/gates/events', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPLAN'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPLAN',
      type: 'UnitPlan',
      executionId: intent.id,
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'billing', dependsOn: ['auth'] },
      ],
      batches: [['auth'], ['billing']],
      unitCount: 2,
      skipMatrix: { billing: ['functional-design'] },
      walkingSkeleton: 'auth',
      autonomyMode: null,
      promotedAt: 'T',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNIT#auth'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNIT#auth',
      type: 'Unit',
      executionId: intent.id,
      slug: 'auth',
      dependsOn: [],
      state: 'MERGED',
      batchIndex: 0,
      branch: 'aidlc/i1',
      mergedAt: 'T2',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'STAGE#si-cg-auth'), {
      pk: `EXEC#${intent.id}`,
      sk: 'STAGE#si-cg-auth',
      type: 'Stage',
      executionId: intent.id,
      stageInstanceId: 'si-cg-auth',
      stageId: 'code-generation',
      unitSlug: 'auth',
      state: 'SUCCEEDED',
      pendingHumanTaskId: 'q-1',
    });
    seedGate(intent.id, 'q-1', { status: 'pending', stageInstanceId: 'si-cg-auth' });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'HUMAN#q-1'), {
      ...procStore.get(keyOf(`EXEC#${intent.id}`, 'HUMAN#q-1')),
      unitSlug: 'auth',
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'EVENT#T#e1'), {
      pk: `EXEC#${intent.id}`,
      sk: 'EVENT#T#e1',
      type: 'Event',
      executionId: intent.id,
      eventId: 'e1',
      eventType: 'v2.unit.merged',
      stageInstanceId: null,
      unitSlug: 'auth',
      actor: 'orchestrator',
      summary: 'Unit auth completed',
      timestamp: 'T2',
    });

    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(detail.unitPlan).toMatchObject({
      unitCount: 2,
      walkingSkeleton: 'auth',
      skipMatrix: { billing: ['functional-design'] },
      batches: [['auth'], ['billing']],
    });
    expect(detail.units).toEqual([
      expect.objectContaining({ slug: 'auth', state: 'MERGED', mergedAt: 'T2' }),
    ]);
    expect(detail.stages).toEqual([
      expect.objectContaining({
        stageId: 'code-generation',
        unitSlug: 'auth',
        pendingHumanTaskId: 'q-1',
      }),
    ]);
    expect(detail.gates).toEqual([
      expect.objectContaining({ humanTaskId: 'q-1', unitSlug: 'auth' }),
    ]);
    expect(detail.events.find((e) => e.type === 'v2.unit.merged')).toMatchObject({
      unitSlug: 'auth',
    });
  });

  it('a pre-promotion intent carries unitPlan null and units []', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(detail.unitPlan).toBeNull();
    expect(detail.units).toEqual([]);
  });
});

describe('WP4 — rewind expands per-unit stage instances', () => {
  // Plan: units-gen (produces the DAG) → cg (forEach: unit-of-work) → bt.
  const seedSectionPlan = () => {
    const placement = (stageId, order) =>
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${stageId}`,
        stageId,
        order,
        scopeMembership: { feature: 'EXECUTE' },
      });
    placement('units-gen', 1);
    placement('cg', 2);
    placement('bt', 3);
    const stageBlock = (stageId, extra = {}) =>
      procStore.set(keyOf(`BLOCK#${stageId}`, 'META'), {
        pk: `BLOCK#${stageId}`,
        sk: 'META',
        GSI1PK: 'TENANT#default#STAGE',
        GSI1SK: `NAME#${stageId}`,
        id: stageId,
        blockId: stageId,
        type: 'STAGE',
        version: 1,
        mode: 'inline',
        leadAgent: 'orchestrator',
        produces: [],
        consumes: [],
        ...extra,
      });
    stageBlock('units-gen', { produces: ['unit-of-work-dependency'] });
    stageBlock('cg', { forEach: 'unit-of-work', requires: ['units-gen'] });
    stageBlock('bt', { requires: ['cg'] });
  };

  const siOf = (stageId, unitSlug = null, sectionIndex = null) =>
    planStageInstanceId('aidlc-v2@4', stageId, unitSlug, sectionIndex);

  const seedStageRow = (
    intentId,
    stageId,
    unitSlug = null,
    state = 'SUCCEEDED',
    sectionIndex = null,
  ) =>
    procStore.set(keyOf(`EXEC#${intentId}`, `STAGE#${siOf(stageId, unitSlug, sectionIndex)}`), {
      pk: `EXEC#${intentId}`,
      sk: `STAGE#${siOf(stageId, unitSlug, sectionIndex)}`,
      type: 'Stage',
      executionId: intentId,
      stageInstanceId: siOf(stageId, unitSlug, sectionIndex),
      stageId,
      unitSlug,
      sectionIndex,
      state,
      attempt: 0,
      cli: 'claude',
      cliSessionId: 'sess-1',
    });

  const addProjectMember = async (projectId, sub, role) => {
    await g.addV('User').property('id', sub).property('email', `${sub}@x`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_MEMBER')
      .property('role', role)
      .to(gremlin.process.statics.V().has('User', 'id', sub))
      .next();
  };

  const repair = (sub, projectId, intentId) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/repair`,
      pathParameters: { projectId, intentId },
      ...claims(sub),
    });

  it('repairs orphaned parallel waits while preserving merged units', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    await seedIntentAnchor(intent.id);
    setStatus(intent.id, {
      status: 'RUNNING',
      durableExecutionArn: 'arn:aws:lambda:eu-central-1:123:durable-execution:old',
      orchestratorRunId: 'old-run',
      pendingHumanTaskId: 'answered-gate',
    });
    seedStageRow(intent.id, 'units-gen');
    seedStageRow(intent.id, 'cg', 'foundation', 'SUCCEEDED', 1);
    seedStageRow(intent.id, 'cg', 'asset-containment', 'WAITING_FOR_HUMAN', 1);
    seedStageRow(intent.id, 'cg', 'live-data-energy-flow', 'WAITING_FOR_HUMAN', 1);
    seedStageRow(intent.id, 'cg', 'echarts-integration', 'SUCCEEDED', 1);
    seedGate(intent.id, 'answered-gate', {
      status: 'answered',
      stageInstanceId: siOf('cg', 'live-data-energy-flow', 1),
    });
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPLAN'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPLAN',
      executionId: intent.id,
      units: [
        { slug: 'foundation', dependsOn: [] },
        { slug: 'asset-containment', dependsOn: ['foundation'] },
        { slug: 'live-data-energy-flow', dependsOn: ['foundation'] },
        { slug: 'echarts-integration', dependsOn: ['foundation'] },
        { slug: 'blocked-dependent', dependsOn: ['asset-containment'] },
        { slug: 'dependent', dependsOn: ['asset-containment'] },
      ],
      batches: [
        ['foundation'],
        ['asset-containment', 'live-data-energy-flow', 'echarts-integration'],
        ['blocked-dependent', 'dependent'],
      ],
    });
    const unitRow = (slug, state) =>
      procStore.set(keyOf(`EXEC#${intent.id}`, `UNIT#S1#${slug}`), {
        pk: `EXEC#${intent.id}`,
        sk: `UNIT#S1#${slug}`,
        type: 'Unit',
        executionId: intent.id,
        sectionIndex: 1,
        slug,
        state,
      });
    unitRow('foundation', 'MERGED');
    unitRow('asset-containment', 'RUNNING');
    unitRow('live-data-energy-flow', 'RUNNING');
    unitRow('echarts-integration', 'PR_DRAFT');
    unitRow('blocked-dependent', 'BLOCKED');
    unitRow('dependent', 'PENDING');
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPR#S1#echarts-integration#owner%2Frepo'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPR#S1#echarts-integration#owner%2Frepo',
      type: 'UnitPr',
      executionId: intent.id,
      sectionIndex: 1,
      unitSlug: 'echarts-integration',
      repository: 'owner/repo',
      state: 'READY',
      readyHeadSha: 'tainted-head',
    });

    const res = await repair(sub, projectId, intent.id);

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).repair).toMatchObject({
      sectionIndex: 1,
      laneSlugs: [
        'asset-containment',
        'blocked-dependent',
        'echarts-integration',
        'live-data-energy-flow',
      ],
      fromStageId: 'cg',
    });
    expect(lambdaMock.commandCalls(StopDurableExecutionCommand)).toHaveLength(1);
    expect(
      lambdaMock.commandCalls(StopDurableExecutionCommand)[0].args[0].input.DurableExecutionArn,
    ).toBe('arn:aws:lambda:eu-central-1:123:durable-execution:old');
    expect(archiveArtifactsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: intent.id,
        stageInstanceIds: expect.arrayContaining([
          siOf('cg', 'asset-containment', 1),
          siOf('cg', 'blocked-dependent', 1),
          siOf('cg', 'live-data-energy-flow', 1),
          siOf('cg', 'echarts-integration', 1),
        ]),
      }),
    );
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#foundation'))).toMatchObject({
      state: 'MERGED',
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#dependent'))).toMatchObject({
      state: 'PENDING',
    });
    for (const slug of [
      'asset-containment',
      'blocked-dependent',
      'live-data-energy-flow',
      'echarts-integration',
    ]) {
      expect(procStore.get(keyOf(`EXEC#${intent.id}`, `UNIT#S1#${slug}`))).toMatchObject({
        state: 'PENDING',
        failureReason: null,
      });
      const stageRow = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', slug, 1)}`));
      if (slug !== 'blocked-dependent') {
        expect(stageRow).toMatchObject({
          state: 'PENDING',
          attempt: 1,
          pendingHumanTaskId: null,
        });
      }
    }
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, 'UNITPR#S1#echarts-integration#owner%2Frepo')),
    ).toMatchObject({
      state: 'DRAFT',
      readyHeadSha: null,
      repositoryOutcome: 'replaying_after_lane_repair',
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META'))).toMatchObject({
      status: 'CREATED',
      pendingHumanTaskId: null,
      rewindFromStageId: 'cg',
      failureReason: null,
    });
    const invokes = orchestratorInvokes();
    expect(invokes).toHaveLength(1);
    expect(JSON.parse(Buffer.from(invokes[0].args[0].input.Payload).toString())).toMatchObject({
      action: 'start',
      startAtStageId: 'cg',
    });
    expect(
      [...procStore.values()].some(
        (row) => row.pk === `EXEC#${intent.id}` && row.eventType === 'v2.execution.lanes_repaired',
      ),
    ).toBe(true);
  });

  it('leaves a stop failure retryable without archiving or resetting lanes', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, {
      status: 'RUNNING',
      durableExecutionArn: 'arn:aws:lambda:eu-central-1:123:durable-execution:old',
    });
    seedStageRow(intent.id, 'cg', 'asset-containment', 'WAITING_FOR_HUMAN', 1);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#asset-containment'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNIT#S1#asset-containment',
      type: 'Unit',
      executionId: intent.id,
      sectionIndex: 1,
      slug: 'asset-containment',
      state: 'RUNNING',
    });
    lambdaMock.on(StopDurableExecutionCommand).rejectsOnce(new Error('durable service down'));

    const res = await repair(sub, projectId, intent.id);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'durable_stop_failed' });
    expect(archiveArtifactsSpy).not.toHaveBeenCalled();
    expect(orchestratorInvokes()).toHaveLength(0);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META'))).toMatchObject({
      status: 'FAILED',
      failureReason: 'lane_repair_durable_stop_failed',
    });
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'asset-containment', 1)}`)),
    ).toMatchObject({ state: 'WAITING_FOR_HUMAN', attempt: 0 });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#asset-containment'))).toMatchObject({
      state: 'RUNNING',
    });
  });

  it('restricts lane repair to owners/admins and refuses healthy runs', async () => {
    const owner = `u-${randomUUID()}`;
    const projectId = await seedV2Project(owner);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(owner, projectId)).body);
    setStatus(intent.id, { status: 'RUNNING' });
    const member = `u-${randomUUID()}`;
    const admin = `u-${randomUUID()}`;
    await addProjectMember(projectId, member, 'member');
    await addProjectMember(projectId, admin, 'admin');

    expect((await repair(member, projectId, intent.id)).statusCode).toBe(403);
    const adminResult = await repair(admin, projectId, intent.id);
    expect(adminResult.statusCode).toBe(409);
    expect(JSON.parse(adminResult.body)).toMatchObject({ code: 'repair_not_needed' });
  });

  it('does not treat a legacy wait with no section index as section zero', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'RUNNING' });
    seedStageRow(intent.id, 'cg', 'legacy-unit', 'WAITING_FOR_HUMAN', null);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNIT#legacy-unit'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNIT#legacy-unit',
      executionId: intent.id,
      slug: 'legacy-unit',
      state: 'RUNNING',
    });

    const res = await repair(sub, projectId, intent.id);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).sections).toEqual([]);
    expect(lambdaMock.commandCalls(StopDurableExecutionCommand)).toHaveLength(0);
    expect(orchestratorInvokes()).toHaveLength(0);
  });

  it('resets every lane instance of a forEach stage and re-opens the touched lanes', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    await seedIntentAnchor(intent.id);
    seedStageRow(intent.id, 'units-gen');
    seedStageRow(intent.id, 'cg', 'auth', 'SUCCEEDED', 1);
    seedStageRow(intent.id, 'cg', 'billing', 'FAILED', 1);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPLAN'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPLAN',
      executionId: intent.id,
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'billing', dependsOn: ['auth'] },
      ],
      batches: [['auth'], ['billing']],
    });
    const unitRow = (slug, state, extra = {}) =>
      procStore.set(keyOf(`EXEC#${intent.id}`, `UNIT#S1#${slug}`), {
        pk: `EXEC#${intent.id}`,
        sk: `UNIT#S1#${slug}`,
        executionId: intent.id,
        sectionIndex: 1,
        slug,
        state,
        ...extra,
      });
    unitRow('auth', 'MERGED');
    unitRow('billing', 'FAILED', { failureReason: 'cg: sensor_blocked' });

    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/rewind`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({
        fromStageId: 'cg',
        guidance: 'Regenerate both units against the new schema.',
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);

    // BOTH lane instances of cg were reset; units-gen upstream untouched.
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'auth', 1)}`)),
    ).toMatchObject({
      state: 'PENDING',
      attempt: 1,
    });
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'billing', 1)}`)),
    ).toMatchObject({ state: 'PENDING', attempt: 1 });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('units-gen')}`))).toMatchObject({
      state: 'SUCCEEDED',
    });

    // The touched lanes were re-opened (PENDING, verdict fields cleared).
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#auth'))).toMatchObject({
      state: 'PENDING',
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#S1#billing'))).toMatchObject({
      state: 'PENDING',
      failureReason: null,
    });

    // Reset events carry the lane attribution.
    const events = [...procStore.values()].filter(
      (i) => i.pk === `EXEC#${intent.id}` && i.eventType === 'v2.stage.reset',
    );
    expect(events.some((e) => e.unitSlug === 'auth')).toBe(true);
    expect(events.some((e) => e.unitSlug === 'billing')).toBe(true);
  });

  it('stops intent and lane sessions concurrently during a section rewind', async () => {
    process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu:1:runtime/x';
    let inFlight = 0;
    let maxInFlight = 0;
    agentcoreMock.on(StopRuntimeSessionCommand).callsFake(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return {};
    });
    try {
      const sub = `u-${randomUUID()}`;
      const projectId = await seedV2Project(sub);
      seedSectionPlan();
      const intent = JSON.parse((await createIntent(sub, projectId)).body);
      setStatus(intent.id, { status: 'FAILED' });
      seedStageRow(intent.id, 'units-gen');
      seedStageRow(intent.id, 'cg', 'auth', 'SUCCEEDED', 1);
      seedStageRow(intent.id, 'cg', 'billing', 'FAILED', 1);
      procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPLAN'), {
        pk: `EXEC#${intent.id}`,
        sk: 'UNITPLAN',
        executionId: intent.id,
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'billing', dependsOn: ['auth'] },
        ],
        batches: [['auth'], ['billing']],
      });

      const res = await handler({
        httpMethod: 'POST',
        path: `/projects/${projectId}/intents/${intent.id}/rewind`,
        pathParameters: { projectId, intentId: intent.id },
        body: JSON.stringify({ fromStageId: 'cg' }),
        ...claims(sub),
      });

      expect(res.statusCode).toBe(202);
      expect(agentcoreMock.commandCalls(StopRuntimeSessionCommand)).toHaveLength(3);
      expect(maxInFlight).toBeGreaterThan(1);
    } finally {
      delete process.env.AGENTCORE_RUNTIME_ARN;
    }
  });

  it('restarts an incomplete unit section from its first stage when a later stage is retried', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#design'), {
      pk: 'WF#default#aidlc-v2',
      sk: 'V#4#PLACEMENT#design',
      stageId: 'design',
      order: 2,
      scopeMembership: { feature: 'EXECUTE' },
    });
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#cg'), {
      ...procStore.get(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#cg')),
      order: 3,
    });
    procStore.set(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#bt'), {
      ...procStore.get(keyOf('WF#default#aidlc-v2', 'V#4#PLACEMENT#bt')),
      order: 4,
    });
    procStore.set(keyOf('BLOCK#design', 'META'), {
      pk: 'BLOCK#design',
      sk: 'META',
      GSI1PK: 'TENANT#default#STAGE',
      GSI1SK: 'NAME#design',
      id: 'design',
      blockId: 'design',
      type: 'STAGE',
      version: 1,
      mode: 'inline',
      leadAgent: 'orchestrator',
      produces: [],
      consumes: [],
      forEach: 'unit-of-work',
      requires: ['units-gen'],
    });
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'WAITING' });
    seedStageRow(intent.id, 'units-gen');
    seedStageRow(intent.id, 'design', 'foundation', 'SUCCEEDED', 1);
    seedStageRow(intent.id, 'cg', 'foundation', 'FAILED', 1);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNITPLAN'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNITPLAN',
      executionId: intent.id,
      units: [
        { slug: 'foundation', dependsOn: [] },
        { slug: 'next-unit', dependsOn: ['foundation'] },
      ],
      batches: [['foundation'], ['next-unit']],
    });
    for (const [slug, state] of [
      ['foundation', 'FAILED'],
      ['next-unit', 'PENDING'],
    ]) {
      procStore.set(keyOf(`EXEC#${intent.id}`, `UNIT#S1#${slug}`), {
        pk: `EXEC#${intent.id}`,
        sk: `UNIT#S1#${slug}`,
        executionId: intent.id,
        sectionIndex: 1,
        slug,
        state,
      });
    }

    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/rewind`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({ fromStageId: 'cg' }),
      ...claims(sub),
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({
      intent: { rewindFromStageId: 'design' },
      restart: {
        requestedFromStageId: 'cg',
        fromStageId: 'design',
        sectionRestarted: true,
      },
    });
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('design', 'foundation', 1)}`)),
    ).toMatchObject({ state: 'PENDING', attempt: 1 });
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'foundation', 1)}`)),
    ).toMatchObject({ state: 'PENDING', attempt: 1 });
    const calls = orchestratorInvokes();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'design' });
  });

  it('rewinding to a post-section stage leaves lanes and lane instances alone', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'SUCCEEDED' });
    await seedIntentAnchor(intent.id);
    seedStageRow(intent.id, 'units-gen');
    seedStageRow(intent.id, 'cg', 'auth');
    seedStageRow(intent.id, 'cg', 'billing');
    seedStageRow(intent.id, 'bt');
    procStore.set(keyOf(`EXEC#${intent.id}`, 'UNIT#auth'), {
      pk: `EXEC#${intent.id}`,
      sk: 'UNIT#auth',
      executionId: intent.id,
      slug: 'auth',
      state: 'MERGED',
    });

    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/rewind`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({ fromStageId: 'bt', guidance: 'Re-run the build only.' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('bt')}`))).toMatchObject({
      state: 'PENDING',
      attempt: 1,
    });
    // Lane instances + lane rows untouched.
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'auth')}`))).toMatchObject({
      state: 'SUCCEEDED',
      attempt: 0,
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#auth'))).toMatchObject({
      state: 'MERGED',
    });
  });
});

// ── Post-hoc artifact editing (impact / content / verify / quorum edit) ─────

// Seed one artifact vertex anchored to the intent. Downstream wiring is done
// by the caller (downstream --CONSUMES/DERIVED_FROM--> upstream in-edges).
const seedArtifact = async (intentId, id, { type = 'doc', title = id, content = '# x' } = {}) => {
  await g
    .addV('Artifact')
    .property('id', id)
    .property('intent_id', intentId)
    .property('artifact_type', type)
    .property('title', title)
    .property('content', content)
    .next();
  await g
    .V()
    .has('Intent', 'id', intentId)
    .addE('CONTAINS')
    .to(gremlin.process.statics.V().has('Artifact', 'id', id).has('intent_id', intentId))
    .next();
};

const linkArtifacts = (intentId, fromId, toId, edge) =>
  g
    .V()
    .has('Artifact', 'id', fromId)
    .has('intent_id', intentId)
    .addE(edge)
    .to(gremlin.process.statics.V().has('Artifact', 'id', toId).has('intent_id', intentId))
    .next();

// market-research (mr) is consumed by trends (depth 1), which build-vs-buy
// derives from (depth 2) — the canonical drift chain.
const seedEditFixture = async (sub) => {
  const projectId = await seedV2Project(sub);
  const intent = JSON.parse((await createIntent(sub, projectId)).body);
  await seedIntentAnchor(intent.id);
  await seedArtifact(intent.id, 'mr', { type: 'market-research', title: 'Market research' });
  await seedArtifact(intent.id, 'trends', { type: 'market-trends', title: 'Trends' });
  await seedArtifact(intent.id, 'bvb', { type: 'build-vs-buy', title: 'Build vs buy' });
  await linkArtifacts(intent.id, 'trends', 'mr', 'CONSUMES');
  await linkArtifacts(intent.id, 'bvb', 'trends', 'DERIVED_FROM');
  return { projectId, intent };
};

describe('GET /artifacts/{id}/impact', () => {
  it('returns the transitive downstream closure + the edit-blocking verdict', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/artifacts/mr/impact`,
      pathParameters: { projectId, intentId: intent.id, artifactId: 'mr' },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const impact = JSON.parse(res.body);
    expect(impact.downstream.map((d) => [d.id, d.depth])).toEqual([
      ['trends', 1],
      ['bvb', 2],
    ]);
    expect(impact.downstream[0].via).toEqual(['CONSUMES']);
    expect(impact).toMatchObject({ executionActive: false, editBlocked: false });
  });

  it('404s an unknown artifact', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/intents/${intent.id}/artifacts/nope/impact`,
      pathParameters: { projectId, intentId: intent.id, artifactId: 'nope' },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });
});

const putContent = (sub, projectId, intentId, artifactId, content) =>
  handler({
    httpMethod: 'PUT',
    path: `/projects/${projectId}/intents/${intentId}/artifacts/${artifactId}/content`,
    pathParameters: { projectId, intentId, artifactId },
    body: JSON.stringify({ content }),
    ...claims(sub),
  });

describe('PUT /artifacts/{id}/content (simple edit)', () => {
  it('writes content + human provenance, marks the closure stale, records the event', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await putContent(sub, projectId, intent.id, 'mr', '# Market research\nEU focus.');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.staleMarked.toSorted()).toEqual(['bvb', 'trends']);

    // The vertex carries the new content + the server-stamped provenance.
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    const mr = detail.artifacts.find((a) => a.id === 'mr');
    expect(mr.content).toBe('# Market research\nEU focus.');
    expect(mr.editOrigin).toBe('human');
    expect(mr.editedBy).toBe(sub);
    expect(mr.staleSince).toBeNull(); // the edited doc itself is never stale
    const trends = detail.artifacts.find((a) => a.id === 'trends');
    expect(trends.staleSince).toBeTruthy();
    expect(trends.staleReason).toContain('edit:mr');
    // Audit event landed in the feed.
    expect(detail.events.some((e) => e.type === 'v2.artifact.edited')).toBe(true);
  });

  it('409s while a stage is genuinely executing (block-while-running policy)', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    for (const status of ['RUNNING', 'CREATED']) {
      setStatus(intent.id, { status });
      const res = await putContent(sub, projectId, intent.id, 'mr', 'new');
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('execution_active');
    }
  });

  it('a parked run (WAITING) is editable and the edit is announced via a steering row', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    setStatus(intent.id, { status: 'WAITING' });
    const res = await putContent(sub, projectId, intent.id, 'mr', '# EU focus');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The parked conversation is told to re-read the edited document at the
    // next deterministic injection point (gate resume / fresh stage start).
    expect(body.steering).toMatchObject({ kind: 'artifact-edit', status: 'pending' });
    expect(body.steering.message).toContain('Market research');
    const steerRows = [...procStore.values()].filter(
      (r) => r.pk === `EXEC#${intent.id}` && r.sk.startsWith('STEER#'),
    );
    expect(steerRows).toHaveLength(1);
    expect(steerRows[0]).toMatchObject({ kind: 'artifact-edit', status: 'pending' });
  });

  it('a terminal-state edit records NO steering row (nothing will resume)', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await putContent(sub, projectId, intent.id, 'mr', '# EU focus');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).steering).toBeNull();
    const steerRows = [...procStore.values()].filter(
      (r) => r.pk === `EXEC#${intent.id}` && r.sk.startsWith('STEER#'),
    );
    expect(steerRows).toHaveLength(0);
  });

  it('rejects empty content', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await putContent(sub, projectId, intent.id, 'mr', '   ');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /artifacts/{id}/verify', () => {
  it('clears the drift marker and stamps the verifier', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    await putContent(sub, projectId, intent.id, 'mr', 'changed');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/artifacts/trends/verify`,
      pathParameters: { projectId, intentId: intent.id, artifactId: 'trends' },
      body: JSON.stringify({ note: 'still valid' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    const trends = detail.artifacts.find((a) => a.id === 'trends');
    expect(trends.staleSince).toBeNull();
    expect(trends.verifiedBy).toBe(sub);
    // bvb was NOT verified — its marker stays.
    expect(detail.artifacts.find((a) => a.id === 'bvb').staleSince).toBeTruthy();
  });
});

const startQuorumEdit = (sub, projectId, intentId, artifactId, changeDescription) =>
  handler({
    httpMethod: 'POST',
    path: `/projects/${projectId}/intents/${intentId}/artifacts/${artifactId}/quorum-edit`,
    pathParameters: { projectId, intentId, artifactId },
    body: JSON.stringify({ changeDescription }),
    ...claims(sub),
  });

describe('POST /artifacts/{id}/quorum-edit', () => {
  it('creates the QEDIT session and hands off to the orchestrator', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await startQuorumEdit(sub, projectId, intent.id, 'mr', 'Target the EU market');
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      artifactId: 'mr',
      state: 'PLANNING',
      changeDescription: 'Target the EU market',
    });
    // Orchestrator invoked with the quorum-edit action.
    const invoke = orchestratorInvokes()[0].args[0].input;
    expect(JSON.parse(Buffer.from(invoke.Payload).toString())).toMatchObject({
      action: 'quorum-edit',
      intentId: intent.id,
      editId: body.editId,
    });
    // The session rides the detail DTO.
    const detail = JSON.parse(
      (
        await handler({
          httpMethod: 'GET',
          path: `/projects/${projectId}/intents/${intent.id}`,
          pathParameters: { projectId, intentId: intent.id },
          ...claims(sub),
        })
      ).body,
    );
    expect(detail.quorumEdits).toHaveLength(1);
    expect(detail.quorumEdits[0].state).toBe('PLANNING');
  });

  it('409s a second edit while one is live, and blocks simple edits + start too', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    await startQuorumEdit(sub, projectId, intent.id, 'mr', 'change 1');
    const second = await startQuorumEdit(sub, projectId, intent.id, 'trends', 'change 2');
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe('quorum_edit_active');
    const put = await putContent(sub, projectId, intent.id, 'mr', 'race');
    expect(put.statusCode).toBe(409);
    const start = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(start.statusCode).toBe(409);
    expect(JSON.parse(start.body).code).toBe('quorum_edit_active');
  });

  it('a parked run (WAITING) can start a Quorum edit, but its gates cannot be answered until it finishes', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    setStatus(intent.id, { status: 'WAITING' });
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });

    const res = await startQuorumEdit(sub, projectId, intent.id, 'mr', 'Target the EU market');
    expect(res.statusCode).toBe(202);

    // Answering the gate would resume the parked stage INTO Quorum's writes.
    const answer = await answerGate(sub, projectId, intent.id, 'h1');
    expect(answer.statusCode).toBe(409);
    expect(JSON.parse(answer.body).code).toBe('quorum_edit_active');
    expect(lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(0);

    // Once the edit is terminal, the gate answers normally.
    const body = JSON.parse(res.body);
    procStore.set(keyOf(`EXEC#${intent.id}`, `QEDIT#${body.editId}`), {
      ...procStore.get(keyOf(`EXEC#${intent.id}`, `QEDIT#${body.editId}`)),
      state: 'SUCCEEDED',
    });
    const answered = await answerGate(sub, projectId, intent.id, 'h1');
    expect(answered.statusCode).toBe(200);
  });

  it('requires a change description', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    const res = await startQuorumEdit(sub, projectId, intent.id, 'mr', '');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /quorum-edits/{editId}/decision', () => {
  const seedAwaiting = (intentId, editId) => {
    procStore.set(keyOf(`EXEC#${intentId}`, `QEDIT#${editId}`), {
      pk: `EXEC#${intentId}`,
      sk: `QEDIT#${editId}`,
      type: 'QuorumEdit',
      executionId: intentId,
      editId,
      artifactId: 'mr',
      state: 'AWAITING_APPROVAL',
      callbackId: 'cb-decision',
      plan: {
        summary: 's',
        items: [
          { artifactId: 'trends', action: 'update', rationale: 'r' },
          { artifactId: 'bvb', action: 'verify-unaffected', rationale: 'ok' },
        ],
      },
    });
  };

  const decide = (sub, projectId, intentId, editId, body) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/quorum-edits/${editId}/decision`,
      pathParameters: { projectId, intentId, editId },
      body: JSON.stringify(body),
      ...claims(sub),
    });

  it('approve narrows to PLAN artifacts, CASes to APPLYING and resumes the callback', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    seedAwaiting(intent.id, 'qe-1');
    const res = await decide(sub, projectId, intent.id, 'qe-1', {
      decision: 'approve',
      approvedArtifactIds: ['trends', 'fabricated'],
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe('APPLYING');
    expect(body.approvedArtifactIds).toEqual(['trends']); // fabricated dropped
    const cb = lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)[0].args[0].input;
    expect(cb.CallbackId).toBe('cb-decision');
    expect(JSON.parse(Buffer.from(cb.Result).toString()).answer).toMatchObject({
      decision: 'approve',
      approvedArtifactIds: ['trends'],
    });
    // A second decision loses the CAS.
    const again = await decide(sub, projectId, intent.id, 'qe-1', { decision: 'reject' });
    expect(again.statusCode).toBe(409);
  });

  it('reject terminates the session without an apply', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    seedAwaiting(intent.id, 'qe-1');
    const res = await decide(sub, projectId, intent.id, 'qe-1', { decision: 'reject' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).state).toBe('REJECTED');
    // Rejection still wakes the parked orchestrator (it closes the loop).
    expect(lambdaMock.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(1);
  });

  it('409s when the session is not awaiting approval', async () => {
    const sub = `u-${randomUUID()}`;
    const { projectId, intent } = await seedEditFixture(sub);
    procStore.set(keyOf(`EXEC#${intent.id}`, 'QEDIT#qe-1'), {
      pk: `EXEC#${intent.id}`,
      sk: 'QEDIT#qe-1',
      editId: 'qe-1',
      state: 'PLANNING',
      callbackId: null,
    });
    const res = await decide(sub, projectId, intent.id, 'qe-1', { decision: 'approve' });
    expect(res.statusCode).toBe(409);
  });
});

// ── Per-intent stage skipping (shared/stage-skip.js) ──

describe('stage skipping — create-time deselection + rewind un-skip', () => {
  // Plan for the pinned workflow (version 4, scope 'feature'):
  // optional (CONDITIONAL) → main (ALWAYS), reserved 'orchestrator' lead.
  const seedSkippablePlan = () => {
    const placement = (stageId, order) =>
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${stageId}`,
        stageId,
        order,
        scopeMembership: { feature: 'EXECUTE' },
      });
    placement('optional', 1);
    placement('main', 2);
    const stageBlock = (stageId, execution) =>
      procStore.set(keyOf(`BLOCK#${stageId}`, 'META'), {
        pk: `BLOCK#${stageId}`,
        sk: 'META',
        GSI1PK: 'TENANT#default#STAGE',
        GSI1SK: `NAME#${stageId}`,
        id: stageId,
        blockId: stageId,
        type: 'STAGE',
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        execution,
        produces: [],
        consumes: [],
      });
    stageBlock('optional', 'CONDITIONAL');
    stageBlock('main', 'ALWAYS');
  };

  const enableProjectSkipping = (projectId) =>
    g
      .V()
      .has('Project', 'id', projectId)
      .property(gremlin.process.cardinality.single, 'stage_skipping', 'enabled')
      .next();

  it('rejects skipStageIds when stage skipping is disabled (platform default, no override)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      scope: 'feature',
      skipStageIds: ['optional'],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/disabled/);
  });

  it('accepts CONDITIONAL skips under the project override and snapshots them onto the intent', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      scope: 'feature',
      skipStageIds: ['optional', 'optional'], // deduped
    });
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.stageSkipping).toBe('enabled');
    expect(intent.skipStageIds).toEqual(['optional']);
    // The snapshot rides META so the orchestrator/rewind recomputes agree.
    const meta = procStore.get(keyOf(`EXEC#${intent.id}`, 'META'));
    expect(meta.skipStageIds).toEqual(['optional']);
    expect(meta.stageSkipping).toBe('enabled');
  });

  it('a run without skips still snapshots the effective mode (gate-time skips key off it)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const res = await createIntent(sub, projectId);
    expect(res.statusCode).toBe(201);
    const intent = JSON.parse(res.body);
    expect(intent.stageSkipping).toBe('enabled');
    expect(intent.skipStageIds).toBeNull();
  });

  it('400s an ALWAYS-stage skip with the structured skip_not_allowed error', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const res = await createIntent(sub, projectId, {
      title: 'I',
      prompt: 'X',
      scope: 'feature',
      skipStageIds: ['main'],
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not runnable/);
    expect(body.errors.map((e) => e.code)).toContain('skip_not_allowed');
    // Nothing was written.
    const metas = [...procStore.values()].filter(
      (i) => i.type === 'Execution' && i.projectId === projectId,
    );
    expect(metas).toEqual([]);
  });

  it('rewinding TO a skipped stage un-skips it (overlay shrinks on META, relaunch runs it)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const intent = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'I',
          prompt: 'X',
          scope: 'feature',
          skipStageIds: ['optional'],
        })
      ).body,
    );
    await seedIntentAnchor(intent.id);
    // The run finished: main SUCCEEDED, optional holds its SKIPPED audit row.
    const siOf = (stageId) => planStageInstanceId('aidlc-v2@4', stageId);
    procStore.set(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('optional')}`), {
      pk: `EXEC#${intent.id}`,
      sk: `STAGE#${siOf('optional')}`,
      type: 'Stage',
      executionId: intent.id,
      stageInstanceId: siOf('optional'),
      stageId: 'optional',
      state: 'SKIPPED',
      attempt: 0,
    });
    setStatus(intent.id, { status: 'SUCCEEDED' });

    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/rewind`,
      pathParameters: { projectId, intentId: intent.id },
      body: JSON.stringify({ fromStageId: 'optional' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(202);
    // The overlay shrank to empty → stored as null (sparse META).
    const meta = procStore.get(keyOf(`EXEC#${intent.id}`, 'META'));
    expect(meta.skipStageIds).toBeNull();
    // The SKIPPED row was reset for the re-run.
    const row = procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('optional')}`));
    expect(row).toMatchObject({ state: 'PENDING', attempt: 1 });
    // Relaunched AT the un-skipped stage.
    const calls = orchestratorInvokes();
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', startAtStageId: 'optional' });
  });
});

describe('stage skipping — start-time override (DRAFT screen)', () => {
  const seedSkippablePlan = () => {
    const placement = (stageId, order) =>
      procStore.set(keyOf('WF#default#aidlc-v2', `V#4#PLACEMENT#${stageId}`), {
        pk: 'WF#default#aidlc-v2',
        sk: `V#4#PLACEMENT#${stageId}`,
        stageId,
        order,
        scopeMembership: { feature: 'EXECUTE' },
      });
    placement('optional', 1);
    placement('main', 2);
    const stageBlock = (stageId, execution) =>
      procStore.set(keyOf(`BLOCK#${stageId}`, 'META'), {
        pk: `BLOCK#${stageId}`,
        sk: 'META',
        GSI1PK: 'TENANT#default#STAGE',
        GSI1SK: `NAME#${stageId}`,
        id: stageId,
        blockId: stageId,
        type: 'STAGE',
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        execution,
        produces: [],
        consumes: [],
      });
    stageBlock('optional', 'CONDITIONAL');
    stageBlock('main', 'ALWAYS');
  };

  const enableProjectSkipping = (projectId) =>
    g
      .V()
      .has('Project', 'id', projectId)
      .property(gremlin.process.cardinality.single, 'stage_skipping', 'enabled')
      .next();

  const startIntent = (sub, projectId, intentId, bodyObj = {}) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intentId}/start`,
      pathParameters: { projectId, intentId },
      body: JSON.stringify(bodyObj),
      ...claims(sub),
    });

  it('a DRAFT start may replace the skip overlay (validated + persisted on META)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);

    const res = await startIntent(sub, projectId, intent.id, { skipStageIds: ['optional'] });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).skipStageIds).toEqual(['optional']);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).skipStageIds).toEqual(['optional']);
  });

  it('a DRAFT start with skipStageIds: [] clears the create-time selection', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const intent = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'I',
          prompt: 'X',
          scope: 'feature',
          skipStageIds: ['optional'],
        })
      ).body,
    );
    const res = await startIntent(sub, projectId, intent.id, { skipStageIds: [] });
    expect(res.statusCode).toBe(202);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).skipStageIds).toBeNull();
  });

  it('an omitted skipStageIds leaves the create-time snapshot untouched', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const intent = JSON.parse(
      (
        await createIntent(sub, projectId, {
          title: 'I',
          prompt: 'X',
          scope: 'feature',
          skipStageIds: ['optional'],
        })
      ).body,
    );
    const res = await startIntent(sub, projectId, intent.id);
    expect(res.statusCode).toBe(202);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).skipStageIds).toEqual(['optional']);
  });

  it('rejects the override when skipping is disabled for the run, or the stage is ALWAYS', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    // Disabled run (no override, platform default = disabled).
    const plain = JSON.parse((await createIntent(sub, projectId)).body);
    const denied = await startIntent(sub, projectId, plain.id, { skipStageIds: ['optional'] });
    expect(denied.statusCode).toBe(400);
    expect(JSON.parse(denied.body).error).toMatch(/disabled/);
    // Enabled run, but an ALWAYS stage → structured plan error.
    await enableProjectSkipping(projectId);
    const enabled = JSON.parse((await createIntent(sub, projectId)).body);
    const bad = await startIntent(sub, projectId, enabled.id, { skipStageIds: ['main'] });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).errors.map((e) => e.code)).toContain('skip_not_allowed');
  });

  it("409s a skip override on a non-DRAFT restart (the prior run's plan holds)", async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSkippablePlan();
    await enableProjectSkipping(projectId);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    const res = await startIntent(sub, projectId, intent.id, { skipStageIds: ['optional'] });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/DRAFT/);
    // A plain restart still works.
    const retry = await startIntent(sub, projectId, intent.id);
    expect(retry.statusCode).toBe(202);
  });
});
