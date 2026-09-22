import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { CAPABILITY, FLUSH, SAVED, persistenceMessage } from './protocol.js';

const journalHash = (entries) =>
  createHash('sha256')
    .update(JSON.stringify([...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');

// Expected entries come from the writer's independent journal, never from a
// converged reader or a server snapshot. A last-value check alone misses holes.
export const verifyLoadDocument = (doc, expected) =>
  doc.getMap('journal').size === expected.writes &&
  journalHash(doc.getMap('journal').entries()) === expected.journalSha256 &&
  doc.getText('payload').length === expected.initialBytes &&
  createHash('sha256').update(doc.getText('payload').toString()).digest('hex') ===
    expected.payloadSha256 &&
  expected.writers.every(
    ({ index, sequence }) => doc.getMap('load').get(String(index))?.sequence === sequence,
  );

const markReady = (peer, ready) => {
  const now = Date.now();
  if (ready && !peer.ready) {
    const gap = now - peer.unavailableSince;
    peer.unavailableMs += gap;
    peer.maxUnavailableMs = Math.max(peer.maxUnavailableMs, gap);
    peer.firstReadyAt ??= now;
  } else if (!ready && peer.ready) peer.unavailableSince = now;
  peer.ready = ready;
};

const percentile = (samples, fraction) => {
  if (!samples.length) return null;
  const ordered = samples.toSorted((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
};

/**
 * Writes isolated load-test rooms within a disposable intent. It never changes
 * business artifacts. A token callback lets deployed runs refresh scope tokens
 * and local tests use their own authenticated fixture.
 */
export const runLoad = async ({
  url,
  jwt,
  token,
  intentId,
  clients = 40,
  documents = 10,
  durationSeconds = 60,
  rampMs = 20,
  updateMs = 1000,
  initialBytes = 0,
  writeWhileDisconnected = true,
  requireDurability = false,
  settleMs = 60_000,
  run = randomUUID(),
  expectedRooms = null,
  onProgress = () => {},
}) => {
  if (!jwt || !token || !/^[0-9a-f-]{36}$/i.test(intentId))
    throw new Error('An authenticated test intent is required');
  for (const [name, value, minimum] of [
    ['clients', clients, 1],
    ['documents', documents, 1],
    ['durationSeconds', durationSeconds, 1],
    ['rampMs', rampMs, 0],
    ['updateMs', updateMs, 10],
    ['initialBytes', initialBytes, 0],
    ['settleMs', settleMs, 0],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  }
  if (documents > clients) throw new Error('documents must be no greater than clients');
  if (!/^[0-9a-f-]{36}$/i.test(run)) throw new Error('Invalid run ID');
  if (expectedRooms && (expectedRooms.length !== documents || clients !== documents))
    throw new Error('Cold verification requires one fresh client per expected document');
  const base = new URL(url);
  if (
    !['ws:', 'wss:', 'http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Use an application origin without credentials or query parameters');
  }
  base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'wss:' : 'ws:';
  const peers = [];
  const joins = [];
  const propagation = [];
  let stopping = false;
  let writes = 0;
  let reconnects = 0;
  let receivedBytes = 0;
  let offlineWrites = 0;
  let tokenFailures = 0;
  const closeCodes = {};
  const upgradeErrors = {};
  const startedAt = Date.now();
  const documentNames = Array.from(
    { length: documents },
    (_, room) => `intent-review-${intentId}-load-${run}-${room}`,
  );
  const progress = () => ({
    at: new Date().toISOString(),
    run,
    elapsedMs: Date.now() - startedAt,
    connected: peers.filter((peer) => peer.ready).length,
    clients,
    writes,
    offlineWrites,
    reconnects,
    closeCodes: { ...closeCodes },
    upgradeErrors: { ...upgradeErrors },
  });

  const connect = async (peer) => {
    if (stopping) return;
    try {
      const credential = await token();
      if (stopping) return;
      const destination = new URL(base);
      destination.pathname = `/yjs/${documentNames[peer.room]}`;
      destination.searchParams.set('token', jwt);
      destination.searchParams.set('docToken', credential);
      const started = Date.now();
      const ws = new WebSocket(destination, {
        handshakeTimeout: 15_000,
        maxPayload: 16 * 1024 * 1024,
      });
      peer.ws = ws;
      peer.persistence = false;
      const send = (type, write) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, type);
        write(encoder);
        if (ws.readyState === 1) ws.send(encoding.toUint8Array(encoder));
      };
      ws.on('error', () => {});
      ws.on('unexpected-response', (_request, response) => {
        upgradeErrors[response.statusCode] = (upgradeErrors[response.statusCode] ?? 0) + 1;
        response.resume();
        ws.terminate();
      });
      ws.on('open', () => {
        send(0, (encoder) => sync.writeSyncStep1(encoder, peer.doc));
        send(1, (encoder) =>
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(peer.awareness, [peer.doc.clientID]),
          ),
        );
      });
      ws.on('message', (message) => {
        receivedBytes += message.byteLength;
        try {
          const decoder = decoding.createDecoder(new Uint8Array(message));
          const type = decoding.readVarUint(decoder);
          if (type === 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 0);
            const subtype = sync.readSyncMessage(decoder, encoder, peer.doc, ws);
            if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
            if (subtype === 1 && !peer.ready) {
              markReady(peer, true);
              peer.attempt = 0;
              joins.push(Date.now() - started);
            }
          } else if (type === 1) {
            awarenessProtocol.applyAwarenessUpdate(
              peer.awareness,
              decoding.readVarUint8Array(decoder),
              ws,
            );
          } else if (type === 4) {
            const kind = decoding.readVarUint(decoder);
            const value = decoding.readVarUint(decoder);
            if (kind === CAPABILITY) peer.persistence = value === 1;
            else if (kind === SAVED && peer.flush?.id === value) peer.flush.resolve();
          }
        } catch {
          ws.terminate();
        }
      });
      ws.on('close', (code) => {
        closeCodes[code] = (closeCodes[code] ?? 0) + 1;
        markReady(peer, false);
        peer.flush?.reject(new Error('Disconnected before durability receipt'));
        if (!stopping) retry(peer);
      });
    } catch {
      tokenFailures++;
      if (!stopping) retry(peer);
    }
  };
  const retry = (peer) => {
    reconnects++;
    const delay =
      Math.min(500 * 2 ** Math.min(peer.attempt++, 6), 30_000) * (0.5 + Math.random() * 0.5);
    peer.retry = setTimeout(() => connect(peer), delay);
  };
  let interval;
  let progressTimer;
  try {
    for (let i = 0; i < clients; i++) {
      const doc = new Y.Doc();
      const awareness = new awarenessProtocol.Awareness(doc);
      awareness.setLocalStateField('user', { name: `load-${i}` });
      const peer = {
        doc,
        awareness,
        room: i % documents,
        index: i,
        attempt: 0,
        ready: false,
        sequence: 0,
        ws: null,
        createdAt: Date.now(),
        unavailableSince: Date.now(),
        unavailableMs: 0,
        maxUnavailableMs: 0,
        journal: [],
        request: 0,
      };
      if (!expectedRooms && i < documents && initialBytes)
        doc.getText('payload').insert(0, 'x'.repeat(initialBytes));
      doc.on('update', (update, origin) => {
        if (origin === peer.ws || peer.ws?.readyState !== 1) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        sync.writeUpdate(encoder, update);
        if (peer.ws.bufferedAmount + update.byteLength > 16 * 1024 * 1024) peer.ws.terminate();
        else peer.ws.send(encoding.toUint8Array(encoder));
      });
      awareness.on('update', (_change, origin) => {
        if (origin !== 'local' || peer.ws?.readyState !== 1) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
        );
        peer.ws.send(encoding.toUint8Array(encoder));
      });
      doc.getMap('load').observe((event, transaction) => {
        // Historical values in a cold snapshot measure the age of the saved
        // edit, not propagation latency for this verification run.
        if (transaction.local || expectedRooms) return;
        for (const key of event.keysChanged) {
          const value = doc.getMap('load').get(key);
          if (value?.at && propagation.length < 1_000_000) propagation.push(Date.now() - value.at);
        }
      });
      peers.push(peer);
      await connect(peer);
      await sleep(rampMs);
    }
    onProgress(progress());
    progressTimer = setInterval(() => onProgress(progress()), 1000);
    if (!expectedRooms) {
      interval = setInterval(() => {
        for (const peer of peers) {
          if (!peer.ready && !writeWhileDisconnected) continue;
          const value = { sequence: ++peer.sequence, at: Date.now() };
          const key = `${peer.index}:${peer.sequence}`;
          peer.journal.push([key, value.at]);
          peer.doc.transact(() => {
            peer.doc.getMap('load').set(String(peer.index), value);
            peer.doc.getMap('journal').set(key, value.at);
          });
          peer.awareness.setLocalStateField('cursor', { index: peer.sequence, length: 0 });
          writes++;
          if (!peer.ready) offlineWrites++;
        }
      }, updateMs);
      await sleep(durationSeconds * 1000);
    }
    clearInterval(interval);
    const expected =
      expectedRooms ??
      documentNames.map((documentId, room) => {
        const writers = peers.filter((peer) => peer.room === room);
        const entries = writers.flatMap((peer) => peer.journal);
        return {
          documentId,
          writes: entries.length,
          journalSha256: journalHash(entries),
          initialBytes,
          payloadSha256: createHash('sha256').update('x'.repeat(initialBytes)).digest('hex'),
          writers: writers.map(({ index, sequence }) => ({ index, sequence })),
        };
      });
    const converged = () => {
      if (peers.some((peer) => !peer.ready || (!expectedRooms && peer.sequence === 0)))
        return false;
      return peers.every((peer) => verifyLoadDocument(peer.doc, expected[peer.room]));
    };
    const deadline = Date.now() + settleMs;
    while (!converged() && Date.now() < deadline) await sleep(100);
    let durable = false;
    if (requireDurability && converged()) {
      const receipts = await Promise.allSettled(
        peers.map(
          (peer) =>
            new Promise((resolve, reject) => {
              if (!peer.persistence) return reject(new Error('Persistence not supported'));
              const timer = setTimeout(
                () => reject(new Error('Durability receipt timed out')),
                15_000,
              );
              peer.flush = {
                id: ++peer.request,
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
                reject: (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              };
              peer.ws.send(persistenceMessage(FLUSH, peer.flush.id));
            }),
        ),
      );
      durable = receipts.every((receipt) => receipt.status === 'fulfilled');
    }
    const finishedAt = Date.now();
    const unavailability = peers.map((peer) => {
      const tail = peer.ready ? 0 : finishedAt - peer.unavailableSince;
      return {
        index: peer.index,
        initialSyncMs: peer.firstReadyAt ? peer.firstReadyAt - peer.createdAt : null,
        unavailableMs: peer.unavailableMs + tail,
        maxUnavailableMs: Math.max(peer.maxUnavailableMs, tail),
        observedMs: finishedAt - peer.createdAt,
      };
    });
    onProgress(progress());
    return {
      run,
      clients,
      documents,
      durationSeconds,
      writes,
      offlineWrites,
      writeWhileDisconnected,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      receivedBytes,
      reconnects,
      closeCodes,
      upgradeErrors,
      tokenFailures,
      connected: peers.filter((peer) => peer.ready).length,
      converged: converged(),
      durable,
      expectedRooms: expected,
      unavailableClientMs: unavailability.reduce((sum, peer) => sum + peer.unavailableMs, 0),
      maxUnavailableMs: Math.max(...unavailability.map((peer) => peer.maxUnavailableMs)),
      syncAvailability:
        1 -
        unavailability.reduce((sum, peer) => sum + peer.unavailableMs, 0) /
          unavailability.reduce((sum, peer) => sum + peer.observedMs, 0),
      unavailability,
      joinP95Ms: percentile(joins, 0.95),
      propagationP95Ms: percentile(propagation, 0.95),
      propagationP99Ms: percentile(propagation, 0.99),
      propagationSamples: propagation.length,
    };
  } finally {
    stopping = true;
    clearInterval(interval);
    clearInterval(progressTimer);
    for (const peer of peers) {
      clearTimeout(peer.retry);
      peer.ws?.terminate();
      peer.awareness.destroy();
      peer.doc.destroy();
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log(
      'Set YJS_LOAD_URL, YJS_LOAD_JWT, YJS_LOAD_PROJECT_ID, YJS_LOAD_INTENT_ID for a disposable intent.\n' +
        'Optional: YJS_LOAD_CLIENTS=40 YJS_LOAD_DOCUMENTS=10 YJS_LOAD_SECONDS=60 YJS_LOAD_UPDATE_MS=1000 YJS_LOAD_RAMP_MS=20 YJS_LOAD_INITIAL_BYTES=0 YJS_LOAD_REQUIRE_DURABILITY=false.\n' +
        'Set YJS_LOAD_EXPECTED_FILE to a previous result JSON to verify cold recovery with fresh, empty clients and no generated edits.\n' +
        'The workload creates isolated CRDT rooms and refreshes scope tokens. Supply a JWT valid for the entire run.',
    );
  } else {
    let cached;
    const env = process.env;
    try {
      const previous = env.YJS_LOAD_EXPECTED_FILE
        ? JSON.parse(readFileSync(env.YJS_LOAD_EXPECTED_FILE, 'utf8'))
        : null;
      const result = await runLoad({
        url: env.YJS_LOAD_URL,
        jwt: env.YJS_LOAD_JWT,
        intentId: env.YJS_LOAD_INTENT_ID,
        clients: Number(env.YJS_LOAD_CLIENTS ?? 40),
        documents: Number(env.YJS_LOAD_DOCUMENTS ?? 10),
        durationSeconds: Number(env.YJS_LOAD_SECONDS ?? 60),
        updateMs: Number(env.YJS_LOAD_UPDATE_MS ?? 1000),
        rampMs: Number(env.YJS_LOAD_RAMP_MS ?? 20),
        initialBytes: Number(env.YJS_LOAD_INITIAL_BYTES ?? 0),
        requireDurability: env.YJS_LOAD_REQUIRE_DURABILITY === 'true',
        ...(previous
          ? {
              run: previous.run,
              clients: previous.documents,
              documents: previous.documents,
              expectedRooms: previous.expectedRooms,
            }
          : {}),
        token: async () => {
          if (cached?.exp > Date.now() / 1000 + 30) return cached.token;
          const endpoint = new URL(
            `/api/projects/${encodeURIComponent(env.YJS_LOAD_PROJECT_ID)}/intents/${encodeURIComponent(env.YJS_LOAD_INTENT_ID)}/realtime-token`,
            env.YJS_LOAD_URL,
          );
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.YJS_LOAD_JWT}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error('Unable to authorize load-test intent');
          cached = await response.json();
          return cached.token;
        },
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.converged || (env.YJS_LOAD_REQUIRE_DURABILITY === 'true' && !result.durable))
        process.exitCode = 1;
    } catch {
      // Do not print WebSocket URLs, JWTs, scope tokens, or auth response bodies.
      console.error('Load test failed. Check the configuration and test-environment service logs.');
      process.exitCode = 1;
    }
  }
}
