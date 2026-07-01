import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createGraphWriter, GraphWriteError } from '../mcp/graph-writer.js';

const PARTITION = 'agentcore-graph-writer';

const SCOPE = {
  projectId: 'proj-1',
  intentId: 'intent-1',
  executionId: 'exec-1',
  stageInstanceId: 'si-req',
};

let conn;
let g;
let writer;

// Seed the Intent anchor the writer hangs artifacts off (init-ws creates it in
// production; the writer requires it to exist).
const seedIntent = (id = SCOPE.intentId) =>
  g.addV('Intent').property('id', id).property('project_id', SCOPE.projectId).next();

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
  let t = 0;
  writer = createGraphWriter({ g, scope: SCOPE, clock: () => `2026-01-01T00:00:0${t++}.000Z` });
});

describe('createGraphWriter — guards', () => {
  it('requires an intentId in scope', () => {
    expect(() => createGraphWriter({ g, scope: {} })).toThrow(/intentId/);
  });
});

describe('createArtifact', () => {
  it('fails when the Intent anchor does not exist', async () => {
    await expect(
      writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a1' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('creates an Artifact typed by name, stamped with provenance, anchored to the Intent', async () => {
    await seedIntent();
    const created = await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'a1',
      title: 'Requirements',
      content: '# reqs',
      props: { status: 'draft' },
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'a1',
      artifactType: 'requirements-analysis',
      created_at: expect.any(String),
      links: 0,
    });
    expect(created.content).toBeUndefined();

    const fetched = await writer.getArtifact({ id: 'a1' });
    expect(fetched).toMatchObject({
      id: 'a1',
      artifact_type: 'requirements-analysis',
      title: 'Requirements',
      status: 'draft',
      project_id: 'proj-1',
      created_by_stage_instance_id: 'si-req',
    });

    // Anchored Intent --CONTAINS--> Artifact.
    const anchored = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('CONTAINS')
      .has('Artifact', 'id', 'a1')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('drops caller-supplied reserved/provenance props (spoof-proof)', async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'design',
      id: 'a2',
      props: { project_id: 'EVIL', created_by_execution_id: 'EVIL', legit: 'ok' },
    });
    const fetched = await writer.getArtifact({ id: 'a2' });
    expect(fetched.project_id).toBe('proj-1');
    expect(fetched.created_by_execution_id).toBe('exec-1');
    expect(fetched.legit).toBe('ok');
  });

  it('is idempotent on re-create (upsert by id), not duplicated', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'design', id: 'a3', title: 'v1' });
    await writer.createArtifact({ artifactType: 'design', id: 'a3', title: 'v2' });
    const count = await g.V().has('Artifact', 'id', 'a3').count().next();
    expect(count.value).toBe(1);
    expect((await writer.getArtifact({ id: 'a3' })).title).toBe('v2');
    const edges = await g.V().has('Intent', 'id', 'intent-1').outE('CONTAINS').count().next();
    expect(edges.value).toBe(1);
  });

  it('wires links to existing artifacts in the same call', async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'req' });
    await writer.createArtifact({
      artifactType: 'user-stories',
      id: 'us',
      links: [{ toId: 'req', edge: 'DERIVED_FROM' }],
    });
    const neighbors = await writer.getNeighbors({
      id: 'us',
      edge: 'DERIVED_FROM',
      direction: 'out',
    });
    expect(neighbors.map((n) => n.id)).toEqual(['req']);
  });
});

