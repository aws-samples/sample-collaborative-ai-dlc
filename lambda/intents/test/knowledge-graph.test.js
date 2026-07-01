import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fetchKnowledgeGraph } from '../knowledge-graph.js';

const PARTITION = `t-kg-${randomUUID()}`;

let conn;
let g;

const PROJECT = 'proj-kg';
const INTENT = 'intent-kg';

beforeAll(async () => {
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
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
});

const addV = async (label, props) => {
  let q = g.addV(label);
  for (const [k, v] of Object.entries(props)) q = q.property(k, v);
  await q.next();
};

const addE = async (fromLabel, fromId, edge, toLabel, toId) => {
  await g
    .V()
    .has(fromLabel, 'id', fromId)
    .addE(edge)
    .to(gremlin.process.statics.V().has(toLabel, 'id', toId))
    .next();
};

// The full subgraph a live run accrues: intent anchor, two linked artifacts,
// a question, a discussion on an artifact, and project knowledge/learnings.
const seedFullGraph = async () => {
  await addV('Project', { id: PROJECT, name: 'P' });
  await addV('Intent', { id: INTENT, project_id: PROJECT, title: 'Build login' });
  await addV('Artifact', {
    id: 'reqs-1',
    artifact_type: 'requirements-analysis',
    title: 'Requirements',
    content: '# Requirements\n- login',
    created_by_stage_instance_id: 'si-req',
    created_at: '2026-01-01T00:00:00Z',
  });
  await addV('Artifact', {
    id: 'design-1',
    artifact_type: 'application-design',
    title: 'Design',
    content: 'x'.repeat(1000),
    created_by_stage_instance_id: 'si-design',
    created_at: '2026-01-01T01:00:00Z',
  });
  await addE('Intent', INTENT, 'CONTAINS', 'Artifact', 'reqs-1');
  await addE('Intent', INTENT, 'CONTAINS', 'Artifact', 'design-1');
  await addE('Artifact', 'design-1', 'DERIVED_FROM', 'Artifact', 'reqs-1');

  await addV('Question', {
    id: 'q-1',
    intent_id: INTENT,
    questions: JSON.stringify([{ text: 'Which auth provider?', type: 'single', options: [] }]),
    structured_answer: JSON.stringify({ answers: [{ freeText: 'Cognito' }] }),
    answered_by_name: 'Ada',
    answered_at: '2026-01-01T00:35:00Z',
    created_at: '2026-01-01T00:30:00Z',
  });
  await addE('Intent', INTENT, 'CONTAINS', 'Question', 'q-1');
  await addE('Question', 'q-1', 'INFLUENCES', 'Artifact', 'reqs-1');

  await addV('Discussion', {
    id: 'disc-1',
    intent_id: INTENT,
    entity_type: 'artifact',
    entity_title: 'Requirements',
    status: 'open',
    created_at: '2026-01-01T00:45:00Z',
  });
  await addE('Intent', INTENT, 'HAS_DISCUSSION', 'Discussion', 'disc-1');
  await addE('Discussion', 'disc-1', 'DISCUSSES', 'Artifact', 'reqs-1');

  await addV('TeamKnowledge', {
    id: 'tk-1',
    title: 'Naming convention',
    content: 'use kebab-case ids',
    agent_ref: 'shared',
    created_by_intent_id: 'some-earlier-intent',
    created_at: '2025-12-01T00:00:00Z',
  });
  await addE('Project', PROJECT, 'HAS_KNOWLEDGE', 'TeamKnowledge', 'tk-1');

  await addV('LearningRule', {
    id: 'lr-1',
    title: 'No plaintext secrets',
    content: 'NEVER store secrets in plaintext',
    layer: 'project-learnings',
    pairing: 'feedforward-only',
    created_by_intent_id: INTENT,
    created_at: '2025-12-02T00:00:00Z',
  });
  await addE('Project', PROJECT, 'HAS_LEARNING', 'LearningRule', 'lr-1');
};

const byId = (nodes, id) => nodes.find((n) => n.id === id);
const edge = (edges, source, target, label) =>
  edges.find((e) => e.source === source && e.target === target && e.label === label);

