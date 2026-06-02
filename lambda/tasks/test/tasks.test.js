import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const PARTITION = `t-${randomUUID()}`;

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const claims = (sub, email = `${sub}@x`) => ({
  requestContext: { authorizer: { claims: { sub, email } } },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Seed a project + sprint + member in the graph (the tasks lambda doesn't create these).
const seedProjectAndSprint = async (ownerSub) => {
  const projectId = randomUUID();
  const sprintId = randomUUID();

  // Create user
  await g.addV('User').property('id', ownerSub).property('email', `${ownerSub}@x`).next();

  // Create project
  await g.addV('Project').property('id', projectId).property('name', 'TestProject').next();

  // HAS_MEMBER edge (Project -> User)
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', 'owner')
    .to(gremlin.process.statics.V().has('User', 'id', ownerSub))
    .next();

  // Create sprint
  await g.addV('Sprint').property('id', sprintId).property('name', 'Sprint 1').next();

  // HAS_SPRINT edge (Project -> Sprint)
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_SPRINT')
    .to(gremlin.process.statics.V().has('Sprint', 'id', sprintId))
    .next();

  return { projectId, sprintId };
};

const createTask = async (sub, sprintId, body = { title: 'Task 1' }) => {
  const res = await handler({
    httpMethod: 'POST',
    pathParameters: { sprintId },
    body: JSON.stringify(body),
    ...claims(sub),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
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

describe('POST /sprints/:sprintId/tasks', () => {
  it('creates a task with defaults', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const created = await createTask(sub, sprintId, { title: 'My Task', description: 'desc' });
    expect(created).toEqual({
      id: expect.stringMatching(UUID_RE),
      title: 'My Task',
      description: 'desc',
      status: 'todo',
      sprintId,
      dependencies: [],
    });
  });

  it('creates a task with dependencies', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const dep = await createTask(sub, sprintId, { title: 'Dep' });
    const task = await createTask(sub, sprintId, {
      title: 'Main',
      dependencies: [dep.id],
    });
    expect(task.dependencies).toEqual([dep.id]);
  });
});

describe('GET /sprints/:sprintId/tasks', () => {
  it('lists tasks in a sprint', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    await createTask(sub, sprintId, { title: 'A' });
    await createTask(sub, sprintId, { title: 'B' });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const tasks = JSON.parse(res.body);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title).sort()).toEqual(['A', 'B']);
  });

  it('returns a single task by id', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'Solo' });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id, title: 'Solo' });
  });

  it('returns 404 for non-existent task', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: 'nonexistent' },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /sprints/:sprintId/tasks/:taskId', () => {
  it('updates task title when status is todo', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'Old' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ title: 'New' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe('New');
  });

  it('allows status change regardless of current status', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    // Move to in_progress
    let res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'in_progress' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('in_progress');

    // Move to done
    res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'done' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('done');
  });

  it('rejects non-status field edits when status is not todo', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    // Move to in_progress
    await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'in_progress' }),
      ...claims(sub),
    });

    // Try to update title — should fail
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ title: 'Nope' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('status is todo');
  });

  it('returns 401 when sub is missing', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'done' }),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when user is not a project member', async () => {
    const sub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    // Create a different user vertex
    await g.addV('User').property('id', otherSub).property('email', `${otherSub}@x`).next();

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'done' }),
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when task does not belong to sprint', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { sprintId: otherSprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId: otherSprintId, taskId: id },
      body: JSON.stringify({ status: 'done' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /sprints/:sprintId/tasks/:taskId', () => {
  it('deletes a task and returns 204', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'Doomed' });

    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { sprintId, taskId: id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(204);

    // Confirm it's gone
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: id },
      ...claims(sub),
    });
    expect(fetched.statusCode).toBe(404);
  });
});

describe('MCP servers sub-resource', () => {
  it('GET returns empty array for new task', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/mcp-servers`,
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mcpServers).toBe('[]');
  });

  it('PUT saves valid mcp-servers config', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const mcpServers = JSON.stringify([{ name: 'myServer', command: 'node', args: ['server.js'] }]);

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).saved).toBe(true);
  });

  it('PUT rejects when task is not in todo status', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    // Move to in_progress
    await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'in_progress' }),
      ...claims(sub),
    });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers: '{}' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('Steering docs sub-resource', () => {
  it('PUT saves steering docs metadata', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [{ filename: 'guide.md' }] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.saved).toBe(true);
    expect(body.uploadUrls).toHaveLength(1);
    expect(body.uploadUrls[0].filename).toBe('guide.md');
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('PUT rejects invalid filenames', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [{ filename: '../evil.md' }] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid filename');
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('PUT rejects non-.md filenames', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [{ filename: 'notes.txt' }] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('PUT rejects when task is not in todo status', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      body: JSON.stringify({ status: 'in_progress' }),
      ...claims(sub),
    });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [{ filename: 'doc.md' }] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('PUT returns 500 when ARTIFACTS_BUCKET is not set', async () => {
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [{ filename: 'doc.md' }] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('ARTIFACTS_BUCKET');
  });

  it('PUT rejects more than 20 documents', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { sprintId } = await seedProjectAndSprint(sub);
    const { id } = await createTask(sub, sprintId, { title: 'T' });

    const docs = Array.from({ length: 21 }, (_, i) => ({ filename: `doc${i}.md` }));
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId, taskId: id },
      path: `/sprints/${sprintId}/tasks/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: docs }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Maximum 20');
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });
});
