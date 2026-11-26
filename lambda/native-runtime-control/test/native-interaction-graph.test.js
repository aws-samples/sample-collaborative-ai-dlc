import { describe, expect, it, vi } from 'vitest';
import {
  nativePublicationGraph,
  projectNativePublication,
  readNativePublicationInteraction,
} from '../publication-graph.js';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { memoryGraph } from './native-graph-fixture.js';

const setup = async (options = {}) => {
  const f = serialFixture();
  await f.ready();
  await f.publish({ project: false, ...options });
  const graph = memoryGraph();
  const interactionHooks = {};
  const interactions = {
    read: async (...args) => {
      const body = await f.interactions.read(...args);
      await interactionHooks.afterRead?.();
      return body;
    },
  };
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications: f.publications,
    interactions,
    enqueue: f.enqueue,
    configure: f.configure,
    authorizeSource: f.recheck,
  });
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    publications: f.publications,
    interactions,
    now: f.now,
    authorize: f.recheck,
    project: vi.fn((input) => projectNativePublication({ ...input, g: graph.g })),
    invoke: vi.fn(),
    upgrade: vi.fn(),
    credentials: vi.fn(),
    stop: vi.fn(),
    fence: { cancel: vi.fn(), ensureActive: vi.fn() },
  };
  const run = createNativeExecutionSupervisor(ports);
  const nextTurn = async () => {
    await f.respond();
    const { row } = await f.store.claim(f.bindingIdentity);
    const running = await f.store.dispatched({ row });
    await f.store.release({ row: running });
    return f.publish({ project: false });
  };
  return { ...f, api, graph, ports, run, nextTurn, interactionHooks };
};
const responseNode = (graph) => graph.nodes.find((node) => node.type === 'NativeInteraction');

