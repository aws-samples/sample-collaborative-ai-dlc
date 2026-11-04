import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { createNativeExecutionStore } from '../execution-store.js';
import { createNativeProjectionStore, nativeProjectionStatus } from '../projection-store.js';
import { serialFixture } from './execution-serial-fixtures.js';

it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'fences projection takeover and reconciles a lost acknowledgement independently of an accepted reply in DynamoDB Local',
  async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish({ project: false });
    const tableName = `native-projection-${randomUUID()}`;
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
    const ddb = {
      async send(command) {
        const result = await document.send(command);
        if (
          loseAcknowledgement &&
          command instanceof TransactWriteCommand &&
          command.input.TransactItems.some((item) => item.Put?.Item.sk === 'PROJECTION')
        ) {
          loseAcknowledgement = false;
          throw Object.assign(new Error('Lost projection acknowledgement'), {
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
      const projection = createNativeProjectionStore({
        ddb,
        tableName,
        execution,
        preparation: f.preparationStore,
        now: f.now,
        leaseMs: 120000,
      });
      const stale = await projection.claim(f.identity);
      expect(await execution.claim(f.bindingIdentity)).toMatchObject({ kind: 'terminal' });
      f.tick();
      const successor = await projection.claim(f.identity);
      await expect(projection.acknowledge(stale)).rejects.toMatchObject({
        code: 'NATIVE_PROJECTION_CONFLICT',
      });
      const accepted = await execution.respond({
        ...f.bindingIdentity,
        actorId: 'member',
        request: f.replyRequest(),
      });
      const writer = await execution.claim(f.bindingIdentity);
      const answer = await execution.response(writer.row, writer.row.response.interactionId);
      loseAcknowledgement = true;
      expect(await projection.acknowledge(successor)).toMatchObject({ sequence: 1 });
      expect(await execution.get(f.identity)).toEqual(writer.row);
      expect(await execution.response(writer.row, answer.interactionId)).toEqual(answer);
      expect(await nativeProjectionStatus(ddb, tableName, writer.row)).toBe('complete');
      expect(await projection.claim(f.identity)).toEqual({ kind: 'complete' });
      const dispatched = await execution.dispatchAttempted({ row: writer.row });
      expect(dispatched.dispatch.commandId).toBe(accepted.response.commandId);
      const running = await execution.dispatched({ row: dispatched });
      expect(running.response.deliveryStatus).toBe('delivered');
      expect(await execution.response(running, answer.interactionId)).toEqual(answer);
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
      raw.destroy();
    }
  },
);
