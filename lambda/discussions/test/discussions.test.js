import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import shared from '../../shared/realtime-token.js';

const { verifyRealtimeToken } = shared;

const NOW = new Date('2026-01-01T00:00:00.000Z');
const SECRET = 'test-doc-secret';

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

let handler;
let close;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler, close } = await import('../index.js'));

  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close?.();
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
  vi.stubEnv('REALTIME_DOC_SECRET', SECRET);
  // Pin Date so token iat/exp are assertable. Don't fake setTimeout/etc —
  // gremlin's WebSocket driver uses real timers internally.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const MEMBER_SUB = 'member-user';
const OUTSIDER_SUB = 'outsider-user';

const seedProject = async ({ projectId, sprintId, members = [] }) => {
  await g.addV('Project').property('id', projectId).next();
  if (sprintId) {
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .addV('Sprint')
      .property('id', sprintId)
      .as('s')
      .addE('HAS_SPRINT')
      .from_('p')
      .to('s')
      .next();
  }
  for (const { sub, role } of members) {
    await g.addV('User').property('id', sub).property('email', `${sub}@example.com`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .V()
      .has('User', 'id', sub)
      .as('u')
      .addE('HAS_MEMBER')
      .property('role', role)
      .from_('p')
      .to('u')
      .next();
  }
};

const postToken = ({ sprintId, projectId, sub = MEMBER_SUB }) =>
  handler({
    httpMethod: 'POST',
    resource: sprintId
      ? '/api/sprints/{sprintId}/realtime-token'
      : '/api/projects/{projectId}/realtime-token',
    pathParameters: sprintId ? { sprintId } : { projectId },
    ...(sub
      ? { requestContext: { authorizer: { claims: { sub, email: `${sub}@example.com` } } } }
      : {}),
  });

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /sprints/{sprintId}/realtime-token', () => {
  it('issues a sprint+project scoped token for a project member', async () => {
    const projectId = randomUUID();
    const sprintId = randomUUID();
    await seedProject({ projectId, sprintId, members: [{ sub: MEMBER_SUB, role: 'member' }] });

    const res = await postToken({ sprintId });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.scopes).toEqual([`sprint:${sprintId}`, `project:${projectId}`]);
    expect(body.exp).toBe(Math.floor(NOW.getTime() / 1000) + 600);

    const verified = verifyRealtimeToken(body.token, SECRET, { now: NOW.getTime() });
    expect(verified.ok).toBe(true);
    expect(verified.payload.sub).toBe(MEMBER_SUB);
    expect(verified.payload.scopes).toEqual(body.scopes);
  });

  it('issues tokens for owners and admins too', async () => {
    const projectId = randomUUID();
    const sprintId = randomUUID();
    await seedProject({
      projectId,
      sprintId,
      members: [
        { sub: 'owner-user', role: 'owner' },
        { sub: 'admin-user', role: 'admin' },
      ],
    });

    expect((await postToken({ sprintId, sub: 'owner-user' })).statusCode).toBe(200);
    expect((await postToken({ sprintId, sub: 'admin-user' })).statusCode).toBe(200);
  });

  it('returns 403 for a signed-in non-member (token issuance is membership-gated)', async () => {
    const projectId = randomUUID();
    const sprintId = randomUUID();
    await seedProject({ projectId, sprintId, members: [{ sub: MEMBER_SUB, role: 'member' }] });

    const res = await postToken({ sprintId, sub: OUTSIDER_SUB });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown sprint', async () => {
    const res = await postToken({ sprintId: randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without authenticated claims', async () => {
    const res = await handler({
      httpMethod: 'POST',
      resource: '/api/sprints/{sprintId}/realtime-token',
      pathParameters: { sprintId: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /projects/{projectId}/realtime-token', () => {
  it('issues a project-scoped token for a member', async () => {
    const projectId = randomUUID();
    await seedProject({ projectId, members: [{ sub: MEMBER_SUB, role: 'member' }] });

    const res = await postToken({ projectId });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.scopes).toEqual([`project:${projectId}`]);
    const verified = verifyRealtimeToken(body.token, SECRET, { now: NOW.getTime() });
    expect(verified.ok).toBe(true);
    expect(verified.payload.sub).toBe(MEMBER_SUB);
  });

  it('returns 403 for a non-member', async () => {
    const projectId = randomUUID();
    await seedProject({ projectId, members: [{ sub: MEMBER_SUB, role: 'member' }] });

    const res = await postToken({ projectId, sub: OUTSIDER_SUB });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an unknown project (indistinguishable from non-membership)', async () => {
    const res = await postToken({ projectId: randomUUID() });
    expect(res.statusCode).toBe(403);
  });
});

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await handler({
      httpMethod: 'GET',
      resource: '/api/sprints/{sprintId}/discussions',
      pathParameters: { sprintId: randomUUID() },
      requestContext: { authorizer: { claims: { sub: MEMBER_SUB } } },
    });
    expect(res.statusCode).toBe(404);
  });
});
