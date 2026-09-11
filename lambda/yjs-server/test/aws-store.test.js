import { describe, expect, it, vi } from 'vitest';
import { AwsStore } from '../aws-store.js';
import { snapshotPrefix } from '../cluster.js';
import { DOCUMENT, logger } from './helpers.js';
import { revokeYjsScope } from '../../shared/yjs-revocation.js';

const fixture = (failure) => {
  const previous = {
    documentId: DOCUMENT,
    leaseToken: 'owner-token',
    snapshotSequence: 1,
    snapshotKey: `${snapshotPrefix(DOCUMENT)}previous.bin`,
    snapshotVersion: 'old-version',
  };
  let committed = { ...previous };
  const ddb = {
    send: vi.fn(async (command) => {
      if (command.constructor.name === 'GetCommand') return { Item: { ...committed } };
      if (command.constructor.name === 'TransactWriteCommand') {
        const values = command.input.TransactItems[1].Update.ExpressionAttributeValues;
        if (failure === 'response-lost') committed = { ...previous, snapshotKey: values[':key'] };
        if (failure)
          throw Object.assign(new Error('Storage failure'), {
            name: failure === 'cancelled' ? 'TransactionCanceledException' : 'TimeoutError',
          });
        return {};
      }
      throw new Error('Unexpected command');
    }),
  };
  const s3 = {
    send: vi.fn(async (command) => {
      if (command.constructor.name === 'PutObjectCommand') return { VersionId: 'new-version' };
      if (command.constructor.name === 'GetObjectCommand')
        return { Body: { transformToByteArray: async () => new Uint8Array([1]) } };
      return {};
    }),
  };
  const store = new AwsStore({
    documentsTable: 'docs',
    membersTable: 'nodes',
    bucket: 'snapshots',
    ddb,
    s3,
    logger,
  });
  const deleted = () =>
    s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === 'DeleteObjectCommand')
      .map((command) => command.input);
  return { store, previous, s3, ddb, deleted };
};

describe('AWS checkpoint failures', () => {
  it('commits a fenced manifest before deleting the previous object version', async () => {
    const { store, previous, ddb, s3, deleted } = fixture();
    const result = await store.save(previous, new Uint8Array([1, 2]), 1000);
    expect(result.snapshotSequence).toBe(2);
    const transaction = ddb.send.mock.calls.find(
      ([c]) => c.constructor.name === 'TransactWriteCommand',
    )[0].input;
    expect(transaction.TransactItems[0].ConditionCheck.ConditionExpression).toBe(
      'attribute_not_exists(deletedAt)',
    );
    expect(transaction.TransactItems[1].Update.ExpressionAttributeValues).toMatchObject({
      ':token': 'owner-token',
      ':previous': 1,
      ':sequence': 2,
      ':version': 'new-version',
    });
    expect(deleted()).toEqual([
      { Bucket: 'snapshots', Key: previous.snapshotKey, VersionId: 'old-version' },
    ]);
    expect(s3.send.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      ddb.send.mock.invocationCallOrder.at(-1),
    );
  });

  it('recognizes a committed transaction whose response was lost', async () => {
    const { store, previous, deleted } = fixture('response-lost');
    await expect(store.save(previous, new Uint8Array([1]), 1000)).resolves.toMatchObject({
      snapshotSequence: 2,
    });
    expect(deleted().map((entry) => entry.Key)).toEqual([previous.snapshotKey]);
  });

  it('retains an uncertain upload because its manifest may commit later', async () => {
    const { store, previous, deleted } = fixture('timeout');
    await expect(store.save(previous, new Uint8Array([1]), 1000)).rejects.toThrow(
      'Storage failure',
    );
    expect(deleted()).toEqual([]);
  });

  it('cleans only the rejected candidate after definitive cancellation', async () => {
    const { store, previous, deleted } = fixture('cancelled');
    await expect(store.save(previous, new Uint8Array([1]), 1000)).rejects.toThrow(
      'Storage failure',
    );
    expect(deleted()).toHaveLength(1);
    expect(deleted()[0].Key).not.toBe(previous.snapshotKey);
    expect(deleted()[0].VersionId).toBe('new-version');
  });

  it('reads the committed S3 version and rejects references outside the document', async () => {
    const { store, previous, s3 } = fixture();
    await store.load(previous);
    expect(s3.send.mock.calls[0][0].input).toMatchObject({ VersionId: 'old-version' });
    await expect(
      store.load({ ...previous, snapshotKey: 'another-scope/data.bin' }),
    ).rejects.toThrow('Invalid snapshot');
  });

  it('revokes a deleted scope without removing stored snapshots', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    await revokeYjsScope({
      ddb,
      table: 'docs',
      type: 'intent',
      id: 'B6326738-6B97-4819-829A-565EE8903E38',
    });
    expect(ddb.send.mock.calls[0][0].input.Item).toEqual({
      documentId: 'scope#intent:b6326738-6b97-4819-829a-565ee8903e38',
      deletedAt: expect.any(Number),
    });
    ddb.send.mockRejectedValue(new Error('Unavailable'));
    await expect(
      revokeYjsScope({
        ddb,
        table: 'docs',
        type: 'intent',
        id: 'b6326738-6b97-4819-829a-565ee8903e38',
      }),
    ).rejects.toThrow('Unavailable');
  });
});
