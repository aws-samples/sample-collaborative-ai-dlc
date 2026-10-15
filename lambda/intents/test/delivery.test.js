import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';
const plan = vi.hoisted(() => ({ stages: [] }));
vi.mock('../../shared/v2-workflow-plan.js', async (original) => ({
  ...(await original()),
  loadExecutionPlan: async () => ({ valid: true, plan }),
}));
const partition = `delivery-${randomUUID()}`;
const tableName = `delivery-api-${randomUUID()}`;
const lambda = mockClient(LambdaClient);
const ssm = mockClient(SSMClient);
let db, store, handler, conn, g, meta, projectId, userId, remoteHead, providerCalls;
beforeAll(async () => {
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
  vi.stubEnv('V2_PROCESS_TABLE', tableName);
  vi.stubEnv('GREMLIN_PARTITION', partition);
  vi.stubEnv('V2_ORCHESTRATOR_FUNCTION', 'delivery-orchestrator');
  vi.stubEnv('SOURCE_CONTROL_FUNCTION', 'delivery-source-control');
  db = makeDdb();
  await createV2Table(db.client, tableName);
  store = createProcessStore({ ddb: db.doc, tableName });
  ({ handler } = await import('../index.js'));
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: partition,
        readPartitions: [partition],
      }),
    );
});
afterAll(async () => {
  await conn.close();
  await deleteV2Table(db.client, tableName);
  db.client.destroy();
  lambda.restore();
  ssm.restore();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  plan.stages = [];
  remoteHead = 'head-one';
  providerCalls = [];
  lambda.reset();
  ssm.reset();
  ssm.on(GetParameterCommand).rejects(new Error('no pricing fixture'));
  lambda.on(InvokeCommand).callsFake((input) => {
    if (input.FunctionName !== 'delivery-source-control') return { StatusCode: 202 };
    const call = JSON.parse(Buffer.from(input.Payload).toString());
    providerCalls.push(call);
    return {
      Payload: Buffer.from(
        JSON.stringify({
          ok: true,
          result: { headSha: remoteHead, baseSha: 'base', baseBranch: 'develop', pr: null },
        }),
      ),
    };
  });
  projectId = randomUUID();
  userId = randomUUID();
  await g
    .addV('Project')
    .property('id', projectId)
    .as('p')
    .addV('User')
    .property('id', userId)
    .addE('HAS_MEMBER')
    .from_('p')
    .property('role', 'owner')
    .next();
  const executionId = randomUUID();
  await store.createExecution({
    executionId,
    intentId: executionId,
    projectId,
    workflowId: 'flow',
    workflowVersion: 1,
    methodologyPins: { STAGE: {} },
    scope: 'feature',
    repos: ['owner/repo'],
    branch: 'intent/branch',
    baseBranch: 'develop',
  });
  meta = await store.updateExecution({
    executionId,
    status: 'SUCCEEDED',
    orchestratorRunId: 'run-one',
  });
});
const request = (body, over = {}) =>
  handler({
    httpMethod: 'POST',
    path: `/projects/${projectId}/intents/${meta.executionId}/delivery`,
    pathParameters: { projectId, intentId: meta.executionId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: userId } } },
    ...over,
  });
const launches = () =>
  lambda
    .commandCalls(InvokeCommand)
    .filter((c) => c.args[0].input.FunctionName === 'delivery-orchestrator');
it('checks historical delivery read-only then admits exactly one repeated/concurrent confirmation', async () => {
  const p = await request({ preview: true });
  expect(p.statusCode).toBe(200);
  const preview = JSON.parse(p.body);
  expect(preview.historical).toBe(true);
  expect(await store.getDelivery(meta.executionId, 'run-one')).toBeNull();
  expect(launches()).toHaveLength(0);
  const results = await Promise.all([
    request({ previewToken: preview.previewToken }),
    request({ previewToken: preview.previewToken }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
  expect(launches()).toHaveLength(1);
  expect(
    (await request({}, { path: `/projects/${projectId}/intents/${meta.executionId}/rewind` }))
      .statusCode,
  ).toBe(409);
  const payload = JSON.parse(Buffer.from(launches()[0].args[0].input.Payload).toString());
  expect(payload).toMatchObject({ action: 'retry-delivery', runId: 'run-one', projectId });
  expect(providerCalls.every((c) => c.operation === 'delivery-inspect')).toBe(true);
  expect((await store.getExecution(meta.executionId)).status).toBe('SUCCEEDED');
});
it('rejects a changed branch preview and never starts publication', async () => {
  const preview = JSON.parse((await request({ preview: true })).body);
  remoteHead = 'head-two';
  const result = await request({ previewToken: preview.previewToken });
  expect(result.statusCode).toBe(409);
  expect(launches()).toHaveLength(0);
});
it('keeps an uncertain accepted launch fenced until the bounded lease expires', async () => {
  const preview = JSON.parse((await request({ preview: true })).body);
  lambda
    .on(InvokeCommand, { FunctionName: 'delivery-orchestrator' })
    .rejects(new Error('response lost'));
  const result = await request({ previewToken: preview.previewToken });
  expect(result.statusCode).toBe(202);
  expect(JSON.parse(result.body).message).toContain('uncertain');
  expect((await request({ preview: true })).statusCode).toBe(409);
});
it('enforces authentication, membership, project scope, and recovery roles', async () => {
  expect((await request({ preview: true }, { requestContext: {} })).statusCode).toBe(401);
  expect(
    (
      await request(
        { preview: true },
        { requestContext: { authorizer: { claims: { sub: 'outsider' } } } },
      )
    ).statusCode,
  ).toBe(403);
  await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .property('role', 'member')
    .toList();
  expect((await request({ preview: true })).statusCode).toBe(403);
  await g.V().has('Project', 'id', projectId).outE('HAS_MEMBER').property('role', 'admin').toList();
  expect((await request({ preview: true })).statusCode).toBe(200);
  expect(
    (await request({ preview: true }, { pathParameters: { projectId, intentId: 'foreign' } }))
      .statusCode,
  ).toBe(404);
  const foreign = randomUUID();
  await store.createExecution({
    executionId: foreign,
    intentId: foreign,
    projectId: 'another-project',
  });
  expect(
    (await request({ preview: true }, { pathParameters: { projectId, intentId: foreign } }))
      .statusCode,
  ).toBe(404);
  expect(launches()).toHaveLength(0);
});
it('refuses missing or unfinished stage/section records without provider requests', async () => {
  plan.stages = [{ stageId: 'build' }];
  expect((await request({ preview: true })).statusCode).toBe(409);
  plan.stages = [{ stageId: 'code', parallelSection: 1 }];
  expect((await request({ preview: true })).statusCode).toBe(409);
  expect(providerCalls).toHaveLength(0);
  expect(launches()).toHaveLength(0);
});
