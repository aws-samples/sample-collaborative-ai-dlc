import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { createNativeExecutionStore, nativeExecutionKey } from '../execution-store.js';
import {
  createNativeEngineStore,
  nativeEngineIdentity,
  nativeEngineKeys,
} from '../workflow-engine/store.js';
import { serialFixture } from './execution-serial-fixtures.js';

it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'serializes real engine operations, resolves lost commit acknowledgements, and fences cancellation at the write',
  async () => {
    const f = serialFixture();
    await f.ready();
    const tableName = `native-engine-${randomUUID()}`;
    const raw = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const document = DynamoDBDocumentClient.from(raw);
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
    let loseAcknowledgement = false;
    let cancelDuringCommit = false;
    const ddb = {
      async send(command) {
        if (command instanceof TransactWriteCommand && cancelDuringCommit) {
          cancelDuringCommit = false;
          const key = nativeExecutionKey(f.identity);
          const { Item } = await document.send(new GetCommand({ TableName: tableName, Key: key }));
          await document.send(
            new PutCommand({
              TableName: tableName,
              Item: { ...Item, cancelRequested: true },
            }),
          );
        }
        const result = await document.send(command);
        if (command instanceof TransactWriteCommand && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw Object.assign(new Error('Lost engine commit acknowledgement'), {
            name: 'TimeoutError',
          });
        }
        return result;
      },
    };
    try {
      for (const Item of f.rows.values())
        await document.send(new PutCommand({ TableName: tableName, Item }));
      const execution = createNativeExecutionStore({
        ddb,
        tableName,
        preparationStore: f.preparationStore,
        now: f.now,
      });
      const store = createNativeEngineStore({
        ddb,
        tableName,
        readExecution: execution.get,
        now: f.now,
      });
      const identity = nativeEngineIdentity(await execution.get(f.identity));
      const input = {
        identity,
        requestId: randomUUID(),
        requestSha256: 'a'.repeat(64),
        producerSha256: 'b'.repeat(64),
        expectedVersion: 0,
      };
      const racing = { ...input, requestId: randomUUID() };
      const attempts = await Promise.allSettled([store.begin(input), store.begin(racing)]);
      expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      const winner = attempts.find((value) => value.status === 'fulfilled').value;
      const winningInput = winner.operation.requestId === input.requestId ? input : racing;
      expect(winner.replay).toBe(false);
      expect(await store.begin(winningInput)).toMatchObject({
        replay: true,
        operation: winner.operation,
      });
      await expect(
        store.begin({ ...winningInput, requestSha256: 'c'.repeat(64) }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_REQUEST_CONFLICT' });
      const snapshot = {
        key: 'snapshot',
        versionId: 'version-1',
        sha256: 'd'.repeat(64),
        bytes: 100,
      };
      const result = { ...snapshot, key: 'result' };
      loseAcknowledgement = true;
      const committed = await store.finish({ operation: winner.operation, snapshot, result });
      expect(committed).toMatchObject({ status: 'completed', version: 1 });
      expect(await store.finish({ operation: winner.operation, snapshot, result })).toEqual(
        committed,
      );
      expect(await store.begin(winningInput)).toMatchObject({ replay: true, operation: committed });
      const interrupted = {
        ...input,
        requestId: randomUUID(),
        expectedVersion: 1,
        publicationId: 'f'.repeat(64),
      };
      const pending = await store.begin(interrupted);
      const target = await store.pending(identity, input.producerSha256);
      const jobId = randomUUID();
      const abandon = () =>
        store.abandon({
          identity,
          target,
          producerSha256: input.producerSha256,
          beforeAbandon: async () => {
            await store.recordJob(pending.operation, jobId, { status: 'prepared' });
            loseAcknowledgement = true;
          },
        });
      const abandoned = await abandon();
      const { Item: retained } = await document.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeEngineKeys(identity, interrupted.requestId).operation,
          ConsistentRead: true,
        }),
      );
      expect(retained).toMatchObject({
        status: 'abandoned',
        version: 2,
        jobs: { [jobId]: { status: 'prepared' } },
        abandonedBy: identity,
      });
      expect(await abandon()).toEqual(abandoned);
      await expect(store.begin(interrupted)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_ABANDONED',
      });
      await expect(
        store.finish({ operation: pending.operation, snapshot, result }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_ABANDONED' });
      expect(await store.get(identity)).toMatchObject({ version: 2, snapshot });
      await expect(
        store.begin({ ...interrupted, requestId: randomUUID(), expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_PUBLICATION_ABANDONED' });
      const next = await store.begin({ ...input, requestId: randomUUID(), expectedVersion: 2 });
      cancelDuringCommit = true;
      await expect(
        store.finish({ operation: next.operation, snapshot, result }),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
      const { Item: head } = await document.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeEngineKeys(identity).head,
          ConsistentRead: true,
        }),
      );
      expect(head.version).toBe(2);
      expect(head.pending.token).toBe(next.operation.token);
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
      raw.destroy();
    }
  },
);