describe('verified native interaction graph integration', () => {
  it('connects the actual supervisor, immutable codecs, protected store, member API and graph projector', async () => {
    const f = await setup();
    await f.run(f.identity);
    const graph = await f.api.graph(f.prepared, f.recheck);
    const node = responseNode(graph);
    expect(node).toEqual({
      id: expect.stringMatching(/^native-interaction-[a-f0-9]{64}$/),
      type: 'NativeInteraction',
      label: 'AI-DLC response',
      interactionId: f.row().interaction.id,
      publicationId: f.row().publication.id,
    });
    expect(graph.edges).toContainEqual({
      source: graph.nodes[0].id,
      target: node.id,
      label: 'CONTAINS',
    });
    expect(f.graph.vertices.get(node.id)).toMatchObject({
      label: 'NativeInteraction',
      properties: {
        interaction_id: node.interactionId,
        publication_id: node.publicationId,
        project_id: f.prepared.projectId,
        native_execution_id: f.prepared.executionId,
        title: 'AI-DLC response',
      },
    });
    expect(f.row().projectionStatus).toBe('complete');
    expect(f.ports.invoke).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
    expect(JSON.stringify([graph, [...f.graph.vertices.values()]])).not.toMatch(
      /Question 1:|messages|approved|approval|contentSha256/,
    );
    expect(await f.api.graph(f.prepared, f.recheck)).toEqual(graph);
  });

  it('disconnects the superseded response and keeps old immutable history and foreign graph scope', async () => {
    const f = await setup();
    await f.run(f.identity);
    const firstRow = structuredClone(f.row());
    const first = responseNode(await f.api.graph(f.prepared, f.recheck));
    f.graph.vertices.set('foreign-response', {
      label: 'NativeInteraction',
      properties: { ...f.graph.vertices.get(first.id).properties, project_id: 'other-project' },
    });
    f.graph.edges.set('foreign-edge', {
      source: [...f.graph.vertices.values()].find((v) => v.label === 'Intent').id,
      target: 'foreign-response',
      label: 'CONTAINS',
    });
    await f.nextTurn();
    await f.run(f.identity);
    const current = responseNode(await f.api.graph(f.prepared, f.recheck));
    expect(current.id).not.toBe(first.id);
    expect([...f.graph.edges.values()].some((edge) => edge.target === first.id)).toBe(false);
    expect([...f.graph.edges.values()].some((edge) => edge.target === current.id)).toBe(true);
    expect(f.graph.edges.has('foreign-edge')).toBe(true);
    expect(f.graph.vertices.has(first.id)).toBe(true);
    expect(
      await f.interactions.read(
        {
          ...executionIdentity(firstRow),
          epoch: firstRow.interactionEpoch,
        },
        firstRow.interaction,
      ),
    ).toMatchObject({ sequence: 1, publicationId: first.publicationId });
    const before = [...f.graph.edges];
    await f.ports.project(f.ports.project.mock.calls.at(-1)[0]);
    expect([...f.graph.edges]).toEqual(before);
  });

  it('reads the historical committed interaction epoch after cancellation', async () => {
    const f = await setup();
    const before = await f.api.graph(f.prepared, f.recheck);
    await f.store.cancel(f.bindingIdentity);
    expect(f.row().epoch).toBe(2);
    expect(await f.api.graph(f.prepared, f.recheck)).toEqual(before);
    expect(
      f.reads
        .filter((r) => r.Key.includes('/interactions/'))
        .every((r) => r.Key.includes(`/${f.row().attemptId}/1/`)),
    ).toBe(true);
  });

  it.each(['cancel', 'new publication'])(
    'rejects a member graph read raced by %s',
    async (change) => {
      const f = await setup();
      await f.run(f.identity);
      f.interactionHooks.afterRead = async () => {
        delete f.interactionHooks.afterRead;
        if (change === 'cancel') await f.store.cancel(f.bindingIdentity);
        else await f.nextTurn();
      };
      await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_CONFLICT',
      });
    },
  );

  it('keeps the current committed response visible when its reply is accepted during the read', async () => {
    const f = await setup();
    await f.run(f.identity);
    const before = await f.api.graph(f.prepared, f.recheck);
    f.interactionHooks.afterRead = async () => {
      await f.respond();
    };
    expect(await f.api.graph(f.prepared, f.recheck)).toEqual(before);
    expect(f.row().turnSequence).toBe(2);
    expect(f.row().publication.sequence).toBe(1);
  });

  it('does not project after losing the protected lease during immutable interaction loading', async () => {
    const f = await setup();
    f.interactionHooks.afterRead = async () => {
      await f.store.cancel(f.bindingIdentity);
    };
    await expect(f.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_LEASE_LOST' });
    expect(f.graph.writes).toEqual([]);
    expect(f.ports.project).not.toHaveBeenCalled();
  });

  it('rechecks project membership after loading the immutable interaction', async () => {
    const f = await setup();
    f.interactionHooks.afterRead = () => {
      f.authorization.member = false;
    };
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
  });

  it('rejects valid immutable bytes from a different configured harness in API and worker', async () => {
    const f = await setup({ harness: 'claude' });
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    await f.run(f.identity);
    expect(f.ports.project).not.toHaveBeenCalled();
    expect(f.graph.writes).toEqual([]);
    expect(f.row()).toMatchObject({
      status: 'FAILED',
      failureCode: 'native_execution_publication_invalid',
    });
  });

  it('rejects modified immutable interaction bytes before any graph write', async () => {
    const f = await setup();
    const object = f.row().interaction.object;
    const key = `${object.key}\0${object.versionId}`;
    f.objects.set(key, Buffer.from('{"messages":[{"type":"text","text":"forged"}]}'));
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    await f.run(f.identity);
    expect(f.graph.writes).toEqual([]);
    expect(f.ports.project).not.toHaveBeenCalled();
  });

  it.each([
    [
      'binding',
      (r) => {
        r.bindingId = '00000000-0000-4000-8000-000000000001';
      },
    ],
    [
      'publication',
      (r) => {
        r.publication.id = '0'.repeat(64);
      },
    ],
    [
      'sequence',
      (r) => {
        r.publication.sequence += 1;
      },
    ],
    [
      'session',
      (r) => {
        r.publication.nativeSessionId = 'other-session';
      },
    ],
    [
      'package',
      (r) => {
        r.configuration.packageId = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'harness',
      (r) => {
        r.configuration.harness = 'claude';
      },
    ],
    [
      'content hash',
      (r) => {
        r.interactionContentSha256 = '0'.repeat(64);
      },
    ],
    [
      'interaction epoch',
      (r) => {
        r.interactionEpoch += 1;
      },
    ],
  ])('refuses an interaction that differs from the committed %s', async (_name, mutate) => {
    const f = await setup();
    const row = structuredClone(f.row());
    const manifest = await f.publications.read(
      {
        ...executionIdentity(row),
        epoch: row.publicationEpoch,
      },
      row.publication,
    );
    mutate(row);
    await expect(
      readNativePublicationInteraction({
        draft: f.prepared,
        row,
        manifest,
        interactions: f.interactions,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
  });

  it('refuses an unverified response descriptor even when its IDs match', async () => {
    const f = await setup();
    const row = f.row();
    const manifest = await f.publications.read(executionIdentity(row), row.publication);
    expect(() =>
      nativePublicationGraph({
        draft: f.prepared,
        publication: row.publication,
        manifest,
        interaction: { interactionId: row.interaction.id, publicationId: row.publication.id },
      }),
    ).toThrow(expect.objectContaining({ code: 'NATIVE_INTERACTION_INVALID' }));
  });

  it.each([
    ['interaction_id', 'wrong-interaction'],
    ['publication_id', 'wrong-publication'],
    ['interaction_id', ['same', 'foreign']],
    ['project_id', 'other-project'],
  ])(
    'guards an existing response vertex with invalid %s before updating properties',
    async (key, value) => {
      const f = await setup();
      const apiGraph = await f.api.graph(f.prepared, f.recheck);
      const node = responseNode(apiGraph);
      const existing = {
        id: node.id,
        label: 'NativeInteraction',
        properties: {
          id: node.id,
          project_id: f.prepared.projectId,
          native_execution_id: f.prepared.executionId,
          intent_id: apiGraph.nodes[0].id,
          execution_backend: 'native',
          interaction_id: node.interactionId,
          publication_id: node.publicationId,
          title: 'preserve owner',
          [key]: value,
        },
      };
      f.graph.vertices.set(node.id, structuredClone(existing));
      await f.run(f.identity);
      expect(f.row().failureCode).toBe('native_execution_publication_invalid');
      expect(f.graph.vertices.get(node.id)).toEqual(existing);
      expect(f.graph.writes.filter((write) => write.id === node.id)).toEqual([]);
      expect(f.graph.edges.size).toBe(0);
    },
  );
});
