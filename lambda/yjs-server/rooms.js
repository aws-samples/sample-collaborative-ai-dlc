import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  SYNC,
  AWARENESS,
  PERSISTENCE,
  CAPABILITY,
  FLUSH,
  SAVED,
  awarenessMessage,
  closeConnection,
  persistenceMessage,
  receiveAwareness,
  send,
} from './protocol.js';

export class RoomManager {
  constructor({ config, cluster = null, logger = console }) {
    this.config = config;
    this.cluster = cluster;
    this.logger = logger;
    this.rooms = new Map();
    this.loading = new Map();
    this.updateBytes = 0;
    this.updates = 0;
    this.persistenceErrors = 0;
  }

  async get(name, lease = null) {
    if (this.rooms.has(name)) return this.rooms.get(name);
    if (this.loading.has(name)) return this.loading.get(name);
    if (this.rooms.size + this.loading.size >= this.config.maxDocuments) {
      if (this.cluster && lease) await this.cluster.release(lease).catch(() => {});
      throw new Error('Document capacity reached');
    }
    const loading = this.load(name, lease)
      .catch(async (error) => {
        if (this.cluster) await this.cluster.release(lease).catch(() => {});
        throw error;
      })
      .finally(() => this.loading.delete(name));
    this.loading.set(name, loading);
    return loading;
  }

  async load(name, lease) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const room = {
      name,
      doc,
      awareness,
      lease,
      connections: new Map(),
      awarenessOwners: new Map(),
      revision: 0,
      savedRevision: 0,
      estimatedBytes: 0,
      closing: false,
      saving: null,
      lastSaveStartedAt: 0,
      saveTimer: null,
      idleTimer: null,
    };
    try {
      const snapshot = this.cluster ? await this.cluster.load(lease) : null;
      if (snapshot) {
        if (snapshot.byteLength > this.config.maxDocumentBytes) {
          throw new Error('Stored document exceeds configured limit');
        }
        Y.applyUpdate(doc, snapshot);
        room.estimatedBytes = snapshot.byteLength;
      }
      this.checkCapacity(room.estimatedBytes);
      if (this.cluster && !this.cluster.owns(lease)) throw new Error('Document lease expired');
      doc.on('update', (update, origin) => {
        room.revision++;
        this.updates++;
        this.updateBytes += update.byteLength;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, SYNC);
        syncProtocol.writeUpdate(encoder, update);
        const message = encoding.toUint8Array(encoder);
        for (const conn of room.connections.keys()) {
          if (conn !== origin) this.send(conn, message);
        }
        // A fixed deadline from the first unsaved edit also persists continuous
        // typing; a trailing debounce alone can postpone durability forever.
        this.scheduleSave(room);
      });
      awareness.on('update', ({ added, updated, removed }, origin) => {
        const message = awarenessMessage(awareness, [...added, ...updated, ...removed]);
        for (const conn of room.connections.keys()) {
          if (conn !== origin) this.send(conn, message);
        }
      });
      this.rooms.set(name, room);
      this.scheduleEviction(room);
      return room;
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  send(conn, message) {
    return send(conn, message, this.config.maxBufferedBytes);
  }

  scheduleEviction(room) {
    if (room.connections.size || room.closing || room.idleTimer) return;
    room.idleTimer = setTimeout(() => {
      room.idleTimer = null;
      this.evict(room).catch((error) =>
        this.logger.error('Yjs idle checkpoint failed:', error.message),
      );
    }, this.config.docTtlMs);
    room.idleTimer.unref?.();
  }

