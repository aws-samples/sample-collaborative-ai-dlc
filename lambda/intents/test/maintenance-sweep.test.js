import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetDurableExecutionCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';

// The scheduled watchdog against DynamoDB Local: the sweep reads the active
// index one page per tick and resumes from a durable cursor, so an intent
// past the first page is still checked and repaired.

const lambda = mockClient(LambdaClient);
const ssm = mockClient(SSMClient);
const tables = [];
let db, handler, store, durableStatus, durableDelayMs, durableCalls;

const lambdaContext = (remainingMs = 120_000) => ({
  functionName: 'intents',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:111122223333:function:intents',
  memoryLimitInMB: '512',
  awsRequestId: randomUUID(),
  getRemainingTimeInMillis: () => remainingMs,
});

const tick = (remainingMs) =>
  handler(
    { source: 'aws.events', 'detail-type': 'Scheduled Event' },
    lambdaContext(remainingMs),
  ).then((out) => out.durableExecutions);

const idOf = (i) => `exec-${String(i).padStart(3, '0')}`;
const arnOf = (id) => `arn:aws:lambda:us-east-1:111122223333:function:orchestrator:durable:${id}`;

const seedRunning = async (count) => {
  for (let i = 0; i < count; i += 1) {
    const executionId = idOf(i);
    await store.createExecution({
      executionId,
      intentId: executionId,
      projectId: 'project-1',
      workflowId: 'flow',
      workflowVersion: 1,
      methodologyPins: { STAGE: {} },
      scope: 'feature',
      repos: ['owner/repo'],
      branch: `intent/${executionId}`,
      baseBranch: 'main',
    });
    await store.updateExecution({
      executionId,
      status: 'RUNNING',
      orchestratorRunId: `run-${executionId}`,
      durableExecutionArn: arnOf(executionId),
      orchestratorExpiresAt: '2099-01-01T00:00:00.000Z',
    });
  }
};

beforeAll(async () => {
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
  vi.stubEnv('V2_ORCHESTRATOR_FUNCTION', 'orchestrator');
  db = makeDdb();
  ({ handler } = await import('../index.js'));
});

afterAll(async () => {
  await Promise.all(tables.map((name) => deleteV2Table(db.client, name)));
  db.client.destroy();
  lambda.restore();
  ssm.restore();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const tableName = `maintenance-sweep-${randomUUID()}`;
  tables.push(tableName);
  await createV2Table(db.client, tableName);
  vi.stubEnv('V2_PROCESS_TABLE', tableName);
  vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '');
  store = createProcessStore({ ddb: db.doc, tableName });
  durableStatus = () => 'RUNNING';
  durableDelayMs = 0;
  durableCalls = [];
  lambda.reset();
  ssm.reset();
  ssm.on(GetParameterCommand).rejects(new Error('no fixture'));
  lambda.on(GetDurableExecutionCommand).callsFake(async (input) => {
    const id = input.DurableExecutionArn.split(':').at(-1);
    durableCalls.push(id);
    if (durableDelayMs) await new Promise((resolve) => setTimeout(resolve, durableDelayMs));
    return { Status: durableStatus(id) };
  });
});

afterEach(() => {
  vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '');
});

describe('durable watchdog sweep', () => {
  it('repairs an orphaned intent that sorts after the first 100 active intents', async () => {
    await seedRunning(150);
    const orphan = idOf(140);
    durableStatus = (id) => (id === orphan ? 'FAILED' : 'RUNNING');

    const first = await tick();
    expect(first).toMatchObject({ checked: 100, repaired: 0, errors: [] });
    expect((await store.getExecution(orphan)).status).toBe('RUNNING');

    const second = await tick();
    expect(second).toMatchObject({ checked: 50, repaired: 1, errors: [] });
    expect(await store.getExecution(orphan)).toMatchObject({
      status: 'FAILED',
      failureReason: 'durable_execution_failed',
    });
    expect(new Set(durableCalls).size).toBe(150);

    // The lap ended, so the next tick starts over from the first intent.
    durableCalls = [];
    expect(await tick()).toMatchObject({ checked: 100, repaired: 0 });
    expect(durableCalls[0]).toBe(idOf(0));
  });

  it('moves past a cursor whose intent has left the active index', async () => {
    vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '2');
    await seedRunning(5);

    expect(await tick()).toMatchObject({ checked: 2 });
    expect(durableCalls).toEqual([idOf(0), idOf(1)]);
    await store.updateExecution({
      executionId: idOf(1),
      status: 'SUCCEEDED',
      completedAt: new Date().toISOString(),
    });

    durableCalls = [];
    expect(await tick()).toMatchObject({ checked: 2 });
    expect(durableCalls).toEqual([idOf(2), idOf(3)]);
    durableCalls = [];
    expect(await tick()).toMatchObject({ checked: 1 });
    expect(durableCalls).toEqual([idOf(4)]);
  });

  it('lets overlapping ticks claim a page at most once', async () => {
    vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '2');
    await seedRunning(4);
    const orphan = idOf(0);
    durableStatus = (id) => (id === orphan ? 'FAILED' : 'RUNNING');

    // Two ticks cannot finish a lap here, so a row checked twice would mean a
    // page claimed twice.
    const results = await Promise.all([tick(), tick()]);

    expect(results.reduce((sum, out) => sum + out.repaired, 0)).toBe(1);
    expect(durableCalls).toHaveLength(new Set(durableCalls).size);
    expect((await store.getExecution(orphan)).status).toBe('FAILED');
  });

  it('stops at its time budget and leaves the unchecked intents to the next tick', async () => {
    await seedRunning(8);
    durableDelayMs = 200;

    // 60% of 1.5 s: the sweep stops well before checking all eight.
    const first = await tick(1_500);
    expect(first.checked).toBeGreaterThan(0);
    expect(first.checked).toBeLessThan(8);
    const checkedFirst = [...durableCalls];

    durableDelayMs = 0;
    durableCalls = [];
    const second = await tick();
    expect(second.checked).toBe(8 - first.checked);
    expect([...checkedFirst, ...durableCalls]).toEqual(
      Array.from({ length: 8 }, (_, i) => idOf(i)),
    );
  });

  it('keeps the cursor when another sweep moved it first', async () => {
    expect(await store.getMaintenanceCursor('test-sweep')).toEqual({
      after: null,
      version: 0,
      lapStartedAt: null,
    });
    expect(await store.moveMaintenanceCursor({ sweep: 'test-sweep', after: 'A', version: 0 })).toBe(
      true,
    );
    expect(await store.moveMaintenanceCursor({ sweep: 'test-sweep', after: 'B', version: 0 })).toBe(
      false,
    );
    expect(await store.getMaintenanceCursor('test-sweep')).toMatchObject({
      after: 'A',
      version: 1,
    });
  });
});
