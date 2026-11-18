import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { membershipStore } from '../../shared/space-membership.js';
import { seedMembership } from '../../../test/seed-membership.js';

const cleanup = vi.hoisted(() => ({ trackers: vi.fn(), sourceControl: vi.fn() }));
vi.mock('../../shared/tracker-binding-delegation.js', () => ({
  invalidateTrackerBindingsByDelegator: cleanup.trackers,
}));
vi.mock('../../shared/source-control-bindings.js', () => ({
  invalidateProjectBindingsByDelegator: cleanup.sourceControl,
}));

let conn;
let g;
let handler;
let projectId;
beforeAll(async () => {
  const partition = randomUUID();
  vi.stubEnv('GREMLIN_PARTITION', partition);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler } = await import('../index.js'));
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
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
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  projectId = randomUUID();
  await g.addV('Project').property('id', projectId).next();
  await g.addV('User').property('id', 'owner').property('email', 'owner@example.com').next();
  await seedMembership(projectId, 'owner');
  cleanup.trackers.mockReset().mockResolvedValue(undefined);
  cleanup.sourceControl.mockReset().mockResolvedValue(undefined);
});
const request = (method, { actor = 'owner', userId, data, query, route = 'members' } = {}) =>
  handler({
    httpMethod: method,
    path: `/projects/${projectId}/${route}`,
    pathParameters: { projectId, userId },
    queryStringParameters: query,
    requestContext: { authorizer: { claims: { sub: actor } } },
    body: data ? JSON.stringify(data) : undefined,
  });

