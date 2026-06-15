import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { realtimeService } from '../services/realtime';
import { authService } from '../services/auth';
import {
  getRealtimeToken,
  invalidateRealtimeToken,
  msUntilRefresh,
  scopeTargetForYjsDoc,
} from '../lib/realtimeToken';

export interface AwarenessUser {
  name: string;
  color: string;
  cursor?: { index: number; length: number };
  /** Set by discussion inputs — typing indicator. */
  typing?: boolean;
}

export function useYjsDocument(documentId: string | null, userName?: string, userColor?: string) {
  const [doc] = useState(() => new Y.Doc());
  const [synced, setSynced] = useState(false);
  const [awareness, setAwareness] = useState<awarenessProtocol.Awareness | null>(null);
  const [remoteUsers, setRemoteUsers] = useState<Map<number, AwarenessUser>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const tokenRefreshRef = useRef<number | null>(null);
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
    const maxReconnectAttempts = 10;
    const awarenessProt = new awarenessProtocol.Awareness(doc);
    setAwareness(awarenessProt);

    // Realtime scope token target: the Yjs server verifies signature, expiry,
    // scope coverage for this doc name, and sub binding at upgrade. Resolved
    // once per effect run (it depends only on documentId) and shared by both
    // connect() and the visibility/focus backstop.
    const target = scopeTargetForYjsDoc(documentId);
    if (!target) {
      console.error('Yjs: unknown doc-name format, cannot authorize:', documentId);
      return;
    }

    const connect = async () => {
      if (cancelled) return;

      // Fetch a fresh Cognito ID token on every (re)connect. Cognito ID
      // tokens expire after 1 hour, so reusing a captured token across
      // reconnects would eventually fail the upgrade 401. fetchAuthSession
      // refreshes automatically when the token is near expiry.
      const session = await authService.getSession();
      if (cancelled) return;
      if (!session?.idToken) {
        console.error('Yjs: no Cognito session, cannot connect');
        return;
      }

      let docToken;
      try {
        docToken = await getRealtimeToken(target);
      } catch (e) {
        console.error('Yjs: failed to fetch realtime token:', e);
        return;
      }
      if (cancelled) return;

      const yjsUrl = realtimeService.getYjsUrl(documentId, session.idToken, docToken.token);
      const ws = new WebSocket(yjsUrl);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';

      if (userName) {
        awarenessProt.setLocalStateField('user', { name: userName, color: userColor || '#888' });
      }

      let initialSyncDone = false;

      ws.onopen = () => {
        console.log('Yjs WebSocket connected');
        reconnectAttempts = 0;

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
        tokenRefreshRef.current = window.setTimeout(() => {
          tokenRefreshRef.current = null;
          if (cancelled || wsRef.current !== ws) return;
          invalidateRealtimeToken(target);
          console.log('Yjs: scope token expiring — reconnecting');
          ws.close();
        }, msUntilRefresh(docToken.exp));

        // Send sync step 1 immediately to request document state
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeSyncStep1(encoder, doc);
        ws.send(encoding.toUint8Array(encoder));

        // Do NOT setSynced(true) here — wait until server sync response arrives

        // Start ping interval to keep connection alive
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 0);
            syncProtocol.writeSyncStep1(encoder, doc);
            ws.send(encoding.toUint8Array(encoder));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
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
              setSynced(true);
            }
          } else if (messageType === 1) {
            awarenessProtocol.applyAwarenessUpdate(
              awarenessProt,
              decoding.readVarUint8Array(decoder),
              ws,
            );
          }
        } catch (e) {
          console.log('Yjs message error:', e);
        }
      };

      ws.onclose = (event) => {
        console.log('Yjs WebSocket closed:', event.code, event.reason);
        setSynced(false);
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        if (tokenRefreshRef.current) {
          clearTimeout(tokenRefreshRef.current);
          tokenRefreshRef.current = null;
        }

        // 4401 = scope token expired (server-side close at token exp) or
        // an authorization rejection — make sure the reconnect fetches a
        // fresh token instead of replaying the cached one.
        if (event.code === 4401) invalidateRealtimeToken(target);

        // Reconnect with exponential backoff
        if (reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts++;
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect().catch((e) => console.error('Yjs reconnect failed:', e));
          }, delay);
        }
      };

      ws.onerror = (event) => console.error('Yjs WebSocket error:', event);
    };

    const updateHandler = (update: Uint8Array, origin: any) => {
      const ws = wsRef.current;
      if (ws && origin !== ws && ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        ws.send(encoding.toUint8Array(encoder));
      }
    };

    const awarenessHandler = ({
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const ws = wsRef.current;
      const changed = added.concat(updated, removed);
      if (ws && ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awarenessProt, changed),
        );
        ws.send(encoding.toUint8Array(encoder));
      }
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
      console.log('Yjs: scope token stale on resume — reconnecting');
      ws.close();
    };

    doc.on('update', updateHandler);
    awarenessProt.on('change', awarenessHandler);
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    connect().catch((e) => console.error('Yjs initial connect failed:', e));

    return () => {
      cancelled = true;
      doc.off('update', updateHandler);
      awarenessProt.off('change', awarenessHandler);
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
      awarenessProtocol.removeAwarenessStates(awarenessProt, [doc.clientID], 'disconnect');
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (tokenRefreshRef.current) clearTimeout(tokenRefreshRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [documentId, doc, userName, userColor]);

  const setCursor = useCallback(
    (index: number, length: number = 0) => {
      awareness?.setLocalStateField('cursor', { index, length });
    },
    [awareness],
  );

  return { doc, synced, awareness, remoteUsers, setCursor };
}
