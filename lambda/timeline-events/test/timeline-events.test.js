import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

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

  // Direct gremlin connection for seeding sprints. Uses the same partition so
  // writes are visible to the handler under test.
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
  // Pin Date so the POST timestamp default is assertable. Don't fake
  // setTimeout/etc — gremlin's WebSocket driver uses real timers internally.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const addSprint = async (sprintId) => g.addV('Sprint').property('id', sprintId).next();

const get = (sprintId) => handler({ httpMethod: 'GET', pathParameters: { sprintId } });

const post = (sprintId, data) =>
  handler({ httpMethod: 'POST', pathParameters: { sprintId }, body: JSON.stringify(data) });

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

    await post(sprintId, {
      type: 'created',
      title: 'First',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await post(sprintId, {
      type: 'updated',
      title: 'Third',
      timestamp: '2026-01-03T00:00:00.000Z',
    });
    await post(sprintId, {
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
    await post(sprintId, {
      type: 'comment',
      title: 'A title',
      detail: 'some detail',
      userId: 'u-1',
      userName: 'Alice',
      timestamp: '2026-02-02T00:00:00.000Z',
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
    });
  });

  it('does not return events belonging to a different sprint', async () => {
    const sprintId = `s-${randomUUID()}`;
    const otherSprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    await addSprint(otherSprintId);
    await post(otherSprintId, { type: 'created', title: 'Foreign' });

    const res = await get(sprintId);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('POST /sprints/:sprintId/timeline', () => {
  it('creates an event, wires the HAS_TIMELINE_EVENT edge, and echoes it back', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    const res = await post(sprintId, {
      type: 'created',
      title: 'Sprint started',
      detail: 'kicked off',
      userId: 'u-7',
      userName: 'Bob',
      timestamp: '2026-03-03T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      id: expect.stringMatching(UUID_RE),
      type: 'created',
      title: 'Sprint started',
      detail: 'kicked off',
      userId: 'u-7',
      userName: 'Bob',
      timestamp: '2026-03-03T00:00:00.000Z',
      sprintId,
    });

    // Follow-up GET confirms the edge from the sprint was created.
    const fetched = await get(sprintId);
    expect(JSON.parse(fetched.body)).toHaveLength(1);
    expect(JSON.parse(fetched.body)[0].id).toBe(JSON.parse(res.body).id);
  });

  it('defaults timestamp to now and optional fields to empty strings', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    const res = await post(sprintId, { type: 'created', title: 'Minimal' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      id: expect.stringMatching(UUID_RE),
      type: 'created',
      title: 'Minimal',
      detail: '',
      userId: '',
      userName: '',
      timestamp: NOW.toISOString(),
      sprintId,
    });
  });
});

describe('method routing', () => {
  it('returns 405 for an unsupported method', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const res = await handler({ httpMethod: 'PATCH', pathParameters: { sprintId } });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});
