// inspect command — proves the read-only Neptune verification path works against
// a real gremlin testcontainer: seed an Intent + Artifact via the graph-writer,
// then call inspect (with openGraph handing it the same traversal) and assert it
// reads the artifact back with provenance. This is the unit-level analogue of the
// Phase B `phaseb.sh inspect` step that reads PRIVATE Neptune through the runtime.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createGraphWriter } from '../mcp/graph-writer.js';
import { inspect } from '../commands/inspect.js';

const PARTITION = 'agentcore-inspect';
const SCOPE = {
  projectId: 'proj-1',
  intentId: 'intent-1',
  executionId: 'exec-1',
  stageInstanceId: 'si-req',
};

let conn;
let g;

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

const openGraph = async () => g;

describe('inspect command', () => {
  it('returns ok:false when intentId is missing', async () => {
    const res = await inspect({}, { openGraph });
    expect(res).toMatchObject({ ok: false, reason: 'missing_intentId' });
  });

  it('reads back an artifact written via the graph-writer, with provenance', async () => {
    // Seed the Intent anchor + one artifact the way init-ws + create_artifact do.
    await g
      .addV('Intent')
      .property('id', SCOPE.intentId)
      .property('project_id', SCOPE.projectId)
      .next();
    const writer = createGraphWriter({ g, scope: SCOPE, clock: () => '2026-01-01T00:00:00.000Z' });
    await writer.createArtifact({
      artifactType: 'requirements-analysis',
      id: 'ra-1',
      title: 'Requirements',
      content: '## Functional\n- login',
    });

    const res = await inspect(
      { intentId: SCOPE.intentId, artifactType: 'requirements-analysis', artifactId: 'ra-1' },
      { openGraph },
    );

    expect(res.ok).toBe(true);
    expect(res.artifactCount).toBe(1);
    expect(res.artifacts[0]).toMatchObject({
      id: 'ra-1',
      artifact_type: 'requirements-analysis',
      created_by_execution_id: SCOPE.executionId,
      created_by_stage_instance_id: SCOPE.stageInstanceId,
    });
    expect(res.artifacts[0].contentBytes).toBeGreaterThan(0);
    expect(res.ofType.map((a) => a.id)).toContain('ra-1');
    expect(res.artifact).toMatchObject({ id: 'ra-1', content: '## Functional\n- login' });
  });

  it('reports an empty intent cleanly (no artifacts yet)', async () => {
    await g.addV('Intent').property('id', 'empty-intent').property('project_id', 'p').next();
    const res = await inspect({ intentId: 'empty-intent' }, { openGraph });
    expect(res).toMatchObject({ ok: true, artifactCount: 0 });
    expect(res.artifacts).toEqual([]);
  });

  it('drop:true scoped-deletes ONLY the named intent subgraph, leaving others intact', async () => {
    // Two intents, each with an artifact.
    await g
      .addV('Intent')
      .property('id', SCOPE.intentId)
      .property('project_id', SCOPE.projectId)
      .next();
    await g.addV('Intent').property('id', 'other-intent').property('project_id', 'p2').next();
    const w1 = createGraphWriter({ g, scope: SCOPE, clock: () => '2026-01-01T00:00:00.000Z' });
    await w1.createArtifact({ artifactType: 'requirements-analysis', id: 'ra-1', content: 'x' });
    const w2 = createGraphWriter({
      g,
      scope: { ...SCOPE, intentId: 'other-intent' },
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    await w2.createArtifact({ artifactType: 'requirements-analysis', id: 'ra-2', content: 'y' });

    const res = await inspect({ intentId: SCOPE.intentId, drop: true }, { openGraph });
    expect(res).toMatchObject({ ok: true, dropped: true, containedDropped: 1 });

    // Named intent gone; the other intent + its artifact survive.
    expect(await inspect({ intentId: SCOPE.intentId }, { openGraph })).toMatchObject({
      ok: true,
      artifactCount: 0,
    });
    expect(await inspect({ intentId: 'other-intent' }, { openGraph })).toMatchObject({
      ok: true,
      artifactCount: 1,
    });
    // The Intent anchor vertex itself is removed too.
    const anchor = await g.V().has('Intent', 'id', SCOPE.intentId).count().next();
    expect(anchor.value).toBe(0);
  });
});
