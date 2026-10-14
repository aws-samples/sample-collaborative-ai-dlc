import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { createNativeExecutionStore } from '../execution-store.js';
import { nativeExecutionView } from '../execution-api.js';
import { executionFixture } from './execution-fixtures.js';

const ready = async () => {
  const f = executionFixture();
  await f.start();
  let { row } = await f.store.claim(f.bindingIdentity);
  row = await f.store.advance({
    row,
    patch: {
      status: 'DISPATCHING',
      target: f.target(row),
      sourceCommit: 'a'.repeat(40),
      sourceBranch: 'main',
    },
  });
  return { ...f, owned: row };
};

it('does not infer stop from old terminal/recovery rows, fences, elapsed time or a request', async () => {
  const f = await ready();
  for (const status of ['STOPPED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'RECOVERING']) {
    expect(nativeExecutionView({ ...f.row(), status }).stopStatus).toEqual({
      state: 'unconfirmed',
      confirmedAt: null,
    });
  }
  await f.store.cancel(f.bindingIdentity);
  f.tick();
  expect(nativeExecutionView(await f.store.get(f.identity)).stopStatus.state).toBe('pending');
});

it('atomically records exact stop evidence with uncertainty and exposes only a public timestamp', async () => {
  const f = await ready();
  let lost = false;
  f.hooks.after = (command) => {
    if (command instanceof TransactWriteCommand && !lost) {
      lost = true;
      throw new Error('acknowledgement lost after commit');
    }
  };
  const row = await f.store.recoveryRequired({
    row: f.owned,
    reason: 'DELIVERY_UNCERTAIN',
    stoppedSessionId: f.owned.runtimeSessionId,
  });
  expect(row).toEqual(await f.store.get(f.identity));
  expect(row.recovery.canRecover).toBe(false);
  expect(nativeExecutionView(row).stopStatus).toEqual({
    state: 'confirmed',
    confirmedAt: new Date(f.now()).toISOString(),
  });
  expect(JSON.stringify(nativeExecutionView(row))).not.toMatch(
    /runtimeSessionId|stopConfirmation|writerGeneration|clientToken/,
  );
  await expect(
    f.store.recover({
      ...f.bindingIdentity,
      request: { requestId: randomUUID(), recoveryId: row.recovery.id },
    }),
  ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
  expect(nativeExecutionView({ ...row, writerGeneration: 2 }).stopStatus.state).toBe('unconfirmed');
  expect(nativeExecutionView({ ...row, status: 'RECOVERING' }).stopStatus.state).toBe(
    'unconfirmed',
  );
});

it.each(['wrong-session', null, '', 17])(
  'rejects foreign or malformed stop scope %j',
  async (id) => {
    const f = await ready();
    await expect(
      f.store.recoveryRequired({
        row: f.owned,
        reason: 'DELIVERY_UNCERTAIN',
        stoppedSessionId: id,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_INVALID' });
    expect(f.row()).toEqual(f.owned);
  },
);

it('does not manufacture proof before a target was admitted or on a nonterminal advance', async () => {
  const f = executionFixture();
  await f.start();
  const { row } = await f.store.claim(f.bindingIdentity);
  for (const status of ['FAILED', 'UPGRADING']) {
    await expect(
      f.store.advance({ row, patch: { status }, stoppedSessionId: row.runtimeSessionId }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_INVALID' });
  }
  expect(f.row()).toEqual(row);
});

it('a cancelled worker cannot attach stop evidence after a new cancellation owner wins', async () => {
  const f = await ready();
  const cancelled = await f.store.cancel(f.bindingIdentity);
  await expect(
    f.store.recoveryRequired({
      row: f.owned,
      reason: 'DELIVERY_UNCERTAIN',
      stoppedSessionId: f.owned.runtimeSessionId,
    }),
  ).rejects.toThrow();
  expect(f.row()).toEqual(cancelled);
  const { row } = await f.store.claim(f.bindingIdentity);
  const finished = await f.store.advance({
    row,
    patch: { status: 'CANCELLED' },
    stoppedSessionId: row.runtimeSessionId,
  });
  expect(finished.epoch).toBe(2);
  expect(nativeExecutionView(finished).stopStatus.state).toBe('confirmed');
});

it('uses real DynamoDB conditions for cancellation, lost acknowledgements and late observers', async () => {
  const f = await ready();
  const tableName = `native-stop-${randomUUID()}`;
  const raw = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const ddb = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  await raw.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    }),
  );
  try {
    await ddb.send(new PutCommand({ TableName: tableName, Item: f.owned }));
    let loseAcknowledgement = false;
    let cancelBeforeCommit = false;
    const store = createNativeExecutionStore({
      ddb: {
        async send(command) {
          if (cancelBeforeCommit && command instanceof TransactWriteCommand) {
            cancelBeforeCommit = false;
            await store.cancel(f.bindingIdentity);
          }
          const result = await ddb.send(command);
          if (loseAcknowledgement && command instanceof TransactWriteCommand) {
            loseAcknowledgement = false;
            throw new Error('committed response lost');
          }
          return result;
        },
      },
      tableName,
      preparationStore: f.preparationStore,
      now: f.now,
    });
    cancelBeforeCommit = true;
    await expect(
      store.recoveryRequired({
        row: f.owned,
        reason: 'DELIVERY_UNCERTAIN',
        stoppedSessionId: f.owned.runtimeSessionId,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    const cancelled = await store.get(f.identity);
    expect(cancelled.stopConfirmation).toBeUndefined();
    expect(cancelled.status).toBe('CANCEL_REQUESTED');
    const duplicates = await Promise.all([
      store.cancel(f.bindingIdentity),
      store.cancel(f.bindingIdentity),
    ]);
    expect(duplicates).toEqual([cancelled, cancelled]);
    const { row } = await store.claim(f.bindingIdentity);
    loseAcknowledgement = true;
    const stopped = await store.advance({
      row,
      patch: { status: 'CANCELLED' },
      stoppedSessionId: row.runtimeSessionId,
    });
    expect(await store.get(f.identity)).toEqual(stopped);
    expect(nativeExecutionView(stopped).stopStatus.state).toBe('confirmed');
    await expect(
      store.advance({
        row: f.owned,
        patch: { status: 'FAILED' },
        stoppedSessionId: f.owned.runtimeSessionId,
      }),
    ).rejects.toThrow();
    expect(await store.get(f.identity)).toEqual(stopped);
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: tableName }));
    raw.destroy();
  }
});
