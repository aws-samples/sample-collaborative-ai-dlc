import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createCollaborationServer, validateOwnerAddress } from '../service.js';
import { readConfig } from '../config.js';
import { ClusterCoordinator, ownerFor, scopeKey, routeHeader, verifyRoute } from '../cluster.js';
import { send } from '../protocol.js';
import { connectClient, MemoryStore, DOCUMENT, SECRET, logger } from './helpers.js';
import { runLoad } from '../load.js';
import { signRealtimeToken, requiredScopeForYjsDoc } from '../realtime-token.js';

const servers = [];
const clients = [];
const start = async ({ store, id, clock, config = {} } = {}) => {
  const cluster = store
    ? new ClusterCoordinator({ store, id, clock, logger, heartbeatMs: 1_000_000 })
    : null;
  const service = createCollaborationServer({
    config: { ...readConfig({}), port: 0, shutdownMs: 1000, clusterEnabled: !!store, ...config },
    cluster,
    logger,
    secret: SECRET,
    allowLoopback: true,
    verifyJwt: async (token) => {
      if (token === 'invalid') throw new Error('Invalid JWT');
      return { sub: token };
    },
  });
  servers.push(service);
  await service.listen();
  return service;
};
const join = async (...args) => {
  const client = await connectClient(...args);
  clients.push(client);
  return client;
};
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map((service) => service.close()));
});

