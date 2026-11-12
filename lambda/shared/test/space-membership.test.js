import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  decodeToken,
  deleteSpaceMemberships,
  getMembershipRole,
  hasAnotherOwner,
  listSpaceMembers,
  normalizeMembershipRole,
  removeMembership,
  saveMembershipChange,
} from '../space-membership.js';

beforeEach(() => {
  process.env.ACCESS_TABLE = 'access';
  process.env.AUDIT_TABLE = 'audit';
});

describe('space membership store', () => {
  it('normalizes legacy admin as owner', () => {
    expect(normalizeMembershipRole('admin')).toBe('owner');
    expect(() => normalizeMembershipRole('viewer')).toThrow();
  });

  it('uses a consistent base-table read and fails closed on errors', async () => {
    const ddb = { send: vi.fn().mockResolvedValueOnce({ Item: { membershipRole: 'owner' } }) };
    await expect(getMembershipRole(ddb, 'space-1', 'user-1')).resolves.toBe('owner');
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(ddb.send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    ddb.send.mockRejectedValueOnce(new Error('read failed'));
    await expect(getMembershipRole(ddb, 'space-1', 'user-1')).rejects.toThrow('read failed');
  });

  it('returns opaque pagination tokens and reads every member page consistently', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({
        Items: [{ userId: 'user-1', membershipRole: 'admin' }],
        LastEvaluatedKey: { pk: 'SPACE#space-1', sk: 'MEMBER#user-1' },
      }),
    };
    const page = await listSpaceMembers(ddb, 'space-1');
    expect(page.items[0].membershipRole).toBe('owner');
    expect(decodeToken(page.nextToken)).toEqual({
      pk: 'SPACE#space-1',
      sk: 'MEMBER#user-1',
    });
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(ddb.send.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });

  it('writes membership and audit in one transaction', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    await saveMembershipChange(ddb, {
      spaceId: 'space-1',
      actorId: 'user-1',
      targetUserId: 'user-1',
      role: 'admin',
      now: '2026-11-12T12:00:00.000Z',
      changeId: 'change-1',
    });
    const command = ddb.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(3);
    expect(command.input.TransactItems[0].Put.Item.membershipRole).toBe('owner');
    expect(command.input.TransactItems[1].Put.Item.actorId).toBe('user-1');
    expect(command.input.TransactItems[2].Update).toMatchObject({
      Key: { pk: 'SPACE#space-1', sk: 'OWNER_GUARD' },
      UpdateExpression: 'ADD ownerCount :delta',
      ExpressionAttributeValues: { ':delta': 1 },
    });
  });

  it('finds another owner on a later page', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [{ userId: 'target', membershipRole: 'owner' }],
          LastEvaluatedKey: { pk: 'SPACE#space-1', sk: 'MEMBER#target' },
        })
        .mockResolvedValueOnce({
          Items: [{ userId: 'other', membershipRole: 'owner' }],
        }),
    };
    await expect(hasAnotherOwner(ddb, 'space-1', 'target')).resolves.toBe(true);
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it('rejects last-owner removal before writing', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Items: [] }) };
    await expect(
      removeMembership(ddb, {
        spaceId: 'space-1',
        actorId: 'user-1',
        targetUserId: 'user-1',
        before: { membershipRole: 'owner' },
      }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  it('guards owner removal atomically after the paginated pre-check', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [
            { userId: 'target', membershipRole: 'owner' },
            { userId: 'other', membershipRole: 'owner' },
          ],
        })
        .mockResolvedValueOnce({}),
    };

    await removeMembership(ddb, {
      spaceId: 'space-1',
      actorId: 'other',
      targetUserId: 'target',
      before: { membershipRole: 'owner' },
    });

    const transaction = ddb.send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[2].Update).toMatchObject({
      Key: { pk: 'SPACE#space-1', sk: 'OWNER_GUARD' },
      ConditionExpression: 'ownerCount > :minimum',
      ExpressionAttributeValues: { ':delta': -1, ':minimum': 1 },
    });
  });

  it('can preserve the deleting owner until surrounding cleanup succeeds', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Items: [
            {
              pk: 'SPACE#space-1',
              sk: 'MEMBER#owner',
              userId: 'owner',
              membershipRole: 'owner',
            },
            {
              pk: 'SPACE#space-1',
              sk: 'MEMBER#member',
              userId: 'member',
              membershipRole: 'member',
            },
          ],
        })
        .mockResolvedValue({}),
    };

    const preserved = await deleteSpaceMemberships(ddb, 'space-1', {
      preserveUserId: 'owner',
      deletePreserved: false,
    });

    expect(preserved.userId).toBe('owner');
    const deletes = ddb.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key.sk).toBe('MEMBER#member');
  });
});
