import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  decodeToken,
  getMembershipRole,
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

  it('writes membership, audit, and owner guard in one transaction', async () => {
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
    expect(command.input.TransactItems[2].Update.UpdateExpression).toContain('ownerCount');
  });

  it('guards owner removal with the same atomic transaction', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    await removeMembership(ddb, {
      spaceId: 'space-1',
      actorId: 'user-2',
      targetUserId: 'user-1',
      before: { membershipRole: 'owner' },
      now: '2026-11-12T12:00:00.000Z',
      changeId: 'change-2',
    });
    const command = ddb.send.mock.calls[0][0];
    expect(command.input.TransactItems[2].Update.ConditionExpression).toBe('ownerCount > :minimum');
  });
});