describe('linkArtifacts', () => {
  beforeEach(async () => {
    await seedIntent();
    await writer.createArtifact({ artifactType: 'a', id: 'x' });
    await writer.createArtifact({ artifactType: 'b', id: 'y' });
  });

  it('rejects a non-allowlisted edge', async () => {
    await expect(
      writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'HACKS' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('creates an allowlisted edge and is idempotent', async () => {
    await writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'PRODUCES' });
    await writer.linkArtifacts({ fromId: 'x', toId: 'y', edge: 'PRODUCES' });
    const count = await g.V().has('Artifact', 'id', 'x').outE('PRODUCES').count().next();
    expect(count.value).toBe(1);
  });

  it('rejects a link to a missing artifact', async () => {
    await expect(
      writer.linkArtifacts({ fromId: 'x', toId: 'ghost', edge: 'PRODUCES' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await seedIntent();
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'r1',
      title: 'Auth requirements',
      content: 'login',
    });
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'r2',
      title: 'Billing',
    });
    await writer.createArtifact({ artifactType: 'design', id: 'd1', title: 'Auth design' });
  });

  it('lookupArtifacts filters by type within the intent', async () => {
    const reqs = await writer.lookupArtifacts({ artifactType: 'requirements-analysis' });
    expect(reqs.map((a) => a.id).toSorted()).toEqual(['r1', 'r2']);
  });

  it('getIntentGraph returns every contained artifact', async () => {
    const all = await writer.getIntentGraph();
    expect(all.map((a) => a.id).toSorted()).toEqual(['d1', 'r1', 'r2']);
  });

  it('searchGraph matches title/content substrings, optionally by type', async () => {
    const hits = await writer.searchGraph({ query: 'auth' });
    expect(hits.map((a) => a.id).toSorted()).toEqual(['d1', 'r1']);
    const typed = await writer.searchGraph({ query: 'auth', artifactType: 'design' });
    expect(typed.map((a) => a.id)).toEqual(['d1']);
  });

  it('updateArtifact patches props and errors on a missing artifact', async () => {
    await writer.updateArtifact({ id: 'r1', props: { status: 'final' } });
    expect((await writer.getArtifact({ id: 'r1' })).status).toBe('final');
    await expect(writer.updateArtifact({ id: 'nope', props: {} })).rejects.toBeInstanceOf(
      GraphWriteError,
    );
  });
});

