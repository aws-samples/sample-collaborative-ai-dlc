import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { signRealtimeToken, requiredScopeForYjsDoc } from '../realtime-token.js';
import { scopeKey } from '../cluster.js';
import { persistenceMessage, FLUSH, SAVED, CAPABILITY } from '../protocol.js';

export const SECRET = 'test-secret-never-used-outside-tests';
export const INTENT = 'b6326738-6b97-4819-829a-565ee8903e38';
export const DOCUMENT = `intent-draft-${INTENT}`;
export const logger = { log() {}, warn() {}, error() {} };

const conflict = () =>
  Object.assign(new Error('Conditional conflict'), { name: 'ConditionalCheckFailedException' });

export class MemoryStore {
  constructor() {
    this.nodes = new Map();
    this.documents = new Map();
    this.snapshots = new Map();
    this.deletedScopes = new Set();
    this.failSave = false;
    this.saves = 0;
  }
  async register(member) {
    this.nodes.set(member.id, structuredClone(member));
  }
  async unregister(id) {
    this.nodes.delete(id);
  }
  async members(now) {
    return [...this.nodes.values()]
      .filter((node) => node.expiresAt * 1000 > now)
      .map((node) => ({ ...node }));
  }
  async get(name) {
    return structuredClone(this.documents.get(name));
  }
  async claim(lease, now) {
    const existing = this.documents.get(lease.documentId);
    if (existing?.leaseUntil > now || this.deletedScopes.has(scopeKey(lease.documentId)))
      throw conflict();
    const row = { ...existing, ...lease };
    this.documents.set(lease.documentId, row);
    return structuredClone(row);
  }
  async renew(lease, until, now) {
    const row = this.documents.get(lease.documentId);
    if (
      row?.leaseToken !== lease.leaseToken ||
      row.leaseUntil <= now ||
      this.deletedScopes.has(scopeKey(lease.documentId))
    )
      throw conflict();
    row.leaseUntil = until;
  }
  async load(lease) {
    return this.snapshots.get(lease.documentId)?.slice() ?? null;
  }
  async save(lease, bytes, now) {
    const row = this.documents.get(lease.documentId);
    if (this.failSave) throw new Error('Storage unavailable');
    if (
      row?.leaseToken !== lease.leaseToken ||
      row.leaseUntil <= now ||
      this.deletedScopes.has(scopeKey(lease.documentId))
    )
      throw conflict();
    this.snapshots.set(lease.documentId, bytes.slice());
    this.saves++;
    return {};
  }
  async release(lease) {
    const row = this.documents.get(lease.documentId);
    if (row?.leaseToken !== lease.leaseToken) throw conflict();
    delete row.ownerId;
    delete row.ownerAddress;
    delete row.leaseUntil;
    delete row.leaseToken;
  }
}

export const connectClient = async (
  service,
  name = DOCUMENT,
  { doc = new Y.Doc(), user = 'alice', token } = {},
) => {
  const credential =
    token ?? signRealtimeToken({ sub: user, scopes: [requiredScopeForYjsDoc(name)] }, SECRET).token;
  const url = `ws://127.0.0.1:${service.server.address().port}/yjs/${name}?token=${user}&docToken=${credential}`;
  const ws = new WebSocket(url);
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField('user', { name: user });
  const frames = [];
  let persistence = false;
  let request = 0;
  const flushes = new Map();
  let ready;
  const connected = new Promise((resolve, reject) => {
    ready = resolve;
    ws.once('close', () => reject(new Error('Disconnected before initial sync')));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => {
      response.resume();
      ws.terminate();
      reject(new Error(`Upgrade rejected: ${response.statusCode}`));
    });
  });
  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  };
  const sendAwareness = () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
    );
    send(encoding.toUint8Array(encoder));
  };
  doc.on('update', (update, origin) => {
    if (origin === ws) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  });
  awareness.on('update', (_changes, origin) => {
    if (origin === 'local') sendAwareness();
  });
  ws.on('open', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(encoding.toUint8Array(encoder));
    sendAwareness();
  });
  ws.on('message', (data) => {
    const bytes = new Uint8Array(data);
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    const subtype = type === 0 || type === 4 ? bytes[decoder.pos] : null;
    frames.push({ type, subtype, bytes: bytes.length });
    if (type === 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
      if (syncType === 1) ready();
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ws);
    } else if (type === 4) {
      const kind = decoding.readVarUint(decoder);
      const value = decoding.readVarUint(decoder);
      if (kind === CAPABILITY) persistence = value === 1;
      else if (kind === SAVED) {
        flushes.get(value)?.resolve();
        flushes.delete(value);
      }
    }
  });
  ws.on('close', () => {
    for (const pending of flushes.values()) pending.reject(new Error('Disconnected'));
    flushes.clear();
  });
  try {
    await connected;
  } catch (error) {
    doc.destroy();
    ws.terminate();
    throw error;
  }
  return {
    ws,
    doc,
    awareness,
    frames,
    flush() {
      if (!persistence) throw new Error('Persistence not supported');
      const id = ++request;
      return new Promise((resolve, reject) => {
        flushes.set(id, { resolve, reject });
        send(persistenceMessage(FLUSH, id));
      });
    },
    close() {
      ws.terminate();
      doc.destroy();
    },
  };
};
