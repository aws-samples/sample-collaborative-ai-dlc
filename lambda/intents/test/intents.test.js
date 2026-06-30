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
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

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
};

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
    .property('default_scope', 'feature')
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
  // Workflow META row (latest version) so create can pin it.
  procStore.set(keyOf('WF#default#aidlc-v2', 'META'), {
    pk: 'WF#default#aidlc-v2',
    sk: 'META',
    version: 4,
  });
  return projectId;
};

const createIntent = async (sub, projectId, body = { title: 'I', prompt: 'Build X' }) => {
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
});