describe('team knowledge (project-scoped, cross-intent)', () => {
  it('records a TeamKnowledge vertex anchored to the Project, stamped with provenance', async () => {
    const created = await writer.recordTeamKnowledge({
      id: 'naming-conv',
      title: 'Naming convention',
      content: 'kebab-case ids',
      agentRef: 'aidlc-product-agent',
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'naming-conv',
      agentRef: 'aidlc-product-agent',
      created_at: expect.any(String),
    });
    expect(created.content).toBeUndefined();
    // The full provenance is persisted (read it back to verify).
    const persisted = (await writer.getTeamKnowledge()).find((r) => r.id === 'naming-conv');
    expect(persisted).toMatchObject({
      tier: 'team',
      agent_ref: 'aidlc-product-agent',
      project_id: 'proj-1',
      created_by_intent_id: 'intent-1',
      created_by_stage_instance_id: 'si-req',
    });
    // Anchored Project --HAS_KNOWLEDGE--> TeamKnowledge.
    const anchored = await g
      .V()
      .has('Project', 'id', 'proj-1')
      .out('HAS_KNOWLEDGE')
      .has('TeamKnowledge', 'id', 'naming-conv')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('upserts by id (a later run updates, not duplicates) and keeps one anchor edge', async () => {
    await writer.recordTeamKnowledge({ id: 'k', content: 'v1' });
    await writer.recordTeamKnowledge({ id: 'k', content: 'v2' });
    const count = await g.V().has('TeamKnowledge', 'id', 'k').count().next();
    expect(count.value).toBe(1);
    const edges = await g.V().has('Project', 'id', 'proj-1').outE('HAS_KNOWLEDGE').count().next();
    expect(edges.value).toBe(1);
    const rows = await writer.getTeamKnowledge();
    expect(rows.find((r) => r.id === 'k').content).toBe('v2');
  });

  it('drops caller-supplied provenance props (spoof-proof)', async () => {
    await writer.recordTeamKnowledge({
      id: 'k2',
      content: 'x',
      props: { project_id: 'EVIL', created_by_intent_id: 'EVIL', legit: 'ok' },
    });
    const persisted = (await writer.getTeamKnowledge()).find((r) => r.id === 'k2');
    expect(persisted.project_id).toBe('proj-1');
    expect(persisted.created_by_intent_id).toBe('intent-1');
    expect(persisted.legit).toBe('ok');
  });

  it('getTeamKnowledge filters to one agent plus the shared corpus', async () => {
    await writer.recordTeamKnowledge({ id: 'shared-1', content: 'a', agentRef: 'shared' });
    await writer.recordTeamKnowledge({
      id: 'prod-1',
      content: 'b',
      agentRef: 'aidlc-product-agent',
    });
    await writer.recordTeamKnowledge({ id: 'arch-1', content: 'c', agentRef: 'aidlc-arch-agent' });
    const forProduct = await writer.getTeamKnowledge({ agentRef: 'aidlc-product-agent' });
    expect(forProduct.map((r) => r.id).toSorted()).toEqual(['prod-1', 'shared-1']);
  });

  it('returns [] when the Project has no knowledge yet', async () => {
    expect(await writer.getTeamKnowledge()).toEqual([]);
  });
});

describe('learning rules (project-scoped guardrails)', () => {
  it('records a LearningRule vertex anchored to the Project, stamped + layered', async () => {
    const created = await writer.recordLearningRule({
      id: 'no-secrets',
      title: 'No plaintext secrets',
      content: 'NEVER store secrets in plaintext config',
      layer: 'project-learnings',
    });
    // Compact ack only — never echoes `content` back into the model turn.
    expect(created).toEqual({
      id: 'no-secrets',
      layer: 'project-learnings',
      created_at: expect.any(String),
    });
    expect(created.content).toBeUndefined();
    const persisted = (await writer.getLearningRules()).find((r) => r.id === 'no-secrets');
    expect(persisted).toMatchObject({
      pairing: 'feedforward-only',
      project_id: 'proj-1',
      created_by_intent_id: 'intent-1',
    });
    const anchored = await g
      .V()
      .has('Project', 'id', 'proj-1')
      .out('HAS_LEARNING')
      .has('LearningRule', 'id', 'no-secrets')
      .hasNext();
    expect(anchored).toBe(true);
  });

  it('rejects a layer outside the two learnings tiers', async () => {
    await expect(
      writer.recordLearningRule({ id: 'x', content: 'c', layer: 'org' }),
    ).rejects.toBeInstanceOf(GraphWriteError);
  });

  it('upserts by id and keeps one anchor edge', async () => {
    await writer.recordLearningRule({ id: 'r', content: 'v1', layer: 'team-learnings' });
    await writer.recordLearningRule({ id: 'r', content: 'v2', layer: 'project-learnings' });
    const count = await g.V().has('LearningRule', 'id', 'r').count().next();
    expect(count.value).toBe(1);
    const edges = await g.V().has('Project', 'id', 'proj-1').outE('HAS_LEARNING').count().next();
    expect(edges.value).toBe(1);
    const rows = await writer.getLearningRules();
    const r = rows.find((x) => x.id === 'r');
    expect(r.content).toBe('v2');
    expect(r.layer).toBe('project-learnings');
  });

  it('getLearningRules returns [] when the Project has none', async () => {
    expect(await writer.getLearningRules()).toEqual([]);
  });
});

describe('recordQuestion', () => {
  it('creates a Question vertex anchored to the Intent', async () => {
    await seedIntent();
    await writer.recordQuestion({ questionId: 'q1', questionsJson: '[{"text":"?"}]' });
    const anchored = await g
      .V()
      .has('Intent', 'id', 'intent-1')
      .out('CONTAINS')
      .has('Question', 'id', 'q1')
      .hasNext();
    expect(anchored).toBe(true);
    const question = await g.V().has('Question', 'id', 'q1').valueMap().next();
    expect(question.value.get('stage_instance_id')[0]).toBe('si-req');
  });

  it('links answered same-stage questions to created and updated artifacts', async () => {
    await seedIntent();
    await writer.recordQuestion({ questionId: 'q1', questionsJson: '[{"text":"?"}]' });
    await g.V().has('Question', 'id', 'q1').property('answered_at', '2026-01-01T00:00:00Z').next();

    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a1' });
    expect(
      await g.V().has('Question', 'id', 'q1').out('INFLUENCES').has('id', 'a1').hasNext(),
    ).toBe(true);

    await writer.createArtifact({ artifactType: 'requirements-analysis', id: 'a2' });
    await writer.updateArtifact({ id: 'a2', props: { status: 'revised' } });
    expect(
      await g.V().has('Question', 'id', 'q1').out('INFLUENCES').has('id', 'a2').hasNext(),
    ).toBe(true);
  });
});
