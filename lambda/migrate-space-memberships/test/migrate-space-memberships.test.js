import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { baselineId, migrateMemberships, migrationItems, removeMembershipEdges } from '../index.js';

beforeEach(() => {
  process.env.ACCESS_TABLE = 'access';
  process.env.AUDIT_TABLE = 'audit';
});

describe('membership migration', () => {
  it('converts admin to owner with a deterministic baseline', () => {
    const first = migrationItems({
      spaceId: 'space-1',
      userId: 'user-1',
      role: 'admin',
      now: '2026-11-12T00:00:00.000Z',
    });
    expect(first.membership.membershipRole).toBe('owner');
    expect(first.audit.changeId).toBe(baselineId('space-1', 'user-1'));
    expect(first.audit.sk).toBe(
      `AUDIT#2026-11-12T00:00:00.000Z#${baselineId('space-1', 'user-1')}`,
    );
  });

  it('copies each source membership once', async () => {
    const client = {
      send: vi.fn(async (command) => {
        if (command instanceof TransactWriteCommand) return {};
        if (command instanceof GetCommand) {
          return { Item: { membershipRole: 'owner' } };
        }
        throw new Error('unexpected command');
      }),
    };
    await expect(
      migrateMemberships({
        client,
        sources: [{ spaceId: 'space-1', userId: 'user-1', role: 'owner' }],
        now: '2026-11-12T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ copied: 1, sourceCount: 1 });
    const transaction = client.send.mock.calls[0][0];
    expect(transaction.input.TransactItems[2].Update).toMatchObject({
      Key: { pk: 'SPACE#space-1', sk: 'OWNER_GUARD' },
      UpdateExpression: 'ADD ownerCount :one',
    });
  });

  it('preserves an existing destination membership on retry', async () => {
    const canceled = Object.assign(new Error('exists'), {
      name: 'TransactionCanceledException',
    });
    const client = {
      send: vi
        .fn()
        .mockRejectedValueOnce(canceled)
        .mockResolvedValueOnce({ Item: { membershipRole: 'member' } })
        .mockResolvedValueOnce({ Item: { membershipRole: 'member' } }),
    };
    await expect(
      migrateMemberships({
        client,
        sources: [{ spaceId: 'space-1', userId: 'user-1', role: 'owner' }],
        now: '2026-11-12T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ preserved: 1 });
  });

  it('fails deployment verification when a source membership is missing', async () => {
    const client = {
      send: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({}),
    };
    await expect(
      migrateMemberships({
        client,
        sources: [{ spaceId: 'space-1', userId: 'user-1', role: 'member' }],
        now: '2026-11-12T00:00:00.000Z',
      }),
    ).rejects.toThrow('Membership migration verification failed for space space-1');
  });

  it('removes only project membership edges during cleanup', async () => {
    const iterate = vi.fn().mockResolvedValue(undefined);
    const drop = vi.fn(() => ({ iterate }));
    const outE = vi.fn(() => ({ drop }));
    const hasLabel = vi.fn(() => ({ outE }));
    const g = { V: vi.fn(() => ({ hasLabel })) };

    await expect(removeMembershipEdges(g)).resolves.toEqual({ cleaned: true });
    expect(hasLabel).toHaveBeenCalledWith('Project');
    expect(outE).toHaveBeenCalledWith('HAS_MEMBER');
    expect(drop).toHaveBeenCalledOnce();
    expect(iterate).toHaveBeenCalledOnce();
  });
});
