import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

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
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  }
  if (documents > clients) throw new Error('documents must be no greater than clients');
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
  const run = randomUUID();
  const peers = [];
  const joins = [];
  const propagation = [];
  let stopping = false;
  let writes = 0;
  let reconnects = 0;
  let receivedBytes = 0;
  const closeCodes = {};

  const connect = async (peer) => {
    if (stopping) return;
    try {
      const credential = await token();
      if (stopping) return;
      const destination = new URL(base);
      destination.pathname = `/yjs/intent-review-${intentId}-load-${run}-${peer.room}`;
      destination.searchParams.set('token', jwt);
      destination.searchParams.set('docToken', credential);
      const started = Date.now();
      const ws = new WebSocket(destination, {
        handshakeTimeout: 15_000,
        maxPayload: 16 * 1024 * 1024,
      });
      peer.ws = ws;
      const send = (type, write) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, type);
        write(encoder);
        if (ws.readyState === 1) ws.send(encoding.toUint8Array(encoder));
      };
      ws.on('error', () => {});
      ws.on('unexpected-response', (_request, response) => {
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
              peer.ready = true;
              peer.attempt = 0;
              joins.push(Date.now() - started);
            }
          } else if (type === 1) {
            awarenessProtocol.applyAwarenessUpdate(
              peer.awareness,
              decoding.readVarUint8Array(decoder),
              ws,
            );
          }
        } catch {
          ws.terminate();
        }
      });
      ws.on('close', (code) => {
        closeCodes[code] = (closeCodes[code] ?? 0) + 1;
        peer.ready = false;
        if (!stopping) retry(peer);
      });
    } catch {
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
      };
      if (i < documents && initialBytes) doc.getText('payload').insert(0, 'x'.repeat(initialBytes));
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
        if (transaction.local) return;
        for (const key of event.keysChanged) {
          const value = doc.getMap('load').get(key);
          if (value?.at && propagation.length < 1_000_000) propagation.push(Date.now() - value.at);
        }
      });
      peers.push(peer);
      await connect(peer);
      await sleep(rampMs);
    }
    interval = setInterval(() => {
      for (const peer of peers) {
        if (!peer.ready) continue;
        peer.doc
          .getMap('load')
          .set(String(peer.index), { sequence: ++peer.sequence, at: Date.now() });
        peer.awareness.setLocalStateField('cursor', { index: peer.sequence, length: 0 });
        writes++;
      }
    }, updateMs);
    await sleep(durationSeconds * 1000);
    clearInterval(interval);
    const converged = () => {
      if (peers.some((peer) => !peer.ready || peer.sequence === 0)) return false;
      for (const writer of peers) {
        if (
          peers.some(
            (reader) =>
              reader.room === writer.room &&
              reader.doc.getMap('load').get(String(writer.index))?.sequence !== writer.sequence,
          )
        )
          return false;
      }
      return true;
    };
    const deadline = Date.now() + 30_000;
    while (!converged() && Date.now() < deadline) await sleep(100);
    return {
      run,
      clients,
      documents,
      durationSeconds,
      writes,
      receivedBytes,
      reconnects,
      closeCodes,
      connected: peers.filter((peer) => peer.ready).length,
      converged: converged(),
      joinP95Ms: percentile(joins, 0.95),
      propagationP95Ms: percentile(propagation, 0.95),
      propagationP99Ms: percentile(propagation, 0.99),
      propagationSamples: propagation.length,
    };
  } finally {
    stopping = true;
    clearInterval(interval);
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
        'Optional: YJS_LOAD_CLIENTS=40 YJS_LOAD_DOCUMENTS=10 YJS_LOAD_SECONDS=60 YJS_LOAD_UPDATE_MS=1000 YJS_LOAD_RAMP_MS=20 YJS_LOAD_INITIAL_BYTES=0.\n' +
        'The workload creates isolated CRDT rooms and refreshes scope tokens. Supply a JWT valid for the entire run.',
    );
  } else {
    let cached;
    const env = process.env;
    try {
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
      if (!result.converged) process.exitCode = 1;
    } catch {
      // Do not print WebSocket URLs, JWTs, scope tokens, or auth response bodies.
      console.error('Load test failed. Check the configuration and test-environment service logs.');
      process.exitCode = 1;
    }
  }
}
