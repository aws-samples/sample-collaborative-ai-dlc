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

const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);

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
    if (input.ConditionExpression?.includes(':fromStatus')) {
      if (!existing || existing.status !== values[':fromStatus']) {
        const e = new Error('cas');
        e.name = 'ConditionalCheckFailedException';
        throw e;
      }
    }
    if (input.ConditionExpression?.includes(':pending')) {
      if (!existing || existing.status !== 'pending') {
        const e = new Error('cas');
        e.name = 'ConditionalCheckFailedException';
        throw e;
      }
    }
    const next = { ...(existing || { pk: input.Key.pk, sk: input.Key.sk }) };
    // Apply a minimal subset of SET assignments we exercise.
    if (values[':status']) next.status = values[':status'];
    if (values[':answer'] !== undefined) next.answer = values[':answer'];
    if (values[':status'] && input.ConditionExpression?.includes(':pending')) {
      next.answeredBy = values[':by'] ?? null;
      next.answeredAt = values[':ts'] ?? null;
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
const seedGate = (intentId, humanTaskId, { status = 'pending', callbackId = null } = {}) => {
  procStore.set(keyOf(`EXEC#${intentId}`, `HUMAN#${humanTaskId}`), {
    pk: `EXEC#${intentId}`,
    sk: `HUMAN#${humanTaskId}`,
    type: 'HumanTask',
    executionId: intentId,
    humanTaskId,
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
    expect(intent.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(intent.parkReleaseSeconds).toBe(120);
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

  it('refuses to start a non-DRAFT intent', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = await seedV2Project(sub);
    const intent = JSON.parse((await createIntent(sub, projectId)).body);
    // First start succeeds.
    await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    // Second start sees CREATED, not DRAFT.
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/intents/${intent.id}/start`,
      pathParameters: { projectId, intentId: intent.id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
  });
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
    seedGate(intent.id, 'h1', { status: 'pending', callbackId: 'cb-h1' });

    const res = await answerGate(sub, projectId, intent.id, 'h1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('answered');
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