describe('fetchKnowledgeGraph', () => {
  it('returns an empty graph before init-ws created the Intent anchor', async () => {
    const graph = await fetchKnowledgeGraph(g, { projectId: PROJECT, intentId: INTENT });
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  it('assembles the full typed subgraph: hub, artifacts, question, discussion, knowledge', async () => {
    await seedFullGraph();
    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });

    // Hub
    expect(byId(nodes, INTENT)).toMatchObject({ type: 'Intent', label: 'Build login' });

    // Artifacts with provenance + bounded content preview
    expect(byId(nodes, 'reqs-1')).toMatchObject({
      type: 'Artifact',
      label: 'Requirements',
      artifactType: 'requirements-analysis',
      createdByStageInstanceId: 'si-req',
      contentLength: '# Requirements\n- login'.length,
    });
    const design = byId(nodes, 'design-1');
    expect(design.contentLength).toBe(1000);
    expect(design.contentPreview.length).toBeLessThanOrEqual(401); // 400 + ellipsis
    expect(design.contentPreview.endsWith('…')).toBe(true);

    // Question labeled by its first question text, carrying the raw JSON
    expect(byId(nodes, 'q-1')).toMatchObject({
      type: 'Question',
      label: 'Which auth provider?',
      answeredByName: 'Ada',
      answeredAt: '2026-01-01T00:35:00Z',
    });
    expect(JSON.parse(byId(nodes, 'q-1').questions)[0].text).toBe('Which auth provider?');

    // Discussion + project knowledge corpus
    expect(byId(nodes, 'disc-1')).toMatchObject({
      type: 'Discussion',
      label: 'Requirements',
      entityType: 'artifact',
      status: 'open',
    });
    expect(byId(nodes, 'tk-1')).toMatchObject({
      type: 'TeamKnowledge',
      agentRef: 'shared',
      createdByIntentId: 'some-earlier-intent',
    });
    expect(byId(nodes, 'lr-1')).toMatchObject({
      type: 'LearningRule',
      layer: 'project-learnings',
    });

    // Edges: containment, business relation, discussion anchor, synthesized INFORMS
    expect(edge(edges, INTENT, 'reqs-1', 'CONTAINS')).toBeDefined();
    expect(edge(edges, INTENT, 'q-1', 'CONTAINS')).toBeDefined();
    expect(edge(edges, 'q-1', 'reqs-1', 'INFLUENCES')).toBeDefined();
    expect(edge(edges, 'design-1', 'reqs-1', 'DERIVED_FROM')).toBeDefined();
    expect(edge(edges, 'disc-1', 'reqs-1', 'DISCUSSES')).toBeDefined();
    expect(edge(edges, 'tk-1', INTENT, 'INFORMS')).toBeDefined();
    expect(edge(edges, 'lr-1', INTENT, 'INFORMS')).toBeDefined();
  });

  it("excludes another intent's artifacts and their edges", async () => {
    await seedFullGraph();
    await addV('Intent', { id: 'other-intent', project_id: PROJECT, title: 'Other' });
    await addV('Artifact', {
      id: 'other-art',
      artifact_type: 'design',
      title: 'Other art',
      content: '',
    });
    await addE('Intent', 'other-intent', 'CONTAINS', 'Artifact', 'other-art');
    // A cross-intent business edge must not leak into this intent's graph.
    await addE('Artifact', 'reqs-1', 'RELATES_TO', 'Artifact', 'other-art');

    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });
    expect(byId(nodes, 'other-art')).toBeUndefined();
    expect(edges.some((e) => e.target === 'other-art' || e.source === 'other-art')).toBe(false);
  });

  it('tolerates a missing Project vertex (no knowledge corpus yet)', async () => {
    await addV('Intent', { id: INTENT, project_id: PROJECT, title: 'T' });
    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });
    expect(nodes.map((n) => n.type)).toEqual(['Intent']);
    expect(edges).toEqual([]);
  });
});

// ── Steering (docs/v2-steering.md) ──

describe('fetchKnowledgeGraph — steering + supersede lineage', () => {
  it('renders Steering nodes with REVISES/INFLUENCES edges and flags superseded artifacts', async () => {
    await seedFullGraph();
    await addV('Steering', {
      id: 'st-1',
      intent_id: INTENT,
      kind: 'revision',
      message: 'Actually use the event bus, not REST.',
      target_gate_id: 'q-1',
      created_by_name: 'Ada',
      created_at: '2026-01-01T02:00:00Z',
    });
    await addE('Intent', INTENT, 'CONTAINS', 'Steering', 'st-1');
    await addE('Steering', 'st-1', 'REVISES', 'Question', 'q-1');
    await addE('Steering', 'st-1', 'INFLUENCES', 'Artifact', 'design-1');
    // A rewind superseded the design artifact (marker props, not `status`).
    await g
      .V()
      .has('Artifact', 'id', 'design-1')
      .property('superseded_at', '2026-01-01T02:00:00Z')
      .property('superseded_by', 'st-1')
      .next();

    const graph = await fetchKnowledgeGraph(g, { projectId: PROJECT, intentId: INTENT });

    const steering = graph.nodes.find((n) => n.type === 'Steering');
    expect(steering).toMatchObject({
      id: 'st-1',
      kind: 'revision',
      targetGateId: 'q-1',
      createdByName: 'Ada',
    });
    expect(steering.label).toContain('event bus');

    // Membership + provenance edges all present.
    expect(graph.edges).toContainEqual({ source: INTENT, target: 'st-1', label: 'CONTAINS' });
    expect(graph.edges).toContainEqual({ source: 'st-1', target: 'q-1', label: 'REVISES' });
    expect(graph.edges).toContainEqual({ source: 'st-1', target: 'design-1', label: 'INFLUENCES' });

    // Supersede lineage flags surface on artifact nodes.
    const design = graph.nodes.find((n) => n.id === 'design-1');
    expect(design.superseded).toBe(true);
    const reqs = graph.nodes.find((n) => n.id === 'reqs-1');
    expect(reqs.superseded).toBe(false);
  });
});
