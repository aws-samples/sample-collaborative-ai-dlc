import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { membershipStore } from '../../shared/space-membership.js';
import { seedMembership } from '../../../test/seed-membership.js';

const { single } = gremlin.process.cardinality;
const setDiscoverable = (value) =>
  g.V().has('Project', 'id', projectId).property(single, 'discoverable', value).next();

const events = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../../shared/notification-events.js', () => ({
  publishNotificationEvent: events.publish,
}));
vi.mock('../../shared/tracker-binding-delegation.js', () => ({
  invalidateTrackerBindingsByDelegator: vi.fn(),
}));
vi.mock('../../shared/source-control-bindings.js', () => ({
  invalidateProjectBindingsByDelegator: vi.fn(),
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
  await g.addV('User').property('id', 'owner').property('email', 'owner@example.com').next();
});
afterAll(async () => {
  await conn.close();
  vi.unstubAllEnvs();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  projectId = randomUUID();
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', 'Payments')
    .property('discoverable', 'true')
    .next();
  await seedMembership(projectId, 'owner');
  events.publish.mockReset().mockResolvedValue(true);
});

const request = (method, { actor = 'asker', userId, data } = {}) =>
  handler({
    httpMethod: method,
    resource: userId
      ? '/projects/{projectId}/access-requests/{userId}'
      : '/projects/{projectId}/access-requests',
    pathParameters: { projectId, userId },
    requestContext: { authorizer: { claims: { sub: actor, email: `${actor}@example.com` } } },
    body: data ? JSON.stringify(data) : undefined,
  });
const body = (res) => JSON.parse(res.body);

describe('space access requests', () => {
  it('lets a non-member ask once, and tells the Owners', async () => {
    const res = await request('POST', { data: { message: ' I build the card API ' } });
    expect(res.statusCode).toBe(201);
    expect(body(res)).toMatchObject({
      projectId,
      userId: 'asker',
      email: 'asker@example.com',
      message: 'I build the card API',
      status: 'pending',
    });
    expect(events.publish).toHaveBeenCalledWith(
      'space.access.requested',
      expect.objectContaining({
        projectId,
        name: 'Payments',
        requesterId: 'asker',
        requesterEmail: 'asker@example.com',
        message: 'I build the card API',
        owners: [{ userId: 'owner', email: 'owner@example.com' }],
      }),
    );
    expect((await request('POST')).statusCode).toBe(409);
    // A request is not membership.
    expect(await membershipStore.get(projectId, 'asker')).toBeNull();
    const spaces = await membershipStore.listUserSpaces('asker');
    expect(spaces.items).toEqual([]);
  });

  it('hides private and missing spaces, and refuses members and bad messages', async () => {
    await setDiscoverable('false');
    expect((await request('POST')).statusCode).toBe(404);
    await setDiscoverable('true');
    expect((await request('POST', { actor: 'owner' })).statusCode).toBe(409);
    expect((await request('POST', { data: { message: 5 } })).statusCode).toBe(400);
    expect((await request('POST', { data: { message: 'x'.repeat(501) } })).statusCode).toBe(400);
    projectId = randomUUID();
    expect((await request('POST')).statusCode).toBe(404);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('lets the requester withdraw only their own request', async () => {
    await request('POST');
    expect((await request('DELETE', { actor: 'someone', userId: 'asker' })).statusCode).toBe(403);
    expect((await request('DELETE', { userId: 'asker' })).statusCode).toBe(204);
    expect((await request('DELETE', { userId: 'asker' })).statusCode).toBe(404);
    expect((await request('POST')).statusCode).toBe(201);
  });

  it('shows pending requests to Owners only', async () => {
    await request('POST', { data: { message: 'hello' } });
    await seedMembership(projectId, 'member', 'member');
    for (const actor of ['member', 'asker', 'stranger']) {
      expect((await request('GET', { actor })).statusCode).toBe(403);
      expect(
        (await request('PUT', { actor, userId: 'asker', data: { decision: 'approve' } }))
          .statusCode,
      ).toBe(403);
    }
    const res = await request('GET', { actor: 'owner' });
    expect(res.statusCode).toBe(200);
    expect(body(res).items).toEqual([
      {
        userId: 'asker',
        email: 'asker@example.com',
        message: 'hello',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('approves with the chosen role, records it, and clears the request', async () => {
    await request('POST');
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'approve', role: 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ projectId, userId: 'asker', decision: 'approved', role: 'owner' });
    expect((await membershipStore.get(projectId, 'asker')).membershipRole).toBe('owner');
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
    expect(await g.V().has('User', 'id', 'asker').values('email').next()).toMatchObject({
      value: 'asker@example.com',
    });
    const history = await membershipStore.listHistory(projectId);
    expect(history.items[0]).toMatchObject({
      action: 'access-request-approved',
      actorId: 'owner',
      targetUserId: 'asker',
    });
    expect(events.publish).toHaveBeenLastCalledWith(
      'space.access.decided',
      expect.objectContaining({
        projectId,
        requesterId: 'asker',
        decision: 'approved',
        role: 'owner',
        decidedById: 'owner',
      }),
    );
  });

  it('defaults an approval to Member and validates the decision', async () => {
    await request('POST');
    for (const data of [{}, { decision: 'maybe' }, { decision: 'approve', role: 'guest' }]) {
      expect((await request('PUT', { actor: 'owner', userId: 'asker', data })).statusCode).toBe(
        400,
      );
    }
    expect(
      (await request('PUT', { actor: 'owner', userId: 'nobody', data: { decision: 'approve' } }))
        .statusCode,
    ).toBe(404);
    await request('PUT', { actor: 'owner', userId: 'asker', data: { decision: 'approve' } });
    expect((await membershipStore.get(projectId, 'asker')).membershipRole).toBe('member');
  });

  it('declines without granting access, and the person can ask again', async () => {
    await request('POST');
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'decline' },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ projectId, userId: 'asker', decision: 'declined' });
    expect(await membershipStore.get(projectId, 'asker')).toBeNull();
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
    expect((await membershipStore.listHistory(projectId)).items[0]).toMatchObject({
      action: 'access-request-declined',
      targetUserId: 'asker',
    });
    expect(events.publish).toHaveBeenLastCalledWith(
      'space.access.decided',
      expect.objectContaining({ decision: 'declined', role: null }),
    );
    expect((await request('POST')).statusCode).toBe(201);
  });

  it('settles the request when an Owner adds the person directly', async () => {
    await request('POST');
    const added = await handler({
      httpMethod: 'POST',
      resource: '/projects/{projectId}/members',
      pathParameters: { projectId },
      requestContext: { authorizer: { claims: { sub: 'owner' } } },
      body: JSON.stringify({ userId: 'asker', email: 'asker@example.com' }),
    });
    expect(added.statusCode).toBe(201);
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
  });

  it('conflicts when the request is withdrawn before it is approved', async () => {
    await request('POST');
    const pending = await membershipStore.getRequest(projectId, 'asker');
    vi.spyOn(membershipStore, 'getRequest').mockResolvedValueOnce(pending);
    await membershipStore.withdrawRequest(projectId, 'asker');
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(await membershipStore.get(projectId, 'asker')).toBeNull();
  });

  it('keeps requests out of the member list and private details out of history', async () => {
    await request('POST', { data: { message: 'private note' } });
    await seedMembership(projectId, 'member', 'member');
    const members = await handler({
      httpMethod: 'GET',
      resource: '/projects/{projectId}/members',
      pathParameters: { projectId },
      requestContext: { authorizer: { claims: { sub: 'member' } } },
    });
    expect(
      body(members)
        .map((m) => m.userId)
        .toSorted(),
    ).toEqual(['member', 'owner']);
    await request('PUT', { actor: 'owner', userId: 'asker', data: { decision: 'decline' } });
    const history = JSON.stringify((await membershipStore.listHistory(projectId)).items);
    expect(history).not.toContain('private note');
    expect(history).not.toContain('asker@example.com');
  });

  it('settles a request from someone who became a member another way', async () => {
    await request('POST');
    await seedMembership(projectId, 'asker', 'member');
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'approve', role: 'owner' },
    });
    expect(res.statusCode).toBe(409);
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
    expect((await membershipStore.get(projectId, 'asker')).membershipRole).toBe('member');
  });

  it('drops a request that lands after the space was hidden', async () => {
    const create = membershipStore.createRequest;
    vi.spyOn(membershipStore, 'createRequest').mockImplementationOnce(async (input) => {
      const created = await create(input);
      await setDiscoverable('false');
      return created;
    });
    expect((await request('POST')).statusCode).toBe(404);
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('still answers a stored request when the Owner lookup fails', async () => {
    vi.spyOn(membershipStore, 'listOwners').mockRejectedValueOnce(new Error('throttled'));
    expect((await request('POST')).statusCode).toBe(201);
    expect(events.publish).toHaveBeenCalledWith(
      'space.access.requested',
      expect.objectContaining({ owners: null }),
    );
  });

  it('gives a decision its own event id', async () => {
    await request('POST');
    await request('PUT', { actor: 'owner', userId: 'asker', data: { decision: 'decline' } });
    const [requested, decided] = events.publish.mock.calls.map(([, detail]) => detail.eventId);
    expect(decided).toBe(`decision:${requested}`);
  });

  it('tells a non-member nothing when withdrawing from a private space', async () => {
    await setDiscoverable('false');
    expect((await request('DELETE', { userId: 'asker' })).statusCode).toBe(404);
  });

  it('treats a Viewer as a member who cannot decide, and can approve someone as a Viewer', async () => {
    await seedMembership(projectId, 'reader', 'viewer');
    expect((await request('POST', { actor: 'reader' })).statusCode).toBe(409);
    await request('POST');
    expect((await request('GET', { actor: 'reader' })).statusCode).toBe(403);
    expect(
      (await request('PUT', { actor: 'reader', userId: 'asker', data: { decision: 'decline' } }))
        .statusCode,
    ).toBe(403);
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'approve', role: 'viewer' },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ decision: 'approved', role: 'viewer' });
    expect((await membershipStore.get(projectId, 'asker')).membershipRole).toBe('viewer');
  });

  it('refuses a decision from an Owner demoted after the request was read', async () => {
    await seedMembership(projectId, 'owner2', 'owner');
    await request('POST');
    const read = membershipStore.getRequest;
    vi.spyOn(membershipStore, 'getRequest').mockImplementationOnce(async (...args) => {
      const pending = await read(...args);
      const before = await membershipStore.get(projectId, 'owner2');
      await membershipStore.change({
        spaceId: projectId,
        userId: 'owner2',
        actorId: 'owner',
        role: 'member',
        before,
        action: 'role-changed',
      });
      return pending;
    });
    const res = await request('PUT', {
      actor: 'owner2',
      userId: 'asker',
      data: { decision: 'decline' },
    });
    expect(res.statusCode).toBe(409);
    expect(await membershipStore.getRequest(projectId, 'asker')).not.toBeNull();
  });

  it('conflicts when the request is withdrawn before it is declined', async () => {
    await request('POST');
    const pending = await membershipStore.getRequest(projectId, 'asker');
    vi.spyOn(membershipStore, 'getRequest').mockResolvedValueOnce(pending);
    await membershipStore.withdrawRequest(projectId, 'asker');
    const res = await request('PUT', {
      actor: 'owner',
      userId: 'asker',
      data: { decision: 'decline' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('drops a request that lands while the space is being deleted', async () => {
    const create = membershipStore.createRequest;
    vi.spyOn(membershipStore, 'createRequest').mockImplementationOnce(async (input) => {
      const created = await create(input);
      await g.V().has('Project', 'id', projectId).drop().next();
      return created;
    });
    expect((await request('POST')).statusCode).toBe(404);
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
  });

  it('drops a request from someone added directly while it was written', async () => {
    const create = membershipStore.createRequest;
    vi.spyOn(membershipStore, 'createRequest').mockImplementationOnce(async (input) => {
      const created = await create(input);
      await seedMembership(projectId, 'asker', 'member');
      return created;
    });
    expect((await request('POST')).statusCode).toBe(409);
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
  });

  it('withdraws and reports an error when the space cannot be checked again', async () => {
    const create = membershipStore.createRequest;
    let stored;
    vi.spyOn(membershipStore, 'createRequest').mockImplementationOnce(async (input) => {
      const created = await create(input);
      stored = await membershipStore.getRequest(projectId, 'asker');
      vi.spyOn(membershipStore, 'get').mockRejectedValueOnce(new Error('throttled'));
      return created;
    });
    const res = await request('POST');
    expect(res.statusCode).toBe(500);
    expect(body(res).error).toBe('Internal server error');
    expect(stored).toMatchObject({ requesterId: 'asker' });
    expect(await membershipStore.getRequest(projectId, 'asker')).toBeNull();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('pages the pending requests', async () => {
    for (let i = 0; i < 51; i += 1) {
      await membershipStore.createRequest({ spaceId: projectId, requesterId: `asker-${i}` });
    }
    const first = await request('GET', { actor: 'owner' });
    expect(body(first).items).toHaveLength(50);
    expect(body(first).nextToken).toEqual(expect.any(String));
    const second = await handler({
      httpMethod: 'GET',
      resource: '/projects/{projectId}/access-requests',
      pathParameters: { projectId },
      queryStringParameters: { nextToken: body(first).nextToken },
      requestContext: { authorizer: { claims: { sub: 'owner' } } },
    });
    expect(body(second).items).toHaveLength(1);
    expect(body(second).nextToken).toBeNull();
  });
});
