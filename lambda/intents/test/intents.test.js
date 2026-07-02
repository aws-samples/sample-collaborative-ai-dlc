import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  InvokeCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
// CJS shared module — default-import then destructure. Used to compute the
// deterministic stage-instance ids the rewind flow resets/supersedes.
import executionPlanPkg from '../../shared/v2-execution-plan.js';

const { stageInstanceId: planStageInstanceId } = executionPlanPkg;

const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const ssmMock = mockClient(SSMClient);

// In-memory single-table fake for the v2 process table + blocks table.
const procStore = new Map();
const keyOf = (pk, sk) => `${pk}|${sk}`;

const installDdbFakes = () => {
  ddbMock.reset();
  procStore.clear();
  ddbMock.on(GetCommand).callsFake((input) => {
    const item = procStore.get(keyOf(input.Key.pk, input.Key.sk));
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
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    let items = [...procStore.values()];
    if (input.IndexName === 'GSI1') {
      items = items.filter((i) => i.GSI1PK === values[':pk']);
      if (values[':sk']) items = items.filter((i) => (i.GSI1SK || '').startsWith(values[':sk']));
    } else {
      items = items.filter((i) => i.pk === values[':pk']);
    }
    if (input.ScanIndexForward === false) items.reverse();
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
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  lambdaMock.on(SendDurableExecutionCallbackSuccessCommand).resolves({});
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
  vi.stubEnv('REALTIME_DOC_SECRET', 'test-secret');
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
  ssmMock.reset();
});

const claims = (sub) => ({
  requestContext: { authorizer: { claims: { sub, email: `${sub}@x` } } },
});

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
    expect(intent.branch).toBe(`aidlc/${intent.id}`);
    // Project run-config snapshotted onto the intent at create.
    expect(intent.agentCli).toBe('kiro');
    expect(intent.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(intent.parkReleaseSeconds).toBe(120);
    // WP5: lane concurrency cap snapshotted; the ladder decision starts unset.
    expect(intent.maxParallelUnits).toBe(3);
    expect(intent.constructionAutonomyMode).toBeNull();
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

  it('requires a scope', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const res = await createIntent(sub, projectId, { title: 'I', prompt: 'Build X' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/scope is required/);
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

describe('POST /start', () => {
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
    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(calls[0].args[0].input.Payload).toString());
    expect(payload).toMatchObject({ action: 'start', intentId: intent.id });
  });

  it('rolls back to DRAFT when the orchestrator invoke fails, so start can be retried', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    // Hand-off throws (e.g. unqualified-ARN / transient invoke error).
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('invoke failed'));
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
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
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
    for (const key of ['stages', 'gates', 'metrics', 'outputs', 'sensorRuns', 'artifacts']) {
      expect(Array.isArray(detail[key])).toBe(true);
    }
    expect(detail.intent.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(detail.intent.parkReleaseSeconds).toBe(120);
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
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
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
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
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
        .property('artifact_type', 'doc')
        .property('title', id)
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

    // Relaunched at the rewind point.
    const calls = lambdaMock.commandCalls(InvokeCommand);
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
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
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

  it('400s a rewind without guidance (the correction is the point)', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    const res = await rewind(sub, projectId, intent.id, { fromStageId: 'implement' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/guidance is required/);
  });

  it('rolls back to the prior status when the relaunch invoke fails', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    seedStageRow(intent.id, 'implement');
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('invoke failed'));
    const res = await rewind(sub, projectId, intent.id, {
      fromStageId: 'implement',
      guidance: 'x',
    });
    expect(res.statusCode).toBe(500);
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'META')).status).toBe('FAILED');
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
      expect.objectContaining({ stageId: 'code-generation', unitSlug: 'auth' }),
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

  const siOf = (stageId, unitSlug = null) => planStageInstanceId('aidlc-v2@4', stageId, unitSlug);

  const seedStageRow = (intentId, stageId, unitSlug = null, state = 'SUCCEEDED') =>
    procStore.set(keyOf(`EXEC#${intentId}`, `STAGE#${siOf(stageId, unitSlug)}`), {
      pk: `EXEC#${intentId}`,
      sk: `STAGE#${siOf(stageId, unitSlug)}`,
      type: 'Stage',
      executionId: intentId,
      stageInstanceId: siOf(stageId, unitSlug),
      stageId,
      unitSlug,
      state,
      attempt: 0,
      cli: 'claude',
      cliSessionId: 'sess-1',
    });

  it('resets every lane instance of a forEach stage and re-opens the touched lanes', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    seedSectionPlan();
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    setStatus(intent.id, { status: 'FAILED' });
    await seedIntentAnchor(intent.id);
    seedStageRow(intent.id, 'units-gen');
    seedStageRow(intent.id, 'cg', 'auth');
    seedStageRow(intent.id, 'cg', 'billing', 'FAILED');
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
      procStore.set(keyOf(`EXEC#${intent.id}`, `UNIT#${slug}`), {
        pk: `EXEC#${intent.id}`,
        sk: `UNIT#${slug}`,
        executionId: intent.id,
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
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'auth')}`))).toMatchObject({
      state: 'PENDING',
      attempt: 1,
    });
    expect(
      procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('cg', 'billing')}`)),
    ).toMatchObject({ state: 'PENDING', attempt: 1 });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, `STAGE#${siOf('units-gen')}`))).toMatchObject({
      state: 'SUCCEEDED',
    });

    // The touched lanes were re-opened (PENDING, verdict fields cleared).
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#auth'))).toMatchObject({
      state: 'PENDING',
    });
    expect(procStore.get(keyOf(`EXEC#${intent.id}`, 'UNIT#billing'))).toMatchObject({
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
