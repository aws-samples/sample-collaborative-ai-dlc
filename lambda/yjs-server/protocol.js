import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';

export const SYNC = 0;
export const AWARENESS = 1;
// Extension ignored by older clients: capability, flush request, flush receipt.
export const PERSISTENCE = 4;
export const CAPABILITY = 0;
export const FLUSH = 1;
export const SAVED = 2;

export const persistenceMessage = (subtype, value) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, PERSISTENCE);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint(encoder, value);
  return encoding.toUint8Array(encoder);
};

export const closeConnection = (conn, code, reason) => {
  if (conn.readyState === 0 || conn.readyState === 1) conn.close(code, reason);
};

export const send = (conn, message, maxBufferedBytes) => {
  if (conn.readyState !== 1) return false;
  if (conn.bufferedAmount + message.byteLength > maxBufferedBytes) {
    // The client retains its Y.Doc and exchanges state vectors on reconnect.
    // Never silently discard an individual CRDT update.
    closeConnection(conn, 1013, 'slow consumer; reconnect to sync');
    return false;
  }
  conn.send(message, (error) => {
    if (error) conn.terminate();
  });
  return true;
};

export const awarenessMessage = (awareness, clientIds) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds),
  );
  return encoding.toUint8Array(encoder);
};

// Accept one owned awareness identity per socket. Older clients echo many IDs;
// ignore identities already owned by another socket, even if they carry a newer
// clock. This also prevents an echoed removal from taking another user offline.
export const receiveAwareness = (room, conn, update, maxBytes) => {
  if (update.byteLength > maxBytes) throw new Error('Awareness update too large');
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > 256) throw new Error('Too many awareness identities');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const raw = decoding.readVarString(decoder);
    const state = JSON.parse(raw);
    if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
      throw new Error('Invalid awareness state');
    }
    entries.push({ id, clock, raw, state });
  }
  if (decoding.hasContent(decoder)) throw new Error('Trailing awareness data');
  const connection = room.connections.get(conn);
  if (!connection) return;
  for (const entry of entries) {
    const owner = room.awarenessOwners.get(entry.id);
    if (owner && owner !== conn) continue;
    if (connection.clientId === null) {
      // Initial client messages publish their own state before receiving peers.
      // A batch from a legacy client must not claim arbitrarily many IDs.
      if (entry.state === null || count !== 1) continue;
      connection.clientId = entry.id;
    }
    if (entry.id !== connection.clientId) continue;
    room.awarenessOwners.set(entry.id, conn);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, entry.id);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.raw);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, encoding.toUint8Array(encoder), conn);
  }
};
