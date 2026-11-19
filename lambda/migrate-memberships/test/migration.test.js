import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createMembershipStore } from '../../shared/space-membership.js';
import { migrateMemberships, reportMembershipDifferences } from '../migration.js';
import { createTestMembershipStore } from '../../../test/membership-store.js';

let conn;
let g;
let fixture;
beforeAll(async () => {
  fixture = await createTestMembershipStore(createMembershipStore);
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  const partition = randomUUID();
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: partition,
        readPartitions: [partition],
      }),
    );
});
afterAll(async () => {
  await conn.close();
  await fixture.cleanup();
});
afterEach(() => vi.restoreAllMocks());

const edge = async (spaceId, userId, role) => {
  if (!(await g.V().has('Project', 'id', spaceId).hasNext()))
    await g.addV('Project').property('id', spaceId).next();
  await g
    .addV('User')
    .property('id', userId)
    .as('user')
    .V()
    .has('Project', 'id', spaceId)
    .addE('HAS_MEMBER')
    .property('role', role)
    .to('user')
    .next();
};

describe('membership migration', () => {
  it('converts Owners/Admins across spaces, verifies baselines/indexes and survives restart/revocation', async () => {
    await edge('space-a', 'shared-admin', 'admin');
    await edge('space-b', 'shared-admin', 'admin');
    await edge('space-a', 'other-owner', 'owner');
    await edge('space-a', 'reader', 'member');
    let stopped = false;
    const interrupted = {
      ...fixture.store,
      change: async (input) => {
        const result = await fixture.store.change(input);
        if (!stopped) {
          stopped = true;
          throw new Error('Interrupted after commit');
        }
        return result;
      },
    };
    await expect(migrateMemberships(g, interrupted)).rejects.toThrow('Interrupted');
    expect(await migrateMemberships(g, fixture.store)).toMatchObject({ verified: true, spaces: 2 });
    expect((await fixture.store.get('space-a', 'shared-admin')).membershipRole).toBe('owner');
    expect((await fixture.store.get('space-b', 'shared-admin')).membershipRole).toBe('owner');
    expect((await fixture.store.get('space-a', 'reader')).membershipRole).toBe('member');
    expect((await fixture.store.listUserSpaces('shared-admin')).items).toHaveLength(2);
    expect(
      (await fixture.store.listHistory('space-a')).items.find(
        (e) => e.targetUserId === 'shared-admin',
      ),
    ).toMatchObject({ before: { membershipRole: 'admin' }, after: { membershipRole: 'owner' } });
    const before = await fixture.store.get('space-a', 'shared-admin');
    await fixture.store.change({
      spaceId: 'space-a',
      userId: 'shared-admin',
      actorId: 'other-owner',
      before,
      role: null,
      action: 'member-removed',
    });
    expect(await migrateMemberships(g, fixture.store)).toMatchObject({ copied: 0 });
    expect(await fixture.store.get('space-a', 'shared-admin')).toBeNull();
    expect((await fixture.store.listHistory('space-a')).items).toHaveLength(4);
    // Keep the old source available for rollback; retries still cannot restore revoked grants.
    expect(await g.E().hasLabel('HAS_MEMBER').hasNext()).toBe(true);
    expect(await migrateMemberships(g, fixture.store)).toMatchObject({ verified: true, copied: 0 });
  });

  it('does not skip unchanged members when an old-app removal follows the source read', async () => {
    await g.V().drop().next();
    const userIds = ['snapshot-owner', ...Array.from({ length: 51 }, (_, i) => `snapshot-${i}`)];
    for (const userId of userIds)
      await edge('snapshot-space', userId, userId === 'snapshot-owner' ? 'owner' : 'member');
    const submit = conn.submit.bind(conn);
    let sourceReads = 0;
    let removedUser;
    vi.spyOn(conn, 'submit').mockImplementation(async (bytecode) => {
      const result = await submit(bytecode);
      if (
        bytecode.stepInstructions.some(
          ([step, label]) => step === 'outE' && label === 'HAS_MEMBER',
        ) &&
        bytecode.stepInstructions.some(([step]) => step === 'project')
      ) {
        sourceReads++;
        if (sourceReads === 1) {
          removedUser = (
            await g
              .V()
              .has('Project', 'id', 'snapshot-space')
              .out('HAS_MEMBER')
              .limit(1)
              .values('id')
              .next()
          ).value;
          await g
            .V()
            .has('Project', 'id', 'snapshot-space')
            .outE('HAS_MEMBER')
            .limit(1)
            .drop()
            .next();
        }
      }
      return result;
    });
    await expect(migrateMemberships(g, fixture.store)).resolves.toMatchObject({
      verified: true,
      copied: 52,
    });
    for (const userId of userIds.filter((id) => id !== removedUser))
      expect(await fixture.store.get('snapshot-space', userId)).not.toBeNull();
    expect(sourceReads).toBe(1);
  });

  it('skips and logs an empty space without blocking healthy spaces or retries', async () => {
    await g.V().drop().next();
    await g.addV('Project').property('id', 'empty-space').next();
    await edge('healthy-empty-space', 'healthy-empty-owner', 'owner');
    const warn = vi.fn();
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      spaces: 2,
      copied: 1,
      skipped: 1,
      ownerless: 0,
    });
    expect((await fixture.store.listMembers('empty-space')).items).toEqual([]);
    expect((await fixture.store.listHistory('empty-space')).items).toEqual([]);
    expect(await fixture.store.get('healthy-empty-space', 'healthy-empty-owner')).toMatchObject({
      membershipRole: 'owner',
    });
    expect(warn).toHaveBeenCalledWith('Space has no source memberships; skipping copy', {
      spaceId: 'empty-space',
    });
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      copied: 0,
      preserved: 1,
      skipped: 1,
      ownerless: 0,
    });
  });

  it('copies members of a space with no Owner, warns and preserves their access on retry', async () => {
    await g.V().drop().next();
    await edge('unowned', 'unowned-reader', 'member');
    await edge('healthy-space', 'healthy-owner', 'owner');
    const warn = vi.fn();
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      spaces: 2,
      copied: 2,
      skipped: 0,
      ownerless: 1,
    });
    expect(await fixture.store.get('unowned', 'unowned-reader')).toMatchObject({
      membershipRole: 'member',
    });
    expect(await fixture.store.hasOtherOwner('unowned', '')).toBe(false);
    expect(await fixture.store.get('healthy-space', 'healthy-owner')).toMatchObject({
      membershipRole: 'owner',
    });
    expect(warn).toHaveBeenCalledWith('Space has no Owner; preserving existing member access', {
      spaceId: 'unowned',
    });
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      copied: 0,
      preserved: 2,
      skipped: 0,
      ownerless: 1,
    });
    expect((await fixture.store.listHistory('unowned')).items).toEqual([
      expect.objectContaining({
        action: 'membership-migrated',
        targetUserId: 'unowned-reader',
        before: { membershipRole: 'member' },
        after: expect.objectContaining({ membershipRole: 'member' }),
      }),
    ]);
  });

  it('merges conflicting valid edges by strongest grant regardless of order across more than 50 edges', async () => {
    await g.V().drop().next();
    await edge('duplicates-member-first', 'duplicate-admin', 'member');
    for (let i = 0; i < 49; i++)
      await edge('duplicates-member-first', `duplicate-reader-${i}`, 'member');
    await edge('duplicates-member-first', 'duplicate-admin', 'admin');
    await edge('duplicates-owner-first', 'duplicate-owner', 'owner');
    await edge('duplicates-owner-first', 'duplicate-owner', 'member');
    const warn = vi.fn();
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      copied: 51,
      ownerless: 0,
    });
    expect(await fixture.store.get('duplicates-member-first', 'duplicate-admin')).toMatchObject({
      membershipRole: 'owner',
    });
    expect(await fixture.store.get('duplicates-owner-first', 'duplicate-owner')).toMatchObject({
      membershipRole: 'owner',
    });
    expect(
      (await fixture.store.listHistory('duplicates-member-first')).items.find(
        (item) => item.targetUserId === 'duplicate-admin',
      ),
    ).toMatchObject({
      before: { membershipRole: 'admin' },
      after: { membershipRole: 'owner' },
    });
    expect((await fixture.store.listHistory('duplicates-owner-first')).items).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'Duplicate membership roles; preserving the strongest grant',
      { spaceId: 'duplicates-member-first', userId: 'duplicate-admin' },
    );
    await expect(migrateMemberships(g, fixture.store, { warn })).resolves.toMatchObject({
      verified: true,
      copied: 0,
      preserved: 51,
    });
  });

  it('reports missed additions, removals, new spaces and role changes without changing either store', async () => {
    await g.V().drop().next();
    await edge('report-space', 'report-owner', 'owner');
    for (let i = 0; i < 51; i++) await edge('report-space', `report-reader-${i}`, 'member');
    await migrateMemberships(g, fixture.store);
    await g
      .V()
      .has('Project', 'id', 'report-space')
      .outE('HAS_MEMBER')
      .as('edge')
      .inV()
      .has('id', 'report-reader-0')
      .select('edge')
      .drop()
      .next();
    await g
      .V()
      .has('Project', 'id', 'report-space')
      .outE('HAS_MEMBER')
      .has('role', 'owner')
      .property('role', 'member')
      .next();
    await edge('report-space', 'late-member', 'member');
    await edge('new-space', 'new-owner', 'owner');
    const warn = vi.fn();
    const change = vi.spyOn(fixture.store, 'change');
    const edgeCount = (await g.E().hasLabel('HAS_MEMBER').count().next()).value;
    await expect(reportMembershipDifferences(g, fixture.store, { warn })).resolves.toEqual({
      reported: true,
      spaces: 2,
      missingDestination: 2,
      missingSource: 1,
      roleMismatches: 1,
    });
    expect(warn).toHaveBeenCalledWith('Graph membership has no DynamoDB grant', {
      spaceId: 'report-space',
      userId: 'late-member',
      sourceRole: 'member',
    });
    expect(warn).toHaveBeenCalledWith('Graph membership has no DynamoDB grant', {
      spaceId: 'new-space',
      userId: 'new-owner',
      sourceRole: 'owner',
    });
    expect(warn).toHaveBeenCalledWith('DynamoDB membership has no graph grant', {
      spaceId: 'report-space',
      userId: 'report-reader-0',
      destinationRole: 'member',
    });
    expect(warn).toHaveBeenCalledWith('Graph and DynamoDB membership roles differ', {
      spaceId: 'report-space',
      userId: 'report-owner',
      sourceRole: 'member',
      destinationRole: 'owner',
    });
    expect(change).not.toHaveBeenCalled();
    expect((await g.E().hasLabel('HAS_MEMBER').count().next()).value).toBe(edgeCount);
    expect(await fixture.store.get('new-space', 'new-owner')).toBeNull();
    expect(await fixture.store.get('report-space', 'report-reader-0')).not.toBeNull();
  });

  it('still blocks cutover when the index never propagates', async () => {
    await g.V().drop().next();
    await edge('missing-index', 'owner', 'owner');
    await expect(
      migrateMemberships(
        g,
        {
          ...fixture.store,
          listUserSpaces: async () => ({ items: [], nextToken: null }),
        },
        { wait: async () => {} },
      ),
    ).rejects.toThrow('has not propagated');
  });

  it('reports malformed spaces and membership targets before granting them access', async () => {
    await g.V().drop().next();
    await g.addV('Project').next();
    await expect(migrateMemberships(g, fixture.store)).rejects.toThrow(
      'Invalid or duplicate space ID',
    );
    await g.V().drop().next();
    await g
      .addV('Project')
      .property('id', 'invalid-target')
      .as('space')
      .addV('Intent')
      .property('id', 'not-a-user')
      .addE('HAS_MEMBER')
      .from_('space')
      .property('role', 'owner')
      .next();
    await expect(migrateMemberships(g, fixture.store)).rejects.toThrow('Invalid membership');
    expect(await fixture.store.get('invalid-target', 'not-a-user')).toBeNull();
    await g.V().drop().next();
    await edge('invalid-role', 'invalid-role-user', 'owner');
    await edge('invalid-role', 'invalid-role-user', 'viewer');
    await expect(migrateMemberships(g, fixture.store)).rejects.toThrow('Invalid membership');
    expect(await fixture.store.get('invalid-role', 'invalid-role-user')).toBeNull();
  });
});
