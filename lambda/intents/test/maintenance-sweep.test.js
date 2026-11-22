import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { Logger } from '@aws-lambda-powertools/logger';
import { GetDurableExecutionCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { unitKey } from '../../shared/v2-process-keys.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';

// The scheduled sweeps against DynamoDB Local: each reads its sparse index one
// page per tick and resumes from a durable cursor, so an intent or a PR wait
// past the first page is still checked.

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

const scheduledTick = (remainingMs) =>
  handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' }, lambdaContext(remainingMs));
const tick = (remainingMs) => scheduledTick(remainingMs).then((out) => out.durableExecutions);

// Seeding 150 rows takes seconds on DynamoDB Local under the full suite.
const SEED_TIMEOUT_MS = 30_000;

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

// A unit lane parked on its PR, bound to the index by the real bind path.
// A wait bound by an earlier run is stale and must be cleared.
const seedWait = async (executionId, { runId }) => {
  await db.doc.send(
    new PutCommand({
      TableName: process.env.V2_PROCESS_TABLE,
      Item: {
        ...unitKey(executionId, 1, 'views'),
        type: 'Unit',
        executionId,
        sectionIndex: 1,
        slug: 'views',
        state: 'PR_READY',
      },
    }),
  );
  return store.bindUnitPrWait({
    executionId,
    sectionIndex: 1,
    slug: 'views',
    callbackId: `callback-${executionId}`,
    runId,
    snapshot: [],
  });
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
  it(
    'repairs an orphaned intent that sorts after the first 100 active intents',
    async () => {
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
    },
    SEED_TIMEOUT_MS,
  );

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

  it('reports a completed lap when the intents fill the last page exactly', async () => {
    vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '2');
    await seedRunning(4);
    const info = vi.spyOn(Logger.prototype, 'info');
    const watchdogLines = () =>
      info.mock.calls
        .filter(
          ([message, extra]) =>
            message === 'Scheduled maintenance sweep' && extra?.sweep === 'durable-watchdog',
        )
        .map(([, extra]) => extra);
    try {
      await tick();
      await tick();
      expect(watchdogLines().some((line) => line.lapCompleted)).toBe(false);

      durableCalls = [];
      expect(await tick()).toMatchObject({ checked: 2 });
      expect(durableCalls).toEqual([idOf(0), idOf(1)]);
      const [, , wrapped] = watchdogLines();
      expect(wrapped).toMatchObject({ lapCompleted: true, checked: 2, contended: false });
      expect(wrapped.lapMs).toBeGreaterThanOrEqual(0);
    } finally {
      info.mockRestore();
    }
  });

  it.each([
    ['a version that is not an integer', { version: '3', after: null }],
    ['an after that is not a string', { version: 4, after: 42 }],
    ['an after longer than a sort key', { version: 4, after: `EXEC#${'x'.repeat(2_000)}` }],
  ])('replaces a stored cursor with %s and sweeps from the start', async (_, stored) => {
    await seedRunning(3);
    await db.doc.send(
      new PutCommand({
        TableName: process.env.V2_PROCESS_TABLE,
        Item: { pk: 'MAINTENANCE#durable-watchdog', sk: 'CURSOR', ...stored },
      }),
    );

    expect(await tick()).toMatchObject({ checked: 3 });
    expect(await store.getMaintenanceCursor('durable-watchdog')).toMatchObject({
      after: null,
      version: 1,
    });
    expect(await tick()).toMatchObject({ checked: 3 });
  });

  it('tells a manual repair how far the shared cursor got', async () => {
    vi.stubEnv('DURABLE_WATCHDOG_LIMIT', '2');
    await seedRunning(3);
    const info = vi.spyOn(Logger.prototype, 'info');
    const repair = () => handler({ action: 'repair-durable-executions' }, lambdaContext());
    try {
      expect(await repair()).toMatchObject({
        checked: 2,
        deferred: 0,
        contended: false,
        lapCompleted: false,
      });
      expect(await repair()).toMatchObject({ checked: 1, lapCompleted: true });
      const lines = info.mock.calls
        .filter(([message]) => message === 'Scheduled maintenance sweep')
        .map(([, extra]) => extra);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.trigger === 'manual')).toBe(true);
      expect(lines[1].lapAgeMs).toBeGreaterThanOrEqual(0);
    } finally {
      info.mockRestore();
    }
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

describe('PR-wait reconciler sweep', () => {
  it(
    'clears a stale PR wait that sorts after the first 100 waits',
    async () => {
      await seedRunning(150);
      const stale = idOf(140);
      for (let i = 0; i < 150; i += 1) {
        const executionId = idOf(i);
        expect(
          await seedWait(executionId, {
            runId: executionId === stale ? 'run-earlier' : `run-${executionId}`,
          }),
        ).toBeTruthy();
      }

      const first = (await scheduledTick()).prWaits;
      expect(first).toMatchObject({ checked: 100, stale: 0, unchanged: 100, errors: [] });

      const second = (await scheduledTick()).prWaits;
      expect(second).toMatchObject({ checked: 50, stale: 1, unchanged: 49, errors: [] });
      const cleared = await store.getUnit(stale, 1, 'views');
      expect(cleared.prWaitCallbackId).toBeUndefined();
      expect(cleared.GSI3PK).toBeUndefined();
    },
    SEED_TIMEOUT_MS,
  );
});

describe('scheduled maintenance tick', () => {
  const sweepLines = (info) =>
    info.mock.calls
      .filter(([message]) => message === 'Scheduled maintenance sweep')
      .map(([, extra]) => extra.sweep);

  // Fails the cursor read of one sweep the way a DynamoDB outage would.
  const failCursorReadOf = (sweep) => {
    const send = DynamoDBDocumentClient.prototype.send;
    return vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(function (
      command,
      ...rest
    ) {
      if (command instanceof GetCommand && command.input.Key?.pk === `MAINTENANCE#${sweep}`) {
        return Promise.reject(
          Object.assign(new Error('Throughput exceeds the current capacity'), {
            name: 'ProvisionedThroughputExceededException',
          }),
        );
      }
      return send.call(this, command, ...rest);
    });
  };

  it('runs the watchdog before the reconciler', async () => {
    const info = vi.spyOn(Logger.prototype, 'info');
    try {
      await scheduledTick();
      expect(sweepLines(info)).toEqual(['durable-watchdog', 'pr-wait-reconciler']);
    } finally {
      info.mockRestore();
    }
  });

  it('still runs the reconciler and succeeds when the watchdog cannot read its cursor', async () => {
    await seedRunning(1);
    await seedWait(idOf(0), { runId: 'run-earlier' });
    const failing = failCursorReadOf('durable-watchdog');
    try {
      const out = await scheduledTick();
      expect(out.durableExecutions).toMatchObject({ failed: true });
      expect(out.prWaits).toMatchObject({ checked: 1, stale: 1, errors: [] });
    } finally {
      failing.mockRestore();
    }
  });

  it('still runs the watchdog and succeeds when the reconciler cannot read its cursor', async () => {
    await seedRunning(1);
    durableStatus = () => 'FAILED';
    const failing = failCursorReadOf('pr-wait-reconciler');
    try {
      const out = await scheduledTick();
      expect(out.prWaits).toMatchObject({ failed: true });
      expect(out.durableExecutions).toMatchObject({ checked: 1, repaired: 1 });
    } finally {
      failing.mockRestore();
    }
    expect((await store.getExecution(idOf(0))).status).toBe('FAILED');
  });

  it('keeps the watchdog under the schedule interval however much time is left', async () => {
    await seedRunning(8);
    // Each status lookup takes 5 s of wall clock; the watchdog may use 20 s.
    vi.useFakeTimers({ toFake: ['Date'] });
    lambda.on(GetDurableExecutionCommand).callsFake(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return { Status: 'RUNNING' };
    });
    try {
      const out = await scheduledTick(120_000);
      expect(out.durableExecutions.checked).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
