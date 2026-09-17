import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { realtimeService } from '../services/realtime';
import { authService } from '../services/auth';
import { currentSessionEpoch, notifySessionExpired } from '../services/sessionExpiry';
import {
  getRealtimeToken,
  invalidateRealtimeToken,
  msUntilRefresh,
  scopeTargetForYjsDoc,
  type RealtimeScopeTarget,
} from '../lib/realtimeToken';

export interface AwarenessUser {
  name: string;
  color: string;
  colorLight?: string;
  cursor?:
    | { index: number; length: number }
    | { anchor: Y.RelativePosition; head: Y.RelativePosition };
  /** Set by discussion inputs — typing indicator. */
  typing?: boolean;
}

export function useYjsDocument(
  documentId: string | null,
  userName?: string,
  userColor?: string,
  // Explicit scope target for doc names whose token target can't be derived from
  // the name alone — e.g. intent docs (`intent-sq-…`), whose realtime-token
  // endpoint is project-scoped. When omitted, the target is derived from the doc
  // name via scopeTargetForYjsDoc (the v1 sprint/project path).
  scopeTarget?: RealtimeScopeTarget,
) {
  // Intentionally keyed on documentId: a new document must get a FRESH Y.Doc even
  // though the factory doesn't read documentId (the rule flags it as unnecessary).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doc = useMemo(() => new Y.Doc(), [documentId]);
  const currentDocRef = useRef(doc);
  currentDocRef.current = doc;
  const awareness = useMemo(() => new awarenessProtocol.Awareness(doc), [doc]);
  const [syncState, setSyncState] = useState({ doc, synced: false });
  const synced = syncState.doc === doc && syncState.synced;
  const setSynced = useCallback((value: boolean) => setSyncState({ doc, synced: value }), [doc]);
  const [remoteUsers, setRemoteUsers] = useState<Map<number, AwarenessUser>>(new Map());
  const [localChange, setLocalChange] = useState({ doc, revision: 0 });
  const wsRef = useRef<WebSocket | null>(null);
  const readySocketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const handshakeTimerRef = useRef<number | null>(null);
  const tokenRefreshRef = useRef<number | null>(null);
  const persistenceRef = useRef(false);
  const flushSequenceRef = useRef(0);
  const pendingFlushRef = useRef<{
    id: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const flushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingDestroyRef = useRef<{
    doc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Epoch seconds of the scope token backing the current socket. Used by the
  // visibility/focus backstop to tell whether the proactive refresh timer
  // (below) was throttled while the tab was hidden.
  const tokenExpRef = useRef<number | null>(null);

  useEffect(() => {
    if (!documentId) {
      setSynced(false);
      setRemoteUsers(new Map());
      return;
    }

    let cancelled = false;
    let reconnectAttempts = 0;
    let awarenessTimer: ReturnType<typeof setTimeout> | null = null;
    const awarenessProt = awareness;
    setSynced(false);
    setRemoteUsers(new Map());

    // Realtime scope token target: the Yjs server verifies signature, expiry,
    // scope coverage for this doc name, and sub binding at upgrade. Resolved
    // once per effect run (it depends only on documentId) and shared by both
    // connect() and the visibility/focus backstop.
    const target = scopeTarget ?? scopeTargetForYjsDoc(documentId);
    if (!target) {
      console.error('Yjs: unknown doc-name format, cannot authorize:', documentId);
      return;
    }

    let connect: () => Promise<void>;
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimeoutRef.current !== null) return;
      const maximum = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      const delay = Math.floor(maximum * (0.5 + Math.random() * 0.5));
      reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
      if (import.meta.env.DEV)
        console.log(`Yjs: reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect().catch((error) => {
          console.error('Yjs reconnect failed:', error);
          scheduleReconnect();
        });
      }, delay);
    };

    connect = async () => {
      if (cancelled) return;

      // Fetch a fresh Cognito ID token on every (re)connect. Cognito ID
      // tokens expire after 1 hour, so reusing a captured token across
      // reconnects would eventually fail the upgrade 401. fetchAuthSession
      // refreshes automatically when the token is near expiry.
      let session;
      try {
        const epoch = currentSessionEpoch();
        const resolution = await authService.resolveSession();
        session = resolution.session;
        if (resolution.expired) notifySessionExpired(epoch);
      } catch (error) {
        console.error('Yjs: failed to refresh Cognito session:', error);
        scheduleReconnect();
        return;
      }
      if (cancelled) return;
      if (!session?.idToken) {
        console.error('Yjs: no Cognito session, cannot connect');
        scheduleReconnect();
        return;
      }

      let docToken;
      try {
        docToken = await getRealtimeToken(target);
      } catch (e) {
        console.error('Yjs: failed to fetch realtime token:', e);
        scheduleReconnect();
        return;
      }
      if (cancelled) return;

      const yjsUrl = realtimeService.getYjsUrl(documentId, session.idToken, docToken.token);
      let ws;
      try {
        ws = new WebSocket(yjsUrl);
      } catch (error) {
        console.error('Yjs: failed to open WebSocket:', error);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      readySocketRef.current = null;
      ws.binaryType = 'arraybuffer';
      persistenceRef.current = false;
      handshakeTimerRef.current = window.setTimeout(() => {
        if (!cancelled && wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }, 15_000);

      if (userName) {
        const color = userColor || '#888888';
        awarenessProt.setLocalStateField('user', {
          name: userName,
          color,
          colorLight: /^#[\da-f]{6}$/i.test(color) ? `${color}33` : color,
        });
      }

      let initialSyncDone = false;

      // NOTE: on* handler ASSIGNMENT (not addEventListener) is intentional — one
      // handler per event, replaced/nulled across reconnects and on teardown.
      // unicorn/prefer-add-event-listener is disabled for this file in
      // .oxlintrc.json for that reason.
      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) {
          ws.close();
          return;
        }
        if (handshakeTimerRef.current) clearTimeout(handshakeTimerRef.current);
        handshakeTimerRef.current = null;
        if (import.meta.env.DEV) console.log('Yjs WebSocket connected');

        // Proactively reconnect shortly before the scope token expires — the
        // server force-closes the socket at expiry (close code 4401), so
        // beating it keeps the session seamless.
        //
        // The timer alone is fragile: browsers throttle/suspend setTimeout in
        // backgrounded tabs and across machine sleep, so it can fire late or
        // not at all. Two backstops cover that: (1) the server's 4401 close +
        // backoff reconnect below, and (2) the visibility/focus handler, which
        // cycles a stale-but-still-open socket the moment the user returns. The
        // recorded expiry lets that handler decide whether a refresh is due.
        tokenExpRef.current = docToken.exp;
        if (tokenRefreshRef.current) clearTimeout(tokenRefreshRef.current);
        tokenRefreshRef.current = window.setTimeout(
          () => {
            tokenRefreshRef.current = null;
            if (cancelled || wsRef.current !== ws) return;
            invalidateRealtimeToken(target);
            if (import.meta.env.DEV) console.log('Yjs: scope token expiring — reconnecting');
            ws.close();
          },
          Math.max(0, msUntilRefresh(docToken.exp) - Math.random() * 15_000),
        );

        // Send sync step 1 immediately to request document state
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep1(encoder, doc);
        ws.send(encoding.toUint8Array(encoder));

        // setLocalStateField runs before the socket opens, so its update could
        // not be sent by awarenessHandler. Publish the complete local state as
        // part of every successful (re)connect handshake.
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, 1);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(awarenessProt, [doc.clientID]),
        );
        ws.send(encoding.toUint8Array(awarenessEncoder));

        // Do NOT setSynced(true) here — wait until server sync response arrives

        // Liveness uses server WebSocket ping/pong. Awareness renewals below
        // keep presence live without computing a document delta every 30 s.
      };

      ws.onmessage = (event) => {
        if (cancelled || wsRef.current !== ws) return;
        const data = new Uint8Array(event.data);
        try {
          const decoder = decoding.createDecoder(data);
          const messageType = decoding.readVarUint(decoder);
          if (messageType === 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 0);
            const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
            if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
              ws.send(encoding.toUint8Array(encoder));
            }
            // Only mark synced after receiving sync step 2 (document state),
            // not sync step 1 (just a state vector request).
            // syncMessageType: 0 = step1, 1 = step2, 2 = update
            if (!initialSyncDone && syncMessageType === 1) {
              initialSyncDone = true;
              reconnectAttempts = 0;
              readySocketRef.current = ws;
              setSynced(true);
            }
          } else if (messageType === 1) {
            awarenessProtocol.applyAwarenessUpdate(
              awarenessProt,
              decoding.readVarUint8Array(decoder),
              ws,
            );
          } else if (messageType === 4) {
            const subtype = decoding.readVarUint(decoder);
            const value = decoding.readVarUint(decoder);
            if (subtype === 0) persistenceRef.current = value === 1;
            else if (subtype === 2 && pendingFlushRef.current?.id === value) {
              const pending = pendingFlushRef.current;
              clearTimeout(pending.timer);
              pendingFlushRef.current = null;
              pending.resolve();
            }
          }
        } catch (e) {
          if (import.meta.env.DEV) console.log('Yjs message error:', e);
        }
      };

      ws.onclose = (event) => {
        if (cancelled || wsRef.current !== ws) return;
        if (import.meta.env.DEV) console.log('Yjs WebSocket closed:', event.code, event.reason);
        setSynced(false);
        readySocketRef.current = null;
        const remoteClientIds = [...awarenessProt.getStates().keys()].filter(
          (clientId) => clientId !== doc.clientID,
        );
        if (remoteClientIds.length) {
          awarenessProtocol.removeAwarenessStates(awarenessProt, remoteClientIds, ws);
        }
        if (handshakeTimerRef.current) {
          clearTimeout(handshakeTimerRef.current);
          handshakeTimerRef.current = null;
        }
        if (pendingFlushRef.current) {
          clearTimeout(pendingFlushRef.current.timer);
          pendingFlushRef.current.reject(new Error('Collaboration disconnected before saving'));
          pendingFlushRef.current = null;
        }
        if (tokenRefreshRef.current) {
          clearTimeout(tokenRefreshRef.current);
          tokenRefreshRef.current = null;
        }

        // 4401 = scope token expired (server-side close at token exp) or
        // an authorization rejection — make sure the reconnect fetches a
        // fresh token instead of replaying the cached one.
        if (event.code === 4401) invalidateRealtimeToken(target);

        scheduleReconnect();
      };

      ws.onerror = (event) => console.error('Yjs WebSocket error:', event);
    };

    const updateHandler = (
      update: Uint8Array,
      origin: any,
      _doc: Y.Doc,
      transaction: Y.Transaction,
    ) => {
      if (transaction.local) {
        setLocalChange((previous) => ({
          doc,
          revision: previous.doc === doc ? previous.revision + 1 : 1,
        }));
      }
      const ws = wsRef.current;
      if (ws && origin !== ws && ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        ws.send(encoding.toUint8Array(encoder));
      }
    };

    const sendAwareness = () => {
      awarenessTimer = null;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awarenessProt, [doc.clientID]),
        );
        ws.send(encoding.toUint8Array(encoder));
      }
    };
    const awarenessUpdateHandler = (_changes: unknown, origin: unknown) => {
      if (origin !== 'local') return;
      // Coalesce cursor events, but also send unchanged-state clock renewals.
      // Remote identities are never echoed or claimed by this connection.
      if (awarenessTimer === null) awarenessTimer = setTimeout(sendAwareness, 50);
    };
    const awarenessHandler = () => {
      const users = new Map<number, AwarenessUser>();
      awarenessProt.getStates().forEach((state, clientId) => {
        if (clientId !== doc.clientID && state.user) {
          users.set(clientId, { ...state.user, cursor: state.cursor, typing: state.typing });
        }
      });
      setRemoteUsers(users);
    };

    // Backstop for the proactive-refresh timer above: timers are throttled in
    // hidden tabs and frozen across machine sleep, so a tab that was backgrounded
    // past the token's expiry can wake holding a socket whose refresh never fired.
    // When the user returns, if the socket is still open on a token at/near
    // expiry, cycle it now with a fresh token rather than waiting for the
    // server's 4401. `msUntilRefresh` returning 0 means we're inside the refresh
    // lead window (or past it) — the same threshold the timer uses.
    const refreshIfStale = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (tokenExpRef.current === null || msUntilRefresh(tokenExpRef.current) > 0) return;
      if (tokenRefreshRef.current) {
        clearTimeout(tokenRefreshRef.current);
        tokenRefreshRef.current = null;
      }
      invalidateRealtimeToken(target);
      if (import.meta.env.DEV) console.log('Yjs: scope token stale on resume — reconnecting');
      ws.close();
    };

    doc.on('update', updateHandler);
    awarenessProt.on('change', awarenessHandler);
    awarenessProt.on('update', awarenessUpdateHandler);
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    connect().catch((e) => console.error('Yjs initial connect failed:', e));

    return () => {
      cancelled = true;
      doc.off('update', updateHandler);
      awarenessProt.off('change', awarenessHandler);
      awarenessProt.off('update', awarenessUpdateHandler);
      if (awarenessTimer) clearTimeout(awarenessTimer);
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
      awarenessProtocol.removeAwarenessStates(awarenessProt, [doc.clientID], 'disconnect');
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (handshakeTimerRef.current) {
        clearTimeout(handshakeTimerRef.current);
        handshakeTimerRef.current = null;
      }
      if (tokenRefreshRef.current) {
        clearTimeout(tokenRefreshRef.current);
        tokenRefreshRef.current = null;
      }
      tokenExpRef.current = null;
      if (pendingFlushRef.current) {
        clearTimeout(pendingFlushRef.current.timer);
        pendingFlushRef.current.reject(new Error('Collaboration closed before saving'));
        pendingFlushRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      readySocketRef.current = null;
    };
    // scopeTarget is intentionally not a dep: it is derived from documentId
    // (same identity across renders for a given doc) and re-running on a new
    // object reference would needlessly recycle the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, doc, awareness, userName, userColor, setSynced]);

  // Registered after the connection effect so its cleanup runs only after the
  // socket listeners have released the old document and awareness instance.
  // Destruction is deferred by one task so React Strict Mode's development
  // cleanup/setup replay can cancel it and safely reuse these memoized objects.
  useEffect(() => {
    const pending = pendingDestroyRef.current;
    if (pending?.doc === doc && pending.awareness === awareness) {
      clearTimeout(pending.timer);
      pendingDestroyRef.current = null;
    }

    return () => {
      const timer = setTimeout(() => {
        awareness.destroy();
        doc.destroy();
        const current = pendingDestroyRef.current;
        if (current?.doc === doc && current.awareness === awareness && current.timer === timer) {
          pendingDestroyRef.current = null;
        }
      }, 0);
      pendingDestroyRef.current = {
        doc,
        awareness,
        timer,
      };
    };
  }, [awareness, doc]);

  const setCursor = useCallback(
    (index: number, length: number = 0) => {
      awareness?.setLocalStateField('cursor', { index, length });
    },
    [awareness],
  );

  const flushDocument = useCallback((): Promise<void> => {
    const expectedDoc = doc;
    const operation = flushQueueRef.current
      .catch(() => {})
      .then(() => {
        if (currentDocRef.current !== expectedDoc)
          throw new Error('Collaboration document changed');
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || readySocketRef.current !== ws) {
          throw new Error('Collaboration has not synchronized');
        }
        // Capability is delivered before initial sync. An interrupted handshake
        // must not accidentally downgrade a cluster save to legacy REST-only.
        if (!persistenceRef.current) return;
        return new Promise<void>((resolve, reject) => {
          const id = ++flushSequenceRef.current;
          const timer = setTimeout(() => {
            if (pendingFlushRef.current?.id === id) pendingFlushRef.current = null;
            reject(new Error('Collaboration checkpoint timed out'));
          }, 20_000);
          pendingFlushRef.current = { id, resolve, reject, timer };
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 4);
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarUint(encoder, id);
          ws.send(encoding.toUint8Array(encoder));
        });
      });
    flushQueueRef.current = operation;
    return operation;
  }, [doc]);

  const localRevision = localChange.doc === doc ? localChange.revision : 0;
  return { doc, synced, awareness, remoteUsers, setCursor, localRevision, flushDocument };
}