describe('space member API', () => {
  it('lists the shared catalog and assignments for Members but only allows Owners to change them', async () => {
    await seedMembership(projectId, 'member', 'member');
    const route = 'members/member/business-roles';
    const catalog = JSON.parse(
      (await request('GET', { actor: 'member', route: 'business-roles' })).body,
    );
    expect(catalog).toHaveLength(9);
    expect(catalog.find((role) => role.id === 'product-owner').name).toBe(
      'Product Owner / Product Manager',
    );
    expect(
      (
        await request('PUT', {
          route,
          userId: 'member',
          data: { localRoles: ['developer', 'product-owner'] },
        })
      ).statusCode,
    ).toBe(200);
    const page = JSON.parse(
      (await request('GET', { actor: 'member', query: { paged: '1' } })).body,
    );
    expect(page.items.find((member) => member.userId === 'member')).toMatchObject({
      role: 'member',
      localRoles: ['developer', 'product-owner'],
    });
    for (const actor of ['member', 'outsider']) {
      expect(
        (await request('PUT', { actor, route, userId: 'member', data: { localRoles: [] } }))
          .statusCode,
      ).toBe(403);
      expect((await request('POST', { actor, data: { userId: 'new' } })).statusCode).toBe(403);
    }
    expect((await request('GET', { actor: 'outsider', route: 'business-roles' })).statusCode).toBe(
      403,
    );
    expect(
      (await request('PUT', { route, userId: 'member', data: { localRoles: [] } })).statusCode,
    ).toBe(200);
    expect((await membershipStore.get(projectId, 'member')).localRoles).toEqual([]);
    for (const localRoles of [['made-up'], null, 'developer']) {
      expect(
        (await request('PUT', { route, userId: 'member', data: { localRoles } })).statusCode,
      ).toBe(400);
    }
    expect(
      (await request('PUT', { route, userId: 'missing', data: { localRoles: ['developer'] } }))
        .statusCode,
    ).toBe(404);
  });

  it('does not restore local assignments after removing and re-adding membership', async () => {
    await seedMembership(projectId, 'returning', 'member');
    await request('PUT', {
      route: 'members/returning/business-roles',
      userId: 'returning',
      data: { localRoles: ['architect'] },
    });
    expect((await request('DELETE', { userId: 'returning' })).statusCode).toBe(204);
    expect(
      (await request('POST', { data: { userId: 'returning', role: 'member' } })).statusCode,
    ).toBe(201);
    const member = JSON.parse((await request('GET')).body).find((m) => m.userId === 'returning');
    expect(member.localRoles).toEqual([]);
  });

  it('authorizes history reads and bounds timestamp-range results to 50 entries', async () => {
    await seedMembership(projectId, 'member', 'member');
    for (let i = 0; i < 51; i++)
      await membershipStore.changeLocalRoles({
        spaceId: projectId,
        userId: 'member',
        actorId: 'owner',
        localRoles: i % 2 ? [] : ['architect'],
      });
    const route = 'membership-history';
    const first = JSON.parse((await request('GET', { actor: 'member', route })).body);
    expect(first.items).toHaveLength(50);
    const second = JSON.parse(
      (await request('GET', { route, query: { nextToken: first.nextToken } })).body,
    );
    expect(second.items).toHaveLength(3);
    const timestamp = first.items[0].timestamp;
    const ranged = JSON.parse(
      (await request('GET', { route, query: { from: timestamp, to: timestamp } })).body,
    );
    expect(ranged.items.length).toBeGreaterThan(0);
    expect(ranged.items.every((entry) => entry.timestamp === timestamp)).toBe(true);
    expect((await request('GET', { route, query: { from: 'invalid' } })).statusCode).toBe(400);
    expect((await request('GET', { actor: 'outsider', route })).statusCode).toBe(403);
  });

  it('accepts legacy admin input as Owner and lets the resulting Owner manage other Owners', async () => {
    expect(
      (
        await request('POST', {
          data: { userId: 'former-admin', role: 'admin', email: 'admin@example.com' },
        })
      ).statusCode,
    ).toBe(201);
    expect((await membershipStore.get(projectId, 'former-admin')).membershipRole).toBe('owner');
    expect(
      (await request('PUT', { actor: 'former-admin', userId: 'owner', data: { role: 'member' } }))
        .statusCode,
    ).toBe(200);
    const history = await membershipStore.listHistory(projectId);
    expect(history.items.find((entry) => entry.action === 'role-changed')).toMatchObject({
      actorId: 'former-admin',
      targetUserId: 'owner',
      before: { membershipRole: 'owner' },
      after: { membershipRole: 'member' },
    });
  });

  it('rejects last-owner demotion/removal and an unavailable owner query', async () => {
    expect((await request('DELETE', { userId: 'owner' })).statusCode).toBe(400);
    expect((await request('PUT', { userId: 'owner', data: { role: 'member' } })).statusCode).toBe(
      400,
    );
    vi.spyOn(membershipStore, 'listMembers').mockRejectedValue(new Error('Unavailable'));
    // hasOtherOwner closes over the store query; spy on the public guard for the
    // handler failure, with the actual query failure covered in shared tests.
    vi.spyOn(membershipStore, 'hasOtherOwner').mockRejectedValue(new Error('Unavailable'));
    expect((await request('DELETE', { userId: 'owner' })).statusCode).toBe(500);
    expect((await membershipStore.get(projectId, 'owner')).membershipRole).toBe('owner');
  });

  it('cleans delegated access before revocation and never restores it on re-add', async () => {
    await seedMembership(projectId, 'removed', 'member');
    expect((await request('DELETE', { userId: 'removed' })).statusCode).toBe(204);
    expect(cleanup.trackers).toHaveBeenCalledWith(
      expect.anything(),
      'removed',
      'delegator_removed',
      projectId,
    );
    expect(cleanup.sourceControl).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      'removed',
      'delegator_removed',
      { actor: 'owner' },
    );
    expect(await membershipStore.get(projectId, 'removed')).toBeNull();
    expect((await request('GET', { actor: 'removed' })).statusCode).toBe(403);
    expect(
      (await request('POST', { data: { userId: 'removed', role: 'member' } })).statusCode,
    ).toBe(201);
    expect(cleanup.sourceControl).toHaveBeenCalledTimes(1);
    expect(
      (await membershipStore.listHistory(projectId)).items.filter(
        (e) => e.targetUserId === 'removed',
      ),
    ).toHaveLength(3);
  });

  it('retains membership if delegated-access cleanup fails', async () => {
    await seedMembership(projectId, 'member', 'member');
    cleanup.sourceControl.mockRejectedValue(new Error('Unavailable'));
    expect((await request('DELETE', { userId: 'member' })).statusCode).toBe(500);
    expect((await membershipStore.get(projectId, 'member')).membershipRole).toBe('member');
  });

  it('denies membership administration to Members and to a nonmember platform admin', async () => {
    await seedMembership(projectId, 'member', 'member');
    expect((await request('POST', { actor: 'member', data: { userId: 'new' } })).statusCode).toBe(
      403,
    );
    expect((await request('GET', { actor: 'nonmember' })).statusCode).toBe(403);
  });

  it('ignores old graph edges and fails closed when the access read fails', async () => {
    await g
      .addV('User')
      .property('id', 'stale')
      .as('user')
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_MEMBER')
      .property('role', 'owner')
      .to('user')
      .next();
    expect((await request('GET', { actor: 'stale' })).statusCode).toBe(403);
    vi.spyOn(membershipStore, 'get').mockRejectedValue(new Error('Unavailable'));
    expect((await request('GET')).statusCode).toBe(500);
  });

  it('returns bounded member pages and rejects a token from another space', async () => {
    for (let i = 0; i < 51; i++) await seedMembership(projectId, `paged-${i}`, 'member');
    const first = JSON.parse((await request('GET', { query: { paged: '1' } })).body);
    expect(first.items).toHaveLength(50);
    const second = JSON.parse(
      (await request('GET', { query: { paged: '1', nextToken: first.nextToken } })).body,
    );
    expect(second.items).toHaveLength(2);
    const legacy = JSON.parse((await request('GET')).body);
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy).toHaveLength(52);
    expect(legacy.find((member) => member.userId === 'owner')).toMatchObject({
      email: 'owner@example.com',
      role: 'owner',
    });
    projectId = randomUUID();
    await g.addV('Project').property('id', projectId).next();
    await seedMembership(projectId, 'owner');
    expect(
      (await request('GET', { query: { paged: '1', nextToken: first.nextToken } })).statusCode,
    ).toBe(400);
  });
});
