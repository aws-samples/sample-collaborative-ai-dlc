import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

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

beforeEach(async () => {
  await g.V().drop().next();
});

const addSprint = async (sprintId) =>
  g
    .addV('Sprint')
    .property('id', sprintId)
    .property('name', 'Sprint')
    .property('phase', 'INCEPTION')
    .property('current_stage', 'requirements-analysis')
    .property('phase_status', 'active')
    .next();

// containment is one of: CONTAINS, HAS_REVIEW, HAS_PR, HAS_AGENT_RUN
const addContained = async (sprintId, label, props, containment = 'CONTAINS') => {
  const id = props.id ?? `v-${randomUUID()}`;
  let t = g.addV(label).property('id', id);
  for (const [key, val] of Object.entries(props)) {
    if (key === 'id') continue;
    t = t.property(key, val);
  }
  await t.next();
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .addE(containment)
    .to(gremlin.process.statics.V().has(label, 'id', id))
    .next();
  return id;
};

const addEdge = async (fromLabel, fromId, edge, toLabel, toId) => {
  await g
    .V()
    .has(fromLabel, 'id', fromId)
    .addE(edge)
    .to(gremlin.process.statics.V().has(toLabel, 'id', toId))
    .next();
};

const invoke = (sprintId) => handler({ httpMethod: 'GET', pathParameters: { sprintId } });

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /sprint-graph', () => {
  it('returns the Sprint workflow state when the sprint has no contained vertices', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    const res = await invoke(sprintId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      nodes: [
        expect.objectContaining({
          id: sprintId,
          type: 'Sprint',
          label: 'Sprint',
          phase: 'INCEPTION',
          current_stage: 'requirements-analysis',
          phase_status: 'active',
        }),
      ],
      edges: [],
    });
  });

  it('uses the title → file_path → agent_type → status → "(unnamed)" label fallback chain', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const taskId = await addContained(sprintId, 'Task', { title: 'T', status: 'open' });
    const fileId = await addContained(sprintId, 'CodeFile', { file_path: '/a.js' }, 'CONTAINS');
    const runId = await addContained(
      sprintId,
      'AgentRun',
      { agent_type: 'inception' },
      'HAS_AGENT_RUN',
    );
    const reviewId = await addContained(
      sprintId,
      'ReviewItem',
      { status: 'pending' },
      'HAS_REVIEW',
    );
    const prId = await addContained(sprintId, 'PR', {}, 'HAS_PR');

    const res = await invoke(sprintId);
    expect(res.statusCode).toBe(200);
    const { nodes } = JSON.parse(res.body);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    expect(byId[sprintId]).toMatchObject({ type: 'Sprint', label: 'Sprint' });
    expect(byId[taskId]).toMatchObject({ type: 'Task', label: 'T' });
    expect(byId[fileId]).toMatchObject({ type: 'CodeFile', label: '/a.js' });
    expect(byId[runId]).toMatchObject({ type: 'AgentRun', label: 'inception' });
    expect(byId[reviewId]).toMatchObject({ type: 'ReviewItem', label: 'pending' });
    expect(byId[prId]).toMatchObject({ type: 'PR', label: '(unnamed)' });
  });

  it('flattens valueMap props into top-level node fields', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const taskId = await addContained(sprintId, 'Task', {
      title: 'My Task',
      status: 'in_progress',
      assignee: 'alice',
    });

    const res = await invoke(sprintId);
    const { nodes } = JSON.parse(res.body);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === taskId)).toMatchObject({
      id: taskId,
      type: 'Task',
      label: 'My Task',
      title: 'My Task',
      status: 'in_progress',
      assignee: 'alice',
    });
  });

  it('includes inter-vertex edges and excludes containment edges', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const a = await addContained(sprintId, 'Task', { title: 'A' });
    const b = await addContained(sprintId, 'Task', { title: 'B' });
    await addEdge('Task', a, 'DEPENDS_ON', 'Task', b);

    const res = await invoke(sprintId);
    const { edges } = JSON.parse(res.body);
    expect(edges).toEqual([{ source: a, target: b, label: 'DEPENDS_ON' }]);
  });

  it('excludes edges whose other endpoint is not contained by the sprint', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const inSprint = await addContained(sprintId, 'Task', { title: 'In' });

    // Outside-the-sprint vertex (no CONTAINS edge from this sprint)
    const outsideId = `v-${randomUUID()}`;
    await g.addV('Task').property('id', outsideId).property('title', 'Out').next();
    await addEdge('Task', inSprint, 'DEPENDS_ON', 'Task', outsideId);

    const res = await invoke(sprintId);
    const { nodes, edges } = JSON.parse(res.body);
    expect(nodes.map((n) => n.id).sort()).toEqual([inSprint, sprintId].sort());
    expect(edges).toEqual([]);
  });

  it('does not return nodes from a sibling partition', async () => {
    const sprintId = `s-${randomUUID()}`;
    const otherPartition = `t-${randomUUID()}`;
    const otherG = gremlin.process.AnonymousTraversalSource.traversal()
      .withRemote(conn)
      .withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: otherPartition,
          readPartitions: [otherPartition],
        }),
      );
    await otherG.addV('Sprint').property('id', sprintId).next();
    const otherTaskId = `v-${randomUUID()}`;
    await otherG.addV('Task').property('id', otherTaskId).property('title', 'Foreign').next();
    await otherG
      .V()
      .has('Sprint', 'id', sprintId)
      .addE('CONTAINS')
      .to(gremlin.process.statics.V().has('Task', 'id', otherTaskId))
      .next();

    // Same sprintId in our partition — should be empty.
    await addSprint(sprintId);
    const res = await invoke(sprintId);
    expect(JSON.parse(res.body)).toEqual({
      nodes: [expect.objectContaining({ id: sprintId, type: 'Sprint' })],
      edges: [],
    });

    await otherG.V().drop().next();
  });
});
