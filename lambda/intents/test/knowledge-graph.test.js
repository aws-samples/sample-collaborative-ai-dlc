import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fetchKnowledgeGraph, flattenVertexMap } from '../knowledge-graph.js';

// Field regression: Neptune returns the valueMap(true) T.id token AFTER the
// business `id` property (gremlin-server returns it first). The old flatten
// let the token clobber the business id with the internal vertex UUID —
// dropping EVERY artifact↔artifact edge from the UI graph (edge endpoints are
// business ids, so mapEdgeRows found no matching node).
describe('flattenVertexMap — Neptune token order', () => {
  it('business id wins over the T.id token regardless of position', () => {
    const T_ID = { elementName: 'id' };
    const neptuneOrder = new Map([
      ['id', ['reqs-1']],
      [T_ID, 'e0cf8ec4-af58-149d-8766-e2a3466e411f'],
    ]);
    expect(flattenVertexMap(neptuneOrder).id).toBe('reqs-1');
    const gserverOrder = new Map([
      [T_ID, 'e0cf8ec4-af58-149d-8766-e2a3466e411f'],
      ['id', ['reqs-1']],
    ]);
    expect(flattenVertexMap(gserverOrder).id).toBe('reqs-1');
  });
});

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

  it('lazily renders only the newest legacy artifact for one logical identity', async () => {
    await addV('Intent', { id: INTENT, project_id: PROJECT, title: 'T' });
    await addV('Artifact', {
      id: 'legacy-old',
      intent_id: INTENT,
      artifact_type: 'design',
      created_by_stage_instance_id: 'si-design',
      created_at: '2026-01-01T00:00:00Z',
      content: 'old',
    });
    await addV('Artifact', {
      id: 'legacy-new',
      intent_id: INTENT,
      artifact_type: 'design',
      created_by_stage_instance_id: 'si-design',
      created_at: '2026-01-02T00:00:00Z',
      content: 'new',
    });
    await addE('Intent', INTENT, 'CONTAINS', 'Artifact', 'legacy-old');
    await addE('Intent', INTENT, 'CONTAINS', 'Artifact', 'legacy-new');

    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });
    expect(byId(nodes, 'legacy-new')).toMatchObject({ type: 'Artifact', contentPreview: 'new' });
    expect(byId(nodes, 'legacy-old')).toBeUndefined();
    expect(
      edges.some((candidate) => candidate.source === INTENT && candidate.target === 'legacy-old'),
    ).toBe(false);
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
  it('renders Steering provenance but excludes superseded artifacts and their edges', async () => {
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

    // Membership + current-only provenance edges are present.
    expect(graph.edges).toContainEqual({ source: INTENT, target: 'st-1', label: 'CONTAINS' });
    expect(graph.edges).toContainEqual({ source: 'st-1', target: 'q-1', label: 'REVISES' });
    expect(graph.edges).not.toContainEqual({
      source: 'st-1',
      target: 'design-1',
      label: 'INFLUENCES',
    });
    expect(graph.nodes.find((n) => n.id === 'design-1')).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'reqs-1')).toBeDefined();
  });
});

// ── Derived layer (typed items + unit DAG mirror) ──

