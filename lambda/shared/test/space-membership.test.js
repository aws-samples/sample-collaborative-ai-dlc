import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMembershipStore, fetchMembershipRole } from '../space-membership.js';
import { createTestMembershipStore } from '../../../test/membership-store.js';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

let fixture;
beforeAll(async () => {
  fixture = await createTestMembershipStore(createMembershipStore);
});
afterAll(async () => {
  await fixture.cleanup();
});

const add = (spaceId, userId, role = 'owner') =>
  fixture.store.change({
    spaceId,
    userId,
    role,
    actorId: userId,
    action: 'space-created',
  });

describe('authoritative membership and history', () => {
  it('stores one membership, projects every attribute, and pages user-space lists', async () => {
    for (let i = 0; i < 53; i++)
      await add(`many-${String(i).padStart(2, '0')}`, 'multi-user', i % 2 ? 'member' : 'owner');
    const first = await fixture.store.listUserSpaces('multi-user');
    expect(first.items).toHaveLength(50);
    expect(first.nextToken).toBeTruthy();
    const second = await fixture.store.listUserSpaces('multi-user', first.nextToken);
    expect(second.items).toHaveLength(3);
    expect(second.nextToken).toBeNull();
    for (const member of [...first.items, ...second.items]) {
      expect(member).toEqual(await fixture.store.get(member.pk.slice(6), 'multi-user'));
    }
  });

  it('finds another owner on a later member page and rejects missing coverage', async () => {
    for (let i = 0; i < 52; i++)
      await add('owner-pages', `a-${String(i).padStart(2, '0')}`, 'member');
    await add('owner-pages', 'target');
    expect(await fixture.store.hasOtherOwner('owner-pages', 'target')).toBe(false);
    await add('owner-pages', 'z-other');
    expect(await fixture.store.hasOtherOwner('owner-pages', 'target')).toBe(true);
    const first = await fixture.store.listMembers('owner-pages');
    expect(first.items).toHaveLength(50);
    expect((await fixture.store.listMembers('owner-pages', first.nextToken)).items).toHaveLength(4);
  });

  it('atomically records before/after values and leaves history unchanged on a failed write', async () => {
    const before = await add('atomic', 'owner');
    const after = await fixture.store.change({
      spaceId: 'atomic',
      userId: 'owner',
      actorId: 'owner',
      role: 'member',
      before,
      action: 'role-changed',
    });
    let history = await fixture.store.listHistory('atomic');
    expect(history.items).toHaveLength(2);
    expect(history.items.find((e) => e.action === 'role-changed')).toMatchObject({
      actorId: 'owner',
      targetUserId: 'owner',
      spaceId: 'atomic',
      before,
      after,
    });
    await expect(
      fixture.store.change({
        spaceId: 'atomic',
        userId: 'owner',
        actorId: 'owner',
        role: 'owner',
        before,
        action: 'role-changed',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await fixture.store.get('atomic', 'owner')).toEqual(after);
    expect((await fixture.store.listHistory('atomic')).items).toHaveLength(2);
    history = await fixture.store.listHistory('atomic', {
      from: history.items[0].timestamp,
      to: history.items[0].timestamp,
    });
    expect(history.items.length).toBeGreaterThan(0);
  });

  it('denies a mutation by a revoked actor in the same transaction', async () => {
    await add('fenced', 'actor');
    const before = await add('fenced', 'member', 'member');
    const actor = await fixture.store.get('fenced', 'actor');
    await fixture.store.change({
      spaceId: 'fenced',
      userId: 'actor',
      actorId: 'actor',
      role: null,
      before: actor,
      action: 'member-removed',
    });
    await expect(
      fixture.store.change({
        spaceId: 'fenced',
        userId: 'member',
        actorId: 'actor',
        role: 'owner',
        before,
        action: 'role-changed',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await fixture.store.get('fenced', 'member')).toEqual(before);
    expect((await fixture.store.listHistory('fenced')).items).toHaveLength(3);
  });

  it('denies self-promotion if the actor was demoted before the target read', async () => {
    await add('self-fenced', 'actor', 'member');
    const before = await fixture.store.get('self-fenced', 'actor');
    await expect(
      fixture.store.change({
        spaceId: 'self-fenced',
        userId: 'actor',
        actorId: 'actor',
        role: 'owner',
        before,
        action: 'role-changed',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await fixture.store.get('self-fenced', 'actor')).toEqual(before);
  });

  it('rolls back the access mutation if the history write fails', async () => {
    const store = createMembershipStore({
      ddb: fixture.ddb,
      accessTable: fixture.accessTable,
      auditTable: fixture.auditTable,
      now: () => '2026-11-12T12:00:00.000Z',
    });
    await store.change({
      spaceId: 'audit-failure',
      userId: 'owner',
      actorId: 'owner',
      role: 'owner',
      action: 'space-created',
      changeId: 'duplicate',
    });
    await expect(
      store.change({
        spaceId: 'audit-failure',
        userId: 'member',
        actorId: 'owner',
        role: 'member',
        action: 'member-added',
        changeId: 'duplicate',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await store.get('audit-failure', 'member')).toBeNull();
    expect((await store.listHistory('audit-failure')).items).toHaveLength(1);
  });

  it('drains multiple member pages during deletion and retains paginated history', async () => {
    await add('delete-pages', 'owner');
    for (let i = 0; i < 52; i++) await add('delete-pages', `member-${i}`, 'member');
    await fixture.store.deleteSpaceMembers('delete-pages', 'owner', { keepActor: true });
    expect((await fixture.store.listMembers('delete-pages')).items.map((m) => m.userId)).toEqual([
      'owner',
    ]);
    await fixture.store.deleteSpaceMembers('delete-pages', 'owner');
    expect((await fixture.store.listMembers('delete-pages')).items).toEqual([]);
    let token;
    const history = [];
    do {
      const page = await fixture.store.listHistory('delete-pages', { token });
      history.push(...page.items);
      token = page.nextToken;
    } while (token);
    expect(history).toHaveLength(106);
    expect(
      (await fixture.store.listUserSpaces('owner')).items.some(
        (m) => m.pk === 'SPACE#delete-pages',
      ),
    ).toBe(false);
  });

  it('fails closed on missing records and read/query failures with no graph edge lookup', async () => {
    const ddb = { send: vi.fn() };
    const store = createMembershipStore({ ddb, accessTable: 'access', auditTable: 'audit' });
    const g = { V: () => ({ has: () => ({ hasNext: async () => true }) }) };
    ddb.send.mockResolvedValue({});
    expect(await fetchMembershipRole(g, 'space', 'removed', store)).toBeNull();
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(ddb.send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    ddb.send.mockRejectedValue(new Error('Unavailable'));
    await expect(fetchMembershipRole(g, 'space', 'removed', store)).rejects.toThrow('Unavailable');
    await expect(store.hasOtherOwner('space', 'owner')).rejects.toThrow('Unavailable');
    expect(ddb.send.mock.lastCall[0]).toBeInstanceOf(QueryCommand);
    expect(ddb.send.mock.calls.some(([cmd]) => cmd instanceof TransactWriteCommand)).toBe(false);
  });

  it('does not grant access to a deleted space with a remaining access record', async () => {
    const store = { get: vi.fn().mockResolvedValue({ membershipRole: 'owner' }) };
    const g = { V: () => ({ has: () => ({ hasNext: async () => false }) }) };
    expect(await fetchMembershipRole(g, 'gone', 'owner', store)).toBeNull();
    expect(store.get).not.toHaveBeenCalled();
  });
});
