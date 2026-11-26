import { createRequire } from 'node:module';
import gremlin from 'gremlin';
import { describe, expect, it, vi } from 'vitest';
import { nativePublicationGraph, projectNativePublication } from '../publication-graph.js';

const require = createRequire(import.meta.url);
const { graphBinaryWriter } = require('gremlin/lib/structure/io/binary/GraphBinary');
const { RemoteConnection, RemoteTraversal } = gremlin.driver;
const { Traverser } = gremlin.process;

const draft = {
  projectId: 'native-graph-compatibility',
  executionId: '20000000-0000-4000-8000-000000000002',
  request: { title: 'Native graph compatibility' },
};
const publication = { id: 'a'.repeat(64), sequence: 2 };
const manifest = {
  question: null,
  files: [
    {
      id: 'nf-compatibility',
      path: 'aidlc/design.md',
      sha256: 'b'.repeat(64),
      role: 'artifact',
    },
  ],
};

// Keep the actual Gremlin traversal, remote strategy and serializers. Only the
// server's replies are substituted; a hand-written traversal DSL would miss
// client-added terminal steps such as Gremlin 3.8's iterate() -> discard.
class RecordingRemote extends RemoteConnection {
  constructor(onDrop = async () => new RemoteTraversal([])) {
    super('ws://127.0.0.1:0/gremlin');
    this.onDrop = onDrop;
    this.requests = [];
  }

  async submit(bytecode) {
    const request = {
      requestId: '30000000-0000-4000-8000-000000000003',
      op: 'bytecode',
      processor: 'traversal',
      args: { gremlin: bytecode, aliases: { g: 'g' } },
    };
    const graphson = new gremlin.structure.io.GraphSON3Writer().writeRequest(request);
    const binary = graphBinaryWriter.writeRequest(request);
    const wire = JSON.parse(graphson.toString('utf8'));
    this.requests.push({ wire, graphson, binary });
    if (bytecode.stepInstructions.some(([step]) => step === 'drop')) return this.onDrop();
    const vertexId =
      bytecode.stepInstructions.at(-1)[0] === 'id' ? bytecode.stepInstructions[0][1] : null;
    return new RemoteTraversal(vertexId === null ? [] : [new Traverser(vertexId, 1)]);
  }
}

const apply = (remote, overrides = {}) =>
  projectNativePublication({
    g: gremlin.process.traversal().withRemote(remote),
    draft,
    publication,
    manifest,
    authorize: vi.fn(async () => {}),
    ...overrides,
  });
const wireSteps = (request) => request.wire.args.gremlin['@value'].step;
const cleanupRequests = (remote) =>
  remote.requests.filter((request) => wireSteps(request).some(([step]) => step === 'drop'));

describe('native graph Gremlin remote compatibility', () => {
  it('does not submit stale-edge cleanup for the first publication', async () => {
    const remote = new RecordingRemote();
    await apply(remote, { publication: { ...publication, sequence: 1 } });
    expect(remote.requests.length).toBeGreaterThan(0);
    expect(cleanupRequests(remote)).toEqual([]);
  });

  it('submits the real sequence-two cleanup with drop as its final wire step', async () => {
    const remote = new RecordingRemote();
    const graph = await apply(remote);
    expect(graph).toEqual(nativePublicationGraph({ draft, publication, manifest }));
    expect(cleanupRequests(remote)).toHaveLength(1);
    const [cleanup] = cleanupRequests(remote);
    const steps = wireSteps(cleanup);
    expect(steps.at(-1)).toEqual(['drop']);
    expect(steps.slice(-3).map(([step]) => step)).toEqual(['outE', 'filter', 'drop']);
    expect(steps.find(([step]) => step === 'outE')).toEqual(['outE', 'CONTAINS']);
    expect(steps.map(([step]) => step)).not.toContain('discard');
    // GraphBinary is the production driver's default. It must carry the same
    // drop without a hidden terminal operation, just like GraphSON.
    expect(cleanup.binary.includes(Buffer.from('drop'))).toBe(true);
    expect(cleanup.binary.includes(Buffer.from('discard'))).toBe(false);
    for (const request of remote.requests) {
      expect(request.wire.op).toBe('bytecode');
      expect(request.wire.processor).toBe('traversal');
      expect(request.wire.args.aliases).toEqual({ g: 'g' });
      expect(request.graphson.byteLength).toBeGreaterThan(0);
      expect(request.binary.byteLength).toBeGreaterThan(0);
    }
  });

  it('waits for the empty drop response before completing and reauthorizing', async () => {
    const entered = Promise.withResolvers();
    const response = Promise.withResolvers();
    const remote = new RecordingRemote(() => {
      entered.resolve();
      return response.promise;
    });
    const authorize = vi.fn(async () => {});
    let completed = false;
    const pending = apply(remote, { authorize }).then((graph) => {
      completed = true;
      return graph;
    });
    await entered.promise;
    const callsBeforeResponse = authorize.mock.calls.length;
    expect(completed).toBe(false);
    response.resolve(new RemoteTraversal([]));
    await pending;
    expect(completed).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(callsBeforeResponse + 1);
    expect(cleanupRequests(remote)).toHaveLength(1);
  });

  it('propagates remote cleanup failure instead of reporting a projected revision', async () => {
    const error = new Error('Remote cleanup failed');
    const authorize = vi.fn(async () => {});
    let callsBeforeFailure;
    const remote = new RecordingRemote(async () => {
      callsBeforeFailure = authorize.mock.calls.length;
      throw error;
    });
    await expect(apply(remote, { authorize })).rejects.toBe(error);
    expect(authorize).toHaveBeenCalledTimes(callsBeforeFailure);
    expect(cleanupRequests(remote)).toHaveLength(1);
  });
});
