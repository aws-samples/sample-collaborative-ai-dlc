import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { GenericContainer, Wait } from 'testcontainers';
import { nativeTraceFixture, traceFiles } from './native-trace-fixture.js';
import { nativePublicationGraph, projectNativePublication } from '../publication-graph.js';
import { readNativePublicationTrace } from '../publication-trace.js';
import { nativeProjectionStatus } from '../projection-store.js';
import { TABLE } from './fixtures.js';

let conn;
let g;
let container;
beforeAll(async () => {
  // The general root harness uses LONG vertex IDs. Native deliberately uses
  // Neptune string IDs, so exercise the same bytecode on a dedicated graph.
  container = await new GenericContainer('tinkerpop/gremlin-server:3.7.3')
    .withCopyContentToContainer([
      {
        target: '/opt/gremlin-server/conf/tinkergraph-empty.properties',
        content:
          'gremlin.graph=org.apache.tinkerpop.gremlin.tinkergraph.structure.TinkerGraph\n' +
          'gremlin.tinkergraph.vertexIdManager=ANY\n' +
          'gremlin.tinkergraph.edgeIdManager=ANY\n',
      },
    ])
    .withExposedPorts(8182)
    .withWaitStrategy(Wait.forLogMessage(/Channel started at port 8182/))
    .start();
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${container.getHost()}:${container.getMappedPort(8182)}/gremlin`,
  );
  g = gremlin.process
    .traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: 'native-trace',
        readPartitions: ['native-trace'],
      }),
    );
}, 60000);
beforeEach(async () => {
  await g.V().drop().toList();
});
afterAll(async () => {
  await conn?.close();
  await container?.stop();
});
const count = async (query) => (await query.count().next()).value;

describe('native trace against real Gremlin', () => {
  it('retries partial writes and lost acknowledgements without duplicates', async () => {
    const f = await nativeTraceFixture(g);
    let checks = 0;
    const original = f.recheck.getMockImplementation();
    f.recheck.mockImplementation(async () => {
      await original();
      if (++checks === 14) throw new Error('Lost worker');
    });
    await expect(f.run(f.identity)).rejects.toThrow('Lost worker');
    expect(await count(g.V())).toBeGreaterThan(0);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
    f.recheck.mockImplementation(original);
    await f.run(f.identity);
    const graph = nativePublicationGraph(f.inputs.at(-1));
    await projectNativePublication({ ...f.inputs.at(-1), g });
    expect(await count(g.V())).toBe(graph.nodes.length);
    expect(await count(g.E())).toBe(graph.edges.length);
    const requirement = graph.nodes.find((node) => node.type === 'Requirement');
    expect(
      JSON.parse((await g.V(requirement.id).values('native_provenance').next()).value),
    ).toEqual(requirement.provenance);
  });

  it('disconnects superseded and deleted content without crossing revisions with identical bytes', async () => {
    const f = await nativeTraceFixture(g);
    await f.run(f.identity);
    const first = nativePublicationGraph(f.inputs[0]);
    const firstInput = f.inputs[0];
    await f.next(traceFiles().slice(0, 2));
    await f.run(f.identity);
    const second = nativePublicationGraph(f.inputs[1]);
    const oldItem = first.nodes.find((node) => node.type === 'Requirement');
    const newItem = second.nodes.find((node) => node.type === 'Requirement');
    expect(oldItem.sha256).toBe(newItem.sha256);
    expect(oldItem.id).not.toBe(newItem.id);
    expect(await g.V(newItem.artifactId).out('HAS_ITEM').id().toList()).toEqual([newItem.id]);
    expect(await g.V(second.nodes[0].id).out('CONTAINS').id().toList()).not.toContain(oldItem.id);
    expect(await count(g.V(oldItem.id))).toBe(1);
    expect(await g.V(oldItem.id).in_('COVERS').values('publication_id').toList()).toEqual([
      first.publicationId,
    ]);
    expect(await g.V(newItem.id).in_('COVERS').values('publication_id').toList()).toEqual([
      second.publicationId,
    ]);
    await expect(projectNativePublication({ ...firstInput, g })).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
    expect(await g.V(newItem.artifactId).out('HAS_ITEM').id().toList()).toEqual([newItem.id]);
    const historical = await f.publications.file(
      firstInput.manifest.scope,
      firstInput.manifest,
      oldItem.artifactId,
    );
    expect(historical.file.sha256).toBe(oldItem.sha256);
    const plain = traceFiles();
    plain[0].content = Buffer.from('Plain readable text without structured items.');
    await f.next(plain);
    await f.run(f.identity);
    expect(await count(g.V(newItem.artifactId).out('HAS_ITEM'))).toBe(0);
    expect(
      nativePublicationGraph(f.inputs.at(-1)).nodes.some((node) => node.type === 'Requirement'),
    ).toBe(false);
  });

  it('fences a stale projector paused before its first edge after a newer publication', async () => {
    const f = await nativeTraceFixture(g);
    await f.run(f.identity);
    const old = f.inputs[0];
    const graph = nativePublicationGraph(old);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let checks = 0;
    const pending = projectNativePublication({
      ...old,
      g,
      authorize: async () => {
        if (++checks === graph.nodes.length + 1) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await entered.promise;
    await f.next(traceFiles());
    await f.run(f.identity);
    const before = await g.E().id().toList();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    expect((await g.E().id().toList()).toSorted()).toEqual(before.toSorted());
  });

  it('rejects foreign derived ownership without repairing it', async () => {
    const f = await nativeTraceFixture(g);
    const graph = await f.api.graph(f.prepared, f.recheck);
    const item = graph.nodes.find((node) => node.type === 'Requirement');
    await g
      .addV('Requirement')
      .property(gremlin.process.t.id, item.id)
      .property('id', item.id)
      .property('project_id', 'other-project')
      .property('title', 'foreign')
      .next();
    await expect(f.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    expect(await g.V(item.id).values('title').toList()).toEqual(['foreign']);
    expect(await count(g.E())).toBe(0);
  });

  it('keeps identical documents in different projects and executions disjoint', async () => {
    const f = await nativeTraceFixture(g);
    await f.run(f.identity);
    const first = nativePublicationGraph(f.inputs[0]);
    for (const change of [
      { projectId: 'other-project' },
      { executionId: '40000000-0000-4000-8000-000000000004' },
    ]) {
      const identity = { ...f.inputs[0].manifest.scope, ...change };
      const publication = await f.publications.write({
        identity,
        sequence: 1,
        packageId: f.configuration.packageId,
        nativeSessionId: 'test',
        outcome: 'STOPPED',
        repository: f.inputs[0].manifest.repository,
        files: traceFiles(),
      });
      const manifest = await f.publications.read(identity, publication, { verifyFiles: true });
      const draft = { ...f.prepared, ...change };
      const trace = await readNativePublicationTrace({
        draft,
        publication,
        manifest,
        publications: f.publications,
        authorize: f.recheck,
      });
      const other = await projectNativePublication({
        draft,
        publication,
        manifest,
        trace,
        g,
        authorize: f.recheck,
      });
      expect(other.nodes.some((node) => first.nodes.some((n) => n.id === node.id))).toBe(false);
      expect(
        await g.V(other.nodes[0].id).out('CONTAINS').values('project_id').dedup().toList(),
      ).toEqual([draft.projectId]);
    }
  });
  it('recovers when Gremlin commits a vertex but its acknowledgement is lost', async () => {
    const f = await nativeTraceFixture(g);
    const submit = conn.submit.bind(conn);
    let lost = false;
    const spy = vi.spyOn(conn, 'submit').mockImplementation(async (bytecode) => {
      const result = await submit(bytecode);
      if (!lost && bytecode.stepInstructions.some(([step]) => step === 'coalesce')) {
        lost = true;
        throw new Error('Lost graph acknowledgement');
      }
      return result;
    });
    try {
      await expect(f.run(f.identity)).rejects.toThrow('Lost graph acknowledgement');
    } finally {
      spy.mockRestore();
    }
    expect(await count(g.V())).toBe(1);
    await f.run(f.identity);
    const graph = nativePublicationGraph(f.inputs.at(-1));
    expect(await count(g.V())).toBe(graph.nodes.length);
    expect(await count(g.E())).toBe(graph.edges.length);
  });
});
