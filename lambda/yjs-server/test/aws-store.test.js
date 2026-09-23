import { describe, expect, it, vi } from 'vitest';
import { AwsStore } from '../aws-store.js';
import { snapshotPrefix } from '../cluster.js';
import { DOCUMENT, logger } from './helpers.js';
import { revokeYjsScope } from '../../shared/yjs-revocation.js';
import { setTimeout as sleep } from 'node:timers/promises';

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
      if (
        command.constructor.name === 'TransactWriteCommand' ||
        command.constructor.name === 'UpdateCommand'
      ) {
        const values =
          command.input.ExpressionAttributeValues ??
          command.input.TransactItems[1].Update.ExpressionAttributeValues;
        if (['response-lost', 'committed-then-conditional'].includes(failure))
          committed = { ...previous, snapshotKey: values[':key'] };
        if (failure)
          throw Object.assign(new Error('Storage failure'), {
            name: ['cancelled', 'committed-then-conditional'].includes(failure)
              ? 'ConditionalCheckFailedException'
              : 'TimeoutError',
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
  it.each(['claim'])('retries a transient %s transaction cancellation', async (operation) => {
    const { store, previous, ddb, s3 } = fixture();
    const original = ddb.send.getMockImplementation();
    let rejected = false;
    ddb.send.mockImplementation(async (command) => {
      if (command.constructor.name === 'TransactWriteCommand' && !rejected) {
        rejected = true;
        throw Object.assign(new Error('Transaction conflict'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        });
      }
      return original(command);
    });
    if (operation === 'claim') await store.claim(previous, 1000);
    if (operation === 'renew') await store.renew(previous, 31_000, 1000);
    if (operation === 'save') await store.save(previous, new Uint8Array([1]), 1000);
    const transactions = ddb.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === 'TransactWriteCommand');
    expect(transactions).toHaveLength(2);
    expect(transactions[0].input.ClientRequestToken).toBeTruthy();
    expect(transactions[1].input).toEqual(transactions[0].input);
    if (operation === 'save') {
      expect(
        s3.send.mock.calls.filter(([c]) => c.constructor.name === 'PutObjectCommand'),
      ).toHaveLength(1);
    }
  });

  it('renews unrelated documents independently without touching a shared scope guard', async () => {
    const { store, previous, ddb } = fixture();
    let active = 0;
    let peak = 0;
    ddb.send.mockImplementation(async (command) => {
      expect(command.constructor.name).toBe('UpdateCommand');
      active++;
      peak = Math.max(active, peak);
      await sleep(5);
      active--;
      return {};
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.renew({ ...previous, documentId: `${DOCUMENT}-room-${index}` }, 31_000, 1000),
      ),
    );
    expect(peak).toBe(5);
  });

  it('bounds admission queues while a scope transaction is stalled', async () => {
    const { store, previous, ddb } = fixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    ddb.send.mockImplementation(async () => {
      await gate;
      return {};
    });
    const waiting = Array.from({ length: 32 }, () => store.claim(previous, 1000));
    await expect(store.claim(previous, 1000)).rejects.toThrow('queue is full');
    release();
    await Promise.all(waiting);
    expect(store.waitingClaims.size).toBe(0);
  });

  it('commits a fenced manifest before deleting the previous object version', async () => {
    const { store, previous, ddb, s3, deleted } = fixture();
    const result = await store.save(previous, new Uint8Array([1, 2]), 1000);
    expect(result.snapshotSequence).toBe(2);
    const transaction = ddb.send.mock.calls.find(([c]) => c.constructor.name === 'UpdateCommand')[0]
      .input;
    expect(transaction.ConditionExpression).toContain('attribute_not_exists(deletedAt)');
    expect(transaction.ExpressionAttributeValues).toMatchObject({
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

  it.each(['response-lost', 'committed-then-conditional'])(
    'recognizes a committed checkpoint after %s',
    async (failure) => {
      const { store, previous, deleted } = fixture(failure);
      await expect(store.save(previous, new Uint8Array([1]), 1000)).resolves.toMatchObject({
        snapshotSequence: 2,
      });
      expect(deleted().map((entry) => entry.Key)).toEqual([previous.snapshotKey]);
    },
  );

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
    const ddb = { send: vi.fn().mockResolvedValue({ Items: [] }) };
    await revokeYjsScope({
      ddb,
      table: 'docs',
      type: 'intent',
      id: 'B6326738-6B97-4819-829A-565EE8903E38',
    });
    expect(
      ddb.send.mock.calls.find(([c]) => c.constructor.name === 'PutCommand')[0].input.Item,
    ).toMatchObject({
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
