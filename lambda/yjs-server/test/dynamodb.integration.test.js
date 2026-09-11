import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AwsStore } from '../aws-store.js';
import { scopeKey } from '../cluster.js';
import { DOCUMENT, logger } from './helpers.js';

// The root test runner starts DynamoDB Local. The transport-only npm test in
// this package remains usable without Docker.
describe.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)('DynamoDB ownership transactions', () => {
  const prefix = `yjs-${randomUUID()}`;
  const documentsTable = `${prefix}-docs`;
  const membersTable = `${prefix}-members`;
  let raw;
  let ddb;
  let store;
  const objects = new Map();
  beforeAll(async () => {
    raw = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    ddb = DynamoDBDocumentClient.from(raw);
    for (const [TableName, AttributeName] of [
      [documentsTable, 'documentId'],
      [membersTable, 'id'],
    ]) {
      await raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName, KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName, AttributeType: 'S' }],
        }),
      );
    }
    store = new AwsStore({
      documentsTable,
      membersTable,
      bucket: 'test',
      ddb,
      logger,
      s3: {
        send: async (command) => {
          const { Key, Body } = command.input;
          if (command.constructor.name === 'PutObjectCommand') {
            objects.set(Key, Body.slice());
            return { VersionId: '1' };
          }
          if (command.constructor.name === 'DeleteObjectCommand') {
            objects.delete(Key);
            return {};
          }
          return { Body: { transformToByteArray: async () => objects.get(Key) } };
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    for (const TableName of [documentsTable, membersTable])
      await raw.send(new DeleteTableCommand({ TableName }));
    raw.destroy();
  });
  const lease = (documentId) => ({
    documentId,
    ownerId: randomUUID(),
    ownerAddress: 'ws://10.0.0.1:1234',
    leaseToken: randomUUID(),
    leaseUntil: Date.now() + 30_000,
  });

  it('allows one concurrent acquirer, fences old owners, and recovers the manifest', async () => {
    const name = `${DOCUMENT}-race`;
    const candidates = Array.from({ length: 8 }, () => lease(name));
    const results = await Promise.allSettled(
      candidates.map((candidate) => store.claim(candidate, Date.now())),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const owner = results.find((result) => result.status === 'fulfilled').value;
    await store.renew(owner, Date.now() + 30_000, Date.now());
    const saved = await store.save(owner, new Uint8Array([1, 2, 3]), Date.now());
    await store.release(owner);
    const successor = await store.claim(lease(name), Date.now());
    expect(successor.snapshotKey).toBe(saved.snapshotKey);
    expect(await store.load(successor)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(store.renew(owner, Date.now() + 30_000, Date.now())).rejects.toThrow();
    await expect(store.save(owner, new Uint8Array([4]), Date.now())).rejects.toThrow(
      'ownership changed',
    );
    await expect(store.release(owner)).rejects.toThrow();
  });

  it('blocks checkpoints and reacquisition for a revoked parent scope', async () => {
    const name = DOCUMENT.replace('b6326738', 'a6326738');
    const owner = await store.claim(lease(name), Date.now());
    await ddb.send(
      new PutCommand({
        TableName: documentsTable,
        Item: { documentId: scopeKey(name), deletedAt: Date.now() },
      }),
    );
    await expect(store.renew(owner, Date.now() + 30_000, Date.now())).rejects.toThrow();
    await expect(store.save(owner, new Uint8Array([5]), Date.now())).rejects.toThrow();
    await store.release(owner);
    await expect(store.claim(lease(name), Date.now())).rejects.toThrow();
  });

  it('prevents a delayed checkpoint from replacing a newer sequence', async () => {
    const name = `${DOCUMENT}-sequence`;
    const owner = await store.claim(lease(name), Date.now());
    await store.save(owner, new Uint8Array([1]), Date.now());
    await store.save(owner, new Uint8Array([2]), Date.now());
    await expect(
      ddb.send(
        new UpdateCommand({
          TableName: documentsTable,
          Key: { documentId: name },
          UpdateExpression: 'SET snapshotSequence = :next',
          ConditionExpression: 'snapshotSequence = :previous',
          ExpressionAttributeValues: { ':next': 2, ':previous': 1 },
        }),
      ),
    ).rejects.toThrow();
    expect(await store.load(await store.get(name))).toEqual(new Uint8Array([2]));
  });

  it('filters expired member leases independently of DynamoDB TTL deletion', async () => {
    await store.register({ id: 'expired', address: 'ws://10.0.0.1:1234', expiresAt: 1 });
    await store.register({
      id: 'live',
      address: 'ws://10.0.0.2:1234',
      expiresAt: Math.ceil(Date.now() / 1000) + 30,
    });
    expect((await store.members(Date.now())).map((member) => member.id)).toEqual(['live']);
    await store.unregister('live');
    expect(await store.members(Date.now())).toEqual([]);
  });
});