  scheduleSave(room) {
    if (!this.cluster || room.saveTimer || room.closing) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      this.flush(room).catch((error) => {
        this.persistenceErrors++;
        this.logger.error('Yjs checkpoint failed:', error.message);
        this.scheduleSave(room);
      });
    }, this.config.saveMs);
    room.saveTimer.unref?.();
  }

  async flush(room) {
    if (!this.cluster) return;
    // Capture the required revision. Edits arriving during an upload are handled
    // by a subsequent iteration, including flushes concurrent with that upload.
    const requiredRevision = room.revision;
    while (room.savedRevision < requiredRevision) {
      if (room.saving) {
        await room.saving;
        continue;
      }
      room.saving = (async () => {
        // Many editing clients may request receipts at once. Coalesce their
        // revisions into at most one checkpoint per interval per document.
        await sleep(Math.max(0, room.lastSaveStartedAt + this.config.saveMs - Date.now()));
        const revision = room.revision;
        const snapshot = Y.encodeStateAsUpdate(room.doc);
        if (snapshot.byteLength > this.config.maxDocumentBytes) {
          throw new Error('Document exceeds checkpoint limit');
        }
        const previousEstimate = room.estimatedBytes;
        room.lastSaveStartedAt = Date.now();
        await this.cluster.save(room.lease, snapshot);
        room.savedRevision = revision;
        room.estimatedBytes =
          snapshot.byteLength + Math.max(0, room.estimatedBytes - previousEstimate);
        this.scheduleEviction(room);
      })().finally(() => {
        room.saving = null;
      });
      await room.saving;
    }
  }

  attach(room, conn, tokenExp) {
    if (room.closing || (this.cluster && !this.cluster.owns(room.lease))) {
      closeConnection(conn, 1012, 'document moving; reconnect');
      return;
    }
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
    const expiryTimer = tokenExp
      ? setTimeout(
          () => closeConnection(conn, 4401, 'token expired'),
          Math.max(0, tokenExp * 1000 - Date.now()),
        )
      : null;
    expiryTimer?.unref?.();
    room.connections.set(conn, { clientId: null, expiryTimer, flushing: false });
    conn.on('error', () => conn.terminate());
    conn.on('message', (message, binary) => {
      if (!binary) {
        closeConnection(conn, 1003, 'binary messages required');
        return;
      }
      if (room.closing || (this.cluster && !this.cluster.owns(room.lease))) {
        closeConnection(conn, 1012, 'document moving; reconnect');
        return;
      }
      try {
        this.receive(room, conn, new Uint8Array(message));
      } catch (error) {
        this.logger.warn('Yjs message rejected:', error.message);
        closeConnection(conn, 1008, 'invalid or oversized collaboration message');
      }
    });
    conn.on('close', () => {
      const state = room.connections.get(conn);
      if (!state) return;
      clearTimeout(state.expiryTimer);
      room.connections.delete(conn);
      if (state.clientId !== null && room.awarenessOwners.get(state.clientId) === conn) {
        room.awarenessOwners.delete(state.clientId);
        awarenessProtocol.removeAwarenessStates(room.awareness, [state.clientId], conn);
      }
      this.scheduleEviction(room);
    });

    this.send(conn, persistenceMessage(CAPABILITY, this.cluster ? 1 : 0));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    this.send(conn, encoding.toUint8Array(encoder));
    // The client's step 1 requests its missing state. An unsolicited step 2
    // duplicates that response, especially during simultaneous reconnects.
    const ids = [...room.awareness.getStates().keys()];
    if (ids.length) this.send(conn, awarenessMessage(room.awareness, ids));
  }

  receive(room, conn, message) {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === SYNC) {
      const subtype = decoding.readVarUint(decoder);
      const update = decoding.readVarUint8Array(decoder);
      if (decoding.hasContent(decoder)) throw new Error('Trailing sync data');
      if (subtype === syncProtocol.messageYjsSyncStep1) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, SYNC);
        syncProtocol.writeSyncStep2(encoder, room.doc, update);
        this.send(conn, encoding.toUint8Array(encoder));
      } else if (
        subtype === syncProtocol.messageYjsSyncStep2 ||
        subtype === syncProtocol.messageYjsUpdate
      ) {
        // Reconnects may upload a state already held by the owner. Charge only
        // missing structs to the document budget, not another full snapshot.
        const missing = Y.diffUpdate(update, Y.encodeStateVector(room.doc));
        if (room.estimatedBytes + missing.byteLength > this.config.maxDocumentBytes) {
          throw new Error('Document capacity reached');
        }
        this.checkCapacity(missing.byteLength);
        const before = room.revision;
        Y.applyUpdate(room.doc, missing, conn);
        // Duplicate handshakes and delete sets must not consume another copy of
        // the budget. Periodic compaction also bounds estimates in standalone mode.
        if (room.revision !== before) room.estimatedBytes += missing.byteLength;
        if (room.revision !== before && room.revision % 100 === 0) {
          room.estimatedBytes = Y.encodeStateAsUpdate(room.doc).byteLength;
        }
      } else {
        throw new Error('Unknown sync message');
      }
    } else if (type === AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      if (decoding.hasContent(decoder)) throw new Error('Trailing awareness data');
      receiveAwareness(room, conn, update, this.config.maxAwarenessBytes);
    } else if (type === PERSISTENCE) {
      const subtype = decoding.readVarUint(decoder);
      const requestId = decoding.readVarUint(decoder);
      if (subtype !== FLUSH || decoding.hasContent(decoder)) {
        throw new Error('Invalid persistence request');
      }
      const state = room.connections.get(conn);
      if (!state || state.flushing) throw new Error('Persistence request already pending');
      state.flushing = true;
      this.flush(room)
        .then(() => this.send(conn, persistenceMessage(SAVED, requestId)))
        .catch(() => {
          this.persistenceErrors++;
          this.scheduleSave(room);
          closeConnection(conn, 1013, 'checkpoint unavailable; retry');
        })
        .finally(() => {
          state.flushing = false;
        });
    } else {
      throw new Error('Unknown message type');
    }
  }

  checkCapacity(incomingBytes) {
    let total = incomingBytes;
    for (const room of this.rooms.values()) total += room.estimatedBytes;
    if (
      total > this.config.maxTotalDocumentBytes ||
      process.memoryUsage().rss > this.config.memoryLimitBytes * 0.85
    ) {
      throw new Error('Process document capacity reached');
    }
  }

  async evict(room) {
    if (room.closing) return;
    room.closing = true;
    clearTimeout(room.saveTimer);
    clearTimeout(room.idleTimer);
    room.saveTimer = null;
    room.idleTimer = null;
    try {
      await this.flush(room);
    } catch (error) {
      // Retain dirty state while the process lives. A failed flush must not turn
      // into idle eviction or voluntarily hand ownership to an empty successor.
      room.closing = false;
      this.scheduleSave(room);
      this.scheduleEviction(room);
      throw error;
    }
    try {
      if (this.cluster) await this.cluster.release(room.lease);
    } finally {
      // The checkpoint is durable. An uncertain release must not reopen this
      // owner: another task may already have acquired the document.
      this.destroy(room);
    }
  }

  destroy(room) {
    room.closing = true;
    clearTimeout(room.saveTimer);
    clearTimeout(room.idleTimer);
    for (const conn of room.connections.keys()) {
      closeConnection(conn, 1012, 'document moving; reconnect');
    }
    this.rooms.delete(room.name);
    room.doc.destroy();
  }

  async drain() {
    await Promise.allSettled(this.loading.values());
    const rooms = [...this.rooms.values()];
    const results = [];
    for (let offset = 0; offset < rooms.length; offset += 8) {
      results.push(
        ...(await Promise.allSettled(
          rooms.slice(offset, offset + 8).map((room) => this.evict(room)),
        )),
      );
    }
    return results;
  }
}
