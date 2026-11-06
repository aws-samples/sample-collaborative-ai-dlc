import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { setup, owner, resources, IDENTITY, ACTOR } from './fixtures.js';
import { executionFixture } from './execution-fixtures.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { nativePreparedConfigurationPins } from '../execution-config.js';
import { nativeDraftInputs, nativeInputSnapshot } from '../../shared/native-inputs.js';

it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'atomically fences source edits, accepted Starts and lost acknowledgements in local DynamoDB',
  async () => {
    const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
    expect(endpoint.protocol).toBe('http:');
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(endpoint.hostname);
    expect(endpoint.username + endpoint.password + endpoint.search + endpoint.hash).toBe('');
    const raw = new DynamoDBClient({
      endpoint: endpoint.href,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const ddb = DynamoDBDocumentClient.from(raw, {
      marshallOptions: { removeUndefinedValues: true },
    });
    const tableName = `native-inputs-${randomUUID()}`;
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
      let loseResponse = false;
      let beforeTransaction;
      const client = {
        async send(command) {
          if (command instanceof TransactWriteCommand && beforeTransaction) {
            const run = beforeTransaction;
            beforeTransaction = undefined;
            await run();
          }
          const result = await ddb.send(command);
          if (loseResponse && command instanceof TransactWriteCommand) {
            loseResponse = false;
            throw new Error('Committed acknowledgement lost');
          }
          return result;
        },
      };
      const f = setup({ ddb: client, tableName });
      const claimed = await f.claimed();
      let draft = await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
      const edit = (expectedRevision, repository) =>
        f.store.saveInputs({
          ...IDENTITY,
          expectedRevision,
          inputs: {
            ...nativeDraftInputs(draft),
            applicationSource: { provider: 'github', repository },
          },
        });
      loseResponse = true;
      draft = await edit(0, 'owner/first');
      expect(nativeDraftInputs(draft).revision).toBe(1);
      await expect(edit(0, 'owner/second')).rejects.toMatchObject({
        code: 'NATIVE_INPUT_CONFLICT',
      });
      const store = createNativeExecutionStore({
        ddb: client,
        tableName,
        preparationStore: f.store,
        now: () => 1000,
      });
      const configuration = () => ({
        ...executionFixture().configuration,
        ...nativePreparedConfigurationPins(draft),
        inputs: nativeInputSnapshot(draft, 'native-inputs'),
        repository: {
          ...executionFixture().configuration.repository,
          repository: nativeDraftInputs(draft).applicationSource.repository,
        },
      });
      const start = (requestId, config = configuration()) =>
        store.start({
          ...IDENTITY,
          actorId: ACTOR,
          requestId,
          promptRevision: 0,
          inputRevision: config.inputs.revision,
          configuration: config,
        });
      const oldConfig = configuration();
      beforeTransaction = async () => {
        draft = await edit(1, 'owner/second');
      };
      await expect(start('racing-start', oldConfig)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_CONFLICT',
      });
      expect(await store.get(IDENTITY)).toBeNull();
      loseResponse = true;
      const admitted = await start('accepted-start');
      expect(admitted.row.configuration.inputs.revision).toBe(2);
      expect(admitted.row.sourceCommit).toBe(admitted.row.configuration.repository.commit);
      expect((await start('accepted-start')).row).toEqual(admitted.row);
      await expect(edit(2, 'owner/third')).rejects.toMatchObject({ code: 'NATIVE_INPUT_CONFLICT' });
      const equivalent = await start('another-start');
      expect(equivalent.created).toBe(false);
      expect(equivalent.row.requestId).toBe('accepted-start');
      await expect(start('conflicting-start', oldConfig)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_CONFLICT',
      });
      expect(await store.get(IDENTITY)).toEqual(admitted.row);
      expect(nativeDraftInputs(await f.store.get(IDENTITY)).applicationSource.repository).toBe(
        'owner/second',
      );
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
      raw.destroy();
    }
  },
);
