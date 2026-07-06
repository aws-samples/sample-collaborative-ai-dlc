import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

let handler;
let close;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  // If a developer has AWS_PROFILE set locally, the SDK preempts the env-var
  // creds planted by globalSetup and tries to resolve the profile via SSO/IMDS,
  // adding ~1s per getConnection call. Unset for the test process.
  vi.stubEnv('AWS_PROFILE', undefined);
  // The handler builds its neptune-lambda-client at import time from the env;
  // globalSetup has already pointed GREMLIN_PROTOCOL at the plain-ws container,
  // so useIam resolves to false and nothing is signed.
  ({ handler, close } = await import('../index.js'));

  // Direct gremlin connection for seeding. Uses the same partition so writes
  // are visible to the handler under test. The POST handler is gone (v1 is
  // read-only), so all seeding goes straight through gremlin.
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
});

const addSprint = async (sprintId) => g.addV('Sprint').property('id', sprintId).next();

// Seeds a TimelineEvent with the same property shape the removed POST handler
// used to write.
const addEvent = async (sprintId, data) => {
  const id = randomUUID();
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('TimelineEvent')
    .property('id', id)
    .property('type', data.type)
    .property('title', data.title)
    .property('detail', data.detail || '')
    .property('user_id', data.userId || '')
    .property('user_name', data.userName || '')
    .property('timestamp', data.timestamp || new Date().toISOString())
    .property('sprint_id', sprintId)
    .property('question_id', data.questionId || '')
    .as('e')
    .addE('HAS_TIMELINE_EVENT')
    .from_('s')
    .to('e')
    .next();
  return id;
};

const get = (sprintId) => handler({ httpMethod: 'GET', pathParameters: { sprintId } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /sprints/:sprintId/timeline', () => {
  it('returns an empty list when the sprint has no events', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    const res = await get(sprintId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns events ordered by timestamp descending', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    await addEvent(sprintId, {
      type: 'created',
      title: 'First',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await addEvent(sprintId, {
      type: 'updated',
      title: 'Third',
      timestamp: '2026-01-03T00:00:00.000Z',
    });
    await addEvent(sprintId, {
      type: 'updated',
      title: 'Second',
      timestamp: '2026-01-02T00:00:00.000Z',
    });

    const res = await get(sprintId);
    expect(res.statusCode).toBe(200);
    const titles = JSON.parse(res.body).map((e) => e.title);
    expect(titles).toEqual(['Third', 'Second', 'First']);
  });

  it('maps every persisted property into the camelCase response shape', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    await addEvent(sprintId, {
      type: 'comment',
      title: 'A title',
      detail: 'some detail',
      userId: 'u-1',
      userName: 'Alice',
      timestamp: '2026-02-02T00:00:00.000Z',
      questionId: 'q-42',
    });

    const res = await get(sprintId);
    const [event] = JSON.parse(res.body);
    expect(event).toEqual({
      id: expect.stringMatching(UUID_RE),
      type: 'comment',
      title: 'A title',
      detail: 'some detail',
      userId: 'u-1',
      userName: 'Alice',
      timestamp: '2026-02-02T00:00:00.000Z',
      sprintId,
      questionId: 'q-42',
    });
  });

  it('does not return events belonging to a different sprint', async () => {
    const sprintId = `s-${randomUUID()}`;
    const otherSprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    await addSprint(otherSprintId);
    await addEvent(otherSprintId, { type: 'created', title: 'Foreign' });

    const res = await get(sprintId);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('method routing (v1 is read-only)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('returns 405 for %s', async (httpMethod) => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const res = await handler({
      httpMethod,
      pathParameters: { sprintId },
      body: JSON.stringify({ type: 'created', title: 'nope' }),
    });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});