describe('fetchKnowledgeGraph — derived layer', () => {
  it('renders current typed items and units with their edges, tagged graphLayer=derived', async () => {
    await seedFullGraph();
    await addV('Story', {
      id: 'story:intent-kg:s-login',
      artifact_id: 'reqs-1',
      artifact_type: 'requirements-analysis',
      slug: 's-login',
      title: 'User logs in',
      priority: 'must-have',
      persona: 'registered-user',
      acceptance_criteria: JSON.stringify(['Valid credentials open a session', 'Lockout after 5']),
      covers: JSON.stringify(['req-user-login']),
      superseded_at: '',
    });
    await addE('Artifact', 'reqs-1', 'HAS_ITEM', 'Story', 'story:intent-kg:s-login');
    // A second type (Persona) to prove itemFields is schema-driven, not Story-specific.
    await addV('Persona', {
      id: 'persona:intent-kg:p-user',
      artifact_id: 'reqs-1',
      slug: 'p-user',
      title: 'Registered User',
      role: 'Customer with an account',
      goals: JSON.stringify(['Access the account quickly']),
      pain_points: JSON.stringify(['Forgotten passwords']),
      superseded_at: '',
    });
    await addE('Artifact', 'reqs-1', 'HAS_ITEM', 'Persona', 'persona:intent-kg:p-user');
    // A superseded item (re-derive removed it) must not render.
    await addV('Story', {
      id: 'story:intent-kg:s-old',
      artifact_id: 'reqs-1',
      slug: 's-old',
      title: 'Removed story',
      superseded_at: '2026-01-02T00:00:00Z',
    });
    await addE('Artifact', 'reqs-1', 'HAS_ITEM', 'Story', 'story:intent-kg:s-old');
    // Artifact-level citation projection.
    await addE('Artifact', 'design-1', 'CITES', 'Artifact', 'reqs-1');
    // Unit DAG mirror.
    await addV('UnitOfWork', { id: 'unit:intent-kg:auth', slug: 'auth', superseded_at: '' });
    await addV('UnitOfWork', { id: 'unit:intent-kg:billing', slug: 'billing', superseded_at: '' });
    await addE('Intent', INTENT, 'CONTAINS', 'UnitOfWork', 'unit:intent-kg:auth');
    await addE('Intent', INTENT, 'CONTAINS', 'UnitOfWork', 'unit:intent-kg:billing');
    await addE(
      'UnitOfWork',
      'unit:intent-kg:billing',
      'DEPENDS_ON',
      'UnitOfWork',
      'unit:intent-kg:auth',
    );
    await addE('UnitOfWork', 'unit:intent-kg:auth', 'DERIVED_FROM', 'Artifact', 'design-1');

    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });

    expect(byId(nodes, 'story:intent-kg:s-login')).toMatchObject({
      type: 'Story',
      graphLayer: 'derived',
      label: 'User logs in',
      slug: 's-login',
      artifactId: 'reqs-1',
      priority: 'must-have',
    });
    // itemFields is schema-driven from the extractor REGISTRY: descriptive text
    // and list fields are projected; relation-backed fields (persona/covers) are
    // rendered as edges, so they must be ABSENT from itemFields.
    const storyFields = byId(nodes, 'story:intent-kg:s-login').itemFields;
    expect(storyFields).toContainEqual({
      name: 'acceptance_criteria',
      description: expect.any(String),
      kind: 'list',
      value: ['Valid credentials open a session', 'Lockout after 5'],
    });
    expect(storyFields.some((f) => f.name === 'persona')).toBe(false);
    expect(storyFields.some((f) => f.name === 'covers')).toBe(false);
    expect(storyFields.some((f) => f.name === 'depends_on')).toBe(false);
    // priority is a flat node prop (section + preview meta chips) — never
    // duplicated into itemFields.
    expect(storyFields.some((f) => f.name === 'priority')).toBe(false);

    // A different type surfaces ITS own field set — proving no Story-specific layout.
    const personaFields = byId(nodes, 'persona:intent-kg:p-user').itemFields;
    expect(personaFields).toContainEqual({
      name: 'role',
      description: expect.any(String),
      kind: 'text',
      value: 'Customer with an account',
    });
    expect(personaFields).toContainEqual({
      name: 'goals',
      description: expect.any(String),
      kind: 'list',
      value: ['Access the account quickly'],
    });
    expect(personaFields).toContainEqual({
      name: 'pain_points',
      description: expect.any(String),
      kind: 'list',
      value: ['Forgotten passwords'],
    });
    expect(byId(nodes, 'story:intent-kg:s-old')).toBeUndefined();
    expect(byId(nodes, 'unit:intent-kg:auth')).toMatchObject({
      type: 'UnitOfWork',
      graphLayer: 'derived',
      label: 'auth',
    });

    expect(edge(edges, 'reqs-1', 'story:intent-kg:s-login', 'HAS_ITEM')).toBeDefined();
    expect(edges.some((e) => e.target === 'story:intent-kg:s-old')).toBe(false);
    expect(edge(edges, 'design-1', 'reqs-1', 'CITES')).toBeDefined();
    expect(edge(edges, INTENT, 'unit:intent-kg:auth', 'CONTAINS')).toBeDefined();
    expect(
      edge(edges, 'unit:intent-kg:billing', 'unit:intent-kg:auth', 'DEPENDS_ON'),
    ).toBeDefined();
    expect(edge(edges, 'unit:intent-kg:auth', 'design-1', 'DERIVED_FROM')).toBeDefined();
  });

  it('hides items whose parent artifact was rewind-superseded', async () => {
    await seedFullGraph();
    await addV('Requirement', {
      id: 'requirement:intent-kg:req-x',
      artifact_id: 'design-1',
      slug: 'req-x',
      title: 'Orphaned by rewind',
      superseded_at: '',
    });
    await addE('Artifact', 'design-1', 'HAS_ITEM', 'Requirement', 'requirement:intent-kg:req-x');
    await g
      .V()
      .has('Artifact', 'id', 'design-1')
      .property('superseded_at', '2026-01-02T00:00:00Z')
      .next();
    const { nodes } = await fetchKnowledgeGraph(g, { projectId: PROJECT, intentId: INTENT });
    expect(byId(nodes, 'requirement:intent-kg:req-x')).toBeUndefined();
  });

  it('renders item↔item traceability edges (COVERS/FOR_PERSONA/DEPENDS_ON/IMPLEMENTS) and unit contract edges', async () => {
    await seedFullGraph();
    const item = async (label, slug, props = {}) => {
      const id = `${label.toLowerCase()}:intent-kg:${slug}`;
      await addV(label, {
        id,
        artifact_id: 'reqs-1',
        slug,
        title: slug,
        superseded_at: '',
        ...props,
      });
      await addE('Artifact', 'reqs-1', 'HAS_ITEM', label, id);
      return id;
    };
    const req = await item('Requirement', 'req-auth');
    const persona = await item('Persona', 'p-operator');
    const s1 = await item('Story', 's-login');
    const s2 = await item('Story', 's-report');
    const map = await item('StoryMapEntry', 'm-auth');
    const contract = await item('Contract', 'c-auth-api');
    await addV('UnitOfWork', { id: 'unit:intent-kg:u-auth', slug: 'u-auth', superseded_at: '' });
    await addE('Intent', INTENT, 'CONTAINS', 'UnitOfWork', 'unit:intent-kg:u-auth');
    // The edges the derive sweep materializes.
    await addE('Story', s1, 'COVERS', 'Requirement', req);
    await addE('Story', s1, 'FOR_PERSONA', 'Persona', persona);
    await addE('Story', s2, 'DEPENDS_ON', 'Story', s1);
    await addE('StoryMapEntry', map, 'IMPLEMENTS', 'Story', s1);
    await addE('StoryMapEntry', map, 'IMPLEMENTS', 'UnitOfWork', 'unit:intent-kg:u-auth');
    await addE('UnitOfWork', 'unit:intent-kg:u-auth', 'EXPOSES', 'Contract', contract);
    await addE('UnitOfWork', 'unit:intent-kg:u-auth', 'CONSUMES_CONTRACT', 'Contract', contract);
    // An edge into a STALE item must never render (endpoint filter).
    const stale = 'story:intent-kg:s-stale';
    await addV('Story', {
      id: stale,
      artifact_id: 'reqs-1',
      slug: 's-stale',
      superseded_at: '2026-01-02T00:00:00Z',
    });
    await addE('Artifact', 'reqs-1', 'HAS_ITEM', 'Story', stale);
    await addE('Story', s2, 'DEPENDS_ON', 'Story', stale);

    const { edges } = await fetchKnowledgeGraph(g, { projectId: PROJECT, intentId: INTENT });
    expect(edge(edges, s1, req, 'COVERS')).toBeDefined();
    expect(edge(edges, s1, persona, 'FOR_PERSONA')).toBeDefined();
    expect(edge(edges, s2, s1, 'DEPENDS_ON')).toBeDefined();
    expect(edge(edges, map, s1, 'IMPLEMENTS')).toBeDefined();
    expect(edge(edges, map, 'unit:intent-kg:u-auth', 'IMPLEMENTS')).toBeDefined();
    expect(edge(edges, 'unit:intent-kg:u-auth', contract, 'EXPOSES')).toBeDefined();
    expect(edge(edges, 'unit:intent-kg:u-auth', contract, 'CONSUMES_CONTRACT')).toBeDefined();
    expect(edges.some((e) => e.target === stale)).toBe(false);
  });
});

