import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

const PARTITION = `t-${randomUUID()}`;
const USER_ID = `u-${randomUUID()}`;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler } = await import('../index.js'));

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
  await conn?.close();
});

// ---------------------------------------------------------------------------
// Helpers — the task write handlers are gone (v1 is read-only), so all
// seeding goes straight through gremlin, mirroring the old POST shape.
// ---------------------------------------------------------------------------

const seedSprint = async () => {
  const projectId = randomUUID();
  const sprintId = randomUUID();
  await g.addV('Project').property('id', projectId).next();
  await g.addV('User').property('id', USER_ID).next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .V()
    .has('User', 'id', USER_ID)
    .as('u')
    .addE('HAS_MEMBER')
    .from_('p')
    .to('u')
    .property('role', 'owner')
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('Sprint')
    .property('id', sprintId)
    .property('name', 'Sprint 1')
    .as('s')
    .addE('HAS_SPRINT')
    .from_('p')
    .to('s')
    .next();
  return sprintId;
};

const claims = (sub = USER_ID) => ({
  requestContext: { authorizer: { claims: { sub } } },
});

const seedTask = async (
  sprintId,
  { title = 'Task', description = '', status = 'todo', dependencies = [] } = {},
) => {
  const id = randomUUID();
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Task')
    .property('id', id)
    .property('title', title)
    .property('description', description)
    .property('status', status)
    .property('sprint_id', sprintId)
    .property('dependencies', JSON.stringify(dependencies))
    .as('t')
    .addE('CONTAINS')
    .from_('s')
    .to('t')
    .next();
  return id;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /sprints/:sprintId/tasks', () => {
  it('lists tasks in a sprint', async () => {
    const sprintId = await seedSprint();
    await seedTask(sprintId, { title: 'A' });
    await seedTask(sprintId, { title: 'B' });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const tasks = JSON.parse(res.body);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title).toSorted()).toEqual(['A', 'B']);
  });

  it('does not return tasks belonging to a different sprint', async () => {
    const sprintId = await seedSprint();
    const otherSprintId = await seedSprint();
    await seedTask(otherSprintId, { title: 'Foreign' });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId },
      ...claims(),
    });
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('rejects a signed-in non-member', async () => {
    const sprintId = await seedSprint();
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId },
      ...claims('outsider'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns a single task by id with all fields mapped', async () => {
    const sprintId = await seedSprint();
    const depId = await seedTask(sprintId, { title: 'Dep' });
    const id = await seedTask(sprintId, {
      title: 'Solo',
      description: 'desc',
      status: 'in_progress',
      dependencies: [depId],
    });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: id },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      id,
      title: 'Solo',
      description: 'desc',
      status: 'in_progress',
      sprintId,
      dependencies: [depId],
    });
  });

  it('returns 404 for non-existent task', async () => {
    const sprintId = await seedSprint();
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: 'nonexistent' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not accept a task from another sprint', async () => {
    const sprintId = await seedSprint();
    const otherSprintId = await seedSprint();
    const taskId = await seedTask(otherSprintId);
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('method routing (v1 is read-only)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('returns 405 for %s', async (httpMethod) => {
    const sprintId = await seedSprint();
    const taskId = await seedTask(sprintId);
    const res = await handler({
      httpMethod,
      pathParameters: { sprintId, taskId },
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });

  it('returns 405 for the removed mcp-servers/steering-docs sub-resources', async () => {
    const sprintId = await seedSprint();
    const taskId = await seedTask(sprintId);
    for (const sub of ['mcp-servers', 'steering-docs']) {
      const res = await handler({
        httpMethod: 'PUT',
        pathParameters: { sprintId, taskId },
        path: `/sprints/${sprintId}/tasks/${taskId}/${sub}`,
        body: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(405);
    }
  });
});
