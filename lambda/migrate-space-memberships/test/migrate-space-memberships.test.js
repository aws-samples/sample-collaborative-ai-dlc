import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { baselineId, migrateMemberships, migrationItems } from '../index.js';

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
  });

  it('copies and verifies each source membership', async () => {
    const client = {
      send: vi.fn(async (command) => {
        if (command instanceof TransactWriteCommand) return {};
        if (command instanceof GetCommand) return { Item: { membershipRole: 'owner' } };
        throw new Error('unexpected command');
      }),
    };
    await expect(
      migrateMemberships({
        client,
        sources: [{ spaceId: 'space-1', userId: 'user-1', role: 'owner' }],
      }),
    ).resolves.toMatchObject({ copied: 1, sourceCount: 1 });
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
      }),
    ).resolves.toMatchObject({ preserved: 1 });
  });
});