describe('fetchKnowledgeGraph — pull requests', () => {
  it('renders PullRequest node(s) anchored Intent --HAS_PR-->, one per repo', async () => {
    await seedFullGraph();
    await addV('PullRequest', {
      id: 'pr:intent-kg:owner/api',
      repository: 'owner/api',
      pr_url: 'https://github.com/owner/api/pull/3',
      pr_number: '3',
      branch: 'aidlc/intent-kg',
      base_branch: 'main',
    });
    await addV('PullRequest', {
      id: 'pr:intent-kg:owner/web',
      repository: 'owner/web',
      pr_url: 'https://github.com/owner/web/pull/4',
      pr_number: '4',
      branch: 'aidlc/intent-kg',
      base_branch: 'develop',
    });
    await addE('Intent', INTENT, 'HAS_PR', 'PullRequest', 'pr:intent-kg:owner/api');
    await addE('Intent', INTENT, 'HAS_PR', 'PullRequest', 'pr:intent-kg:owner/web');

    const { nodes, edges } = await fetchKnowledgeGraph(g, { projectId: PROJECT, intentId: INTENT });

    expect(byId(nodes, 'pr:intent-kg:owner/api')).toMatchObject({
      type: 'PullRequest',
      label: 'PR #3',
      pr_url: 'https://github.com/owner/api/pull/3',
      pr_number: '3',
      repository: 'owner/api',
      branch: 'aidlc/intent-kg',
      base_branch: 'main',
    });
    expect(byId(nodes, 'pr:intent-kg:owner/web')).toMatchObject({
      type: 'PullRequest',
      base_branch: 'develop',
    });
    expect(edge(edges, INTENT, 'pr:intent-kg:owner/api', 'HAS_PR')).toBeDefined();
    expect(edge(edges, INTENT, 'pr:intent-kg:owner/web', 'HAS_PR')).toBeDefined();
  });

  it('renders unit PRs separately with their section, unit, repository, and provider identity', async () => {
    await seedFullGraph();
    const id = 'unit-pr:intent-kg:s2:auth:owner/api:github:7';
    await addV('UnitPullRequest', {
      id,
      section_index: '2',
      unit_slug: 'auth',
      repository: 'owner/api',
      provider: 'github',
      pr_url: 'https://github.com/owner/api/pull/7',
      pr_number: '7',
      source_branch: 'aidlc/intent-kg--s2-unit-auth',
      target_branch: 'aidlc/intent-kg',
      state: 'DRAFT',
    });
    await addE('Intent', INTENT, 'HAS_UNIT_PR', 'UnitPullRequest', id);

    const { nodes, edges } = await fetchKnowledgeGraph(g, {
      projectId: PROJECT,
      intentId: INTENT,
    });
    expect(byId(nodes, id)).toMatchObject({
      type: 'UnitPullRequest',
      label: 'auth #7',
      section_index: '2',
      unit_slug: 'auth',
      repository: 'owner/api',
      provider: 'github',
      state: 'DRAFT',
    });
    expect(edge(edges, INTENT, id, 'HAS_UNIT_PR')).toBeDefined();
  });
});