describe('collaboration transport', () => {
  it('runs an authenticated load workload and verifies all writer sequences converge', async () => {
    const server = await start();
    const token = signRealtimeToken(
      { sub: 'load', scopes: [requiredScopeForYjsDoc(DOCUMENT)] },
      SECRET,
    ).token;
    const result = await runLoad({
      url: `http://127.0.0.1:${server.server.address().port}`,
      jwt: 'load',
      token: async () => token,
      intentId: DOCUMENT.slice('intent-draft-'.length),
      clients: 12,
      documents: 3,
      durationSeconds: 1,
      updateMs: 100,
      rampMs: 1,
      initialBytes: 1024,
    });
    expect(result.converged).toBe(true);
    expect(result.writes).toBeGreaterThan(50);
    expect(result.propagationSamples).toBeGreaterThan(50);
    expect(result.reconnects).toBe(0);
  });
  it('sends a large initial state once and keeps peers converged', async () => {
    const server = await start();
    const first = await join(server);
    first.doc.getText('content').insert(0, 'x'.repeat(1024 * 1024));
    await expect
      .poll(() => server.rooms.rooms.get(DOCUMENT)?.doc.getText('content').length)
      .toBe(1024 * 1024);
    const second = await join(server, DOCUMENT, { user: 'bob' });
    expect(second.doc.getText('content').length).toBe(1024 * 1024);
    expect(second.frames.filter((frame) => frame.type === 0 && frame.subtype === 1)).toHaveLength(
      1,
    );
    first.doc.getText('content').insert(0, 'a');
    second.doc.getText('content').insert(0, 'b');
    await expect
      .poll(
        () => second.doc.getText('content').toString() === first.doc.getText('content').toString(),
      )
      .toBe(true);
    await expect.poll(() => first.doc.getText('content').length).toBe(1024 * 1024 + 2);
  });

  it('ignores legacy presence echoes and preserves another user on disconnect', async () => {
    const server = await start();
    const alice = await join(server);
    const bob = await join(server, DOCUMENT, { user: 'bob' });
    const room = server.rooms.rooms.get(DOCUMENT);
    await expect.poll(() => room.awareness.getStates().has(alice.doc.clientID)).toBe(true);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(alice.awareness, [alice.doc.clientID]),
    );
    bob.ws.send(encoding.toUint8Array(encoder));
    bob.close();
    await expect.poll(() => room.connections.size).toBe(1);
    expect(room.awareness.getStates().has(alice.doc.clientID)).toBe(true);
    const before = room.awareness.meta.get(alice.doc.clientID).clock;
    alice.awareness.setLocalState(alice.awareness.getLocalState());
    await expect
      .poll(() => room.awareness.meta.get(alice.doc.clientID).clock)
      .toBeGreaterThan(before);
    expect(room.awareness.getLocalState()).toBeNull();
  });

  it('isolates bad input and remains healthy', async () => {
    const server = await start();
    const bad = await join(server);
    const closed = new Promise((resolve) => bad.ws.once('close', resolve));
    bad.ws.send('not a binary collaboration message');
    expect(await closed).toBe(1003);
    const healthy = await join(server, DOCUMENT, { user: 'bob' });
    healthy.doc.getText('content').insert(0, 'healthy');
    await expect
      .poll(() => server.rooms.rooms.get(DOCUMENT).doc.getText('content').toString())
      .toBe('healthy');
  });

  it('rejects oversized frames without taking down the document owner', async () => {
    const server = await start({
      config: { maxPayloadBytes: 256, maxDocumentBytes: 128, maxBufferedBytes: 512 },
    });
    const client = await join(server);
    const closed = new Promise((resolve) => client.ws.once('close', resolve));
    client.doc.getText('content').insert(0, 'x'.repeat(1024));
    expect(await closed).toBe(1009);
    expect(server.rooms.rooms.get(DOCUMENT).doc.getText('content').length).toBe(0);
    expect(
      (await fetch(`http://127.0.0.1:${server.server.address().port}/healthz`, { method: 'HEAD' }))
        .status,
    ).toBe(200);
  });

  it('caps loaded documents without retaining an unused ownership lease', async () => {
    const store = new MemoryStore();
    const server = await start({ store, id: 'a', config: { maxDocuments: 1 } });
    await join(server);
    await expect(connectClient(server, `${DOCUMENT}-extra`)).rejects.toThrow('503');
    expect(server.rooms.rooms.size).toBe(1);
    expect(server.cluster.leases.size).toBe(1);
  });

  it('expires scope tokens on an established socket', async () => {
    const server = await start();
    const token = signRealtimeToken(
      {
        sub: 'alice',
        scopes: [requiredScopeForYjsDoc(DOCUMENT)],
        ttlSeconds: 2,
      },
      SECRET,
    ).token;
    const client = await join(server, DOCUMENT, { token });
    const closed = new Promise((resolve) => client.ws.once('close', resolve));
    expect(await closed).toBe(4401);
  });

  it('caps connections and rejects cross-scope tokens', async () => {
    const server = await start({ config: { maxConnections: 1 } });
    await expect(connectClient(server, DOCUMENT, { token: 'invalid' })).rejects.toThrow('403');
    await join(server);
    await expect(connectClient(server, DOCUMENT, { user: 'bob' })).rejects.toThrow('503');
  });

  it('disconnects slow consumers rather than silently dropping updates', () => {
    const conn = { readyState: 1, bufferedAmount: 100, close: vi.fn(), send: vi.fn() };
    expect(send(conn, new Uint8Array(20), 110)).toBe(false);
    expect(conn.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('only routes to private owners and binds internal routing signatures', () => {
    expect(() => validateOwnerAddress('ws://example.org:1234')).toThrow();
    expect(() => validateOwnerAddress('ws://169.254.169.254:80')).toThrow();
    expect(() => validateOwnerAddress('ws://10.0.1.2:1234/path')).toThrow();
    expect(validateOwnerAddress('ws://10.0.1.2:1234').hostname).toBe('10.0.1.2');
    const header = routeHeader(SECRET, DOCUMENT, 'node-a', 1_800_000_000_000);
    expect(verifyRoute(header, SECRET, DOCUMENT, 'node-a', 1_800_000_001_000)).toBe(true);
    expect(verifyRoute(header, SECRET, DOCUMENT, 'node-b', 1_800_000_001_000)).toBe(false);
    expect(verifyRoute(header, SECRET, DOCUMENT, 'node-a', 1_800_000_030_000)).toBe(false);
  });
});

describe('document ownership and recovery', () => {
  it('relinquishes local authority when a committed release loses its response', async () => {
    const store = new MemoryStore();
    const server = await start({ store, id: 'a' });
    const client = await join(server);
    client.doc.getText('content').insert(0, 'checkpoint before release');
    await client.flush();
    const room = server.rooms.rooms.get(DOCUMENT);
    const original = store.release.bind(store);
    const release = vi.spyOn(store, 'release').mockImplementationOnce(async (lease) => {
      await original(lease);
      throw new Error('Response lost');
    });
    await expect(server.rooms.evict(room)).rejects.toThrow('Response lost');
    expect(server.cluster.owns(room.lease)).toBe(false);
    expect(server.rooms.rooms.has(DOCUMENT)).toBe(false);
    release.mockRestore();
    const recovered = await join(server, DOCUMENT, { user: 'bob' });
    expect(recovered.doc.getText('content').toString()).toBe('checkpoint before release');
  });
  it('preserves document state through 1 → 2 → 4 → 2 workers', async () => {
    const store = new MemoryStore();
    const a = await start({ store, id: 'a' });
    let active = [a];
    const names = Array.from({ length: 16 }, (_, i) => `${DOCUMENT}-scale-${i}`);
    let currentClients = [];
    const round = async (number) => {
      for (const client of currentClients) client.close();
      // Each heartbeat transfers at most four rooms from a worker.
      for (let tick = 0; tick < 5; tick++)
        await Promise.all(active.map((server) => server.cluster.tick()));
      currentClients = await Promise.all(
        names.map((name, i) => join(active[i % active.length], name)),
      );
      for (const client of currentClients) {
        if (number) expect(client.doc.getMap('rounds').get(String(number - 1))).toBe(true);
        client.doc.getMap('rounds').set(String(number), true);
      }
      await Promise.all(currentClients.map((client) => client.flush()));
      expect(active.reduce((sum, server) => sum + server.rooms.rooms.size, 0)).toBe(names.length);
      if (active.length > 1)
        expect(active.every((server) => server.rooms.rooms.size > 0)).toBe(true);
    };
    await round(0);
    const b = await start({ store, id: 'b' });
    active.push(b);
    await round(1);
    const c = await start({ store, id: 'c' });
    const d = await start({ store, id: 'd' });
    active.push(c, d);
    await round(2);
    await Promise.all([b.close(), d.close()]);
    active = [a, c];
    await round(3);
  }, 20_000);

  it('coalesces concurrent durability requests into one checkpoint per interval', async () => {
    const store = new MemoryStore();
    const server = await start({ store, id: 'a', config: { saveMs: 100 } });
    const participants = await Promise.all(
      Array.from({ length: 6 }, (_, i) => join(server, DOCUMENT, { user: `editor-${i}` })),
    );
    participants[0].doc.getMap('edits').set('initial', true);
    await participants[0].flush();
    expect(store.saves).toBe(1);
    await Promise.all(
      participants.map(async (client, index) => {
        client.doc.getMap('edits').set(String(index), true);
        await client.flush();
      }),
    );
    expect(store.saves).toBe(2);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, store.snapshots.get(DOCUMENT));
    expect(recovered.getMap('edits').size).toBe(7);
    recovered.destroy();
  });

  it('routes clients on two tasks to one document owner', async () => {
    const store = new MemoryStore();
    const a = await start({ store, id: 'a' });
    const b = await start({ store, id: 'b' });
    await a.cluster.tick();
    const alice = await join(a);
    const bob = await join(b, DOCUMENT, { user: 'bob' });
    alice.doc.getText('content').insert(0, 'shared across tasks');
    await expect.poll(() => bob.doc.getText('content').toString()).toBe('shared across tasks');
    expect(a.rooms.rooms.size + b.rooms.rooms.size).toBe(1);
    expect(a.metrics().ProxiedConnections + b.metrics().ProxiedConnections).toBeGreaterThan(0);
    await alice.flush();
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, store.snapshots.get(DOCUMENT));
    expect(recovered.getText('content').toString()).toBe('shared across tasks');
    recovered.destroy();
  });

  it('restores committed CRDT state after all browsers and the owner disappear', async () => {
    const store = new MemoryStore();
    let now = Date.now();
    const a = await start({ store, id: 'a', clock: () => now });
    const client = await join(a);
    client.doc.getText('content').insert(0, 'durable');
    await client.flush();
    client.close();
    // Simulate losing process memory without releasing its ownership lease.
    for (const room of a.rooms.rooms.values()) a.rooms.destroy(room);
    clearInterval(a.cluster.timer);
    await store.unregister(a.cluster.id);
    now += 31_000;
    const b = await start({ store, id: 'b', clock: () => now });
    const recovered = await join(b, DOCUMENT, { user: 'bob' });
    expect(recovered.doc.getText('content').toString()).toBe('durable');
    expect(store.documents.get(DOCUMENT).ownerId).toBe('b');
    expect(a.cluster.owns(a.cluster.leases.get(DOCUMENT))).toBe(false);
  });

  it('checkpoints before handing a room to a new worker', async () => {
    const store = new MemoryStore();
    const a = await start({ store, id: 'a' });
    const name = Array.from({ length: 100 }, (_, i) => `${DOCUMENT}-room-${i}`).find(
      (candidate) => ownerFor(candidate, [{ id: 'a' }, { id: 'b' }]).id === 'b',
    );
    const client = await join(a, name);
    client.doc.getText('content').insert(0, 'during scale-out');
    await expect.poll(() => a.rooms.rooms.get(name)?.revision).toBeGreaterThan(0);
    const b = await start({ store, id: 'b' });
    await a.cluster.tick();
    expect(a.rooms.rooms.has(name)).toBe(false);
    const moved = await join(b, name, { user: 'bob' });
    expect(moved.doc.getText('content').toString()).toBe('during scale-out');
    expect(store.documents.get(name).ownerId).toBe('b');
  });

  it('retains dirty state when checkpointing fails and fences deleted scopes', async () => {
    const store = new MemoryStore();
    const server = await start({ store, id: 'a' });
    const client = await join(server);
    client.doc.getText('content').insert(0, 'not saved yet');
    await expect.poll(() => server.rooms.rooms.get(DOCUMENT)?.revision).toBeGreaterThan(0);
    const room = server.rooms.rooms.get(DOCUMENT);
    store.failSave = true;
    await expect(server.rooms.evict(room)).rejects.toThrow('Storage unavailable');
    expect(server.rooms.rooms.get(DOCUMENT)).toBe(room);
    expect(room.closing).toBe(false);
    store.failSave = false;
    await client.flush();
    store.deletedScopes.add(scopeKey(DOCUMENT));
    await server.cluster.tick();
    expect(server.rooms.rooms.has(DOCUMENT)).toBe(false);
    await expect(server.cluster.resolve(DOCUMENT)).rejects.toThrow();
  });

  it('shares acquisition for simultaneous joins on the same worker', async () => {
    const store = new MemoryStore();
    const server = await start({ store, id: 'a' });
    const participants = await Promise.all(
      Array.from({ length: 12 }, (_, i) => join(server, DOCUMENT, { user: `user-${i}` })),
    );
    expect(server.rooms.rooms.size).toBe(1);
    expect(server.rooms.rooms.get(DOCUMENT).connections.size).toBe(12);
    participants[0].doc.getText('content').insert(0, 'one owner');
    await expect
      .poll(() =>
        participants.every((client) => client.doc.getText('content').toString() === 'one owner'),
      )
      .toBe(true);
  });
});
