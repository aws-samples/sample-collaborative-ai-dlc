import { useEffect, useState, useCallback, useMemo } from 'react';
import { useYjsDocument } from './useYjsDocument';
import { generateColor } from '../utils/colors';

export interface UserPresence {
  userId: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  activity?: 'idle' | 'description' | 'question';
  activityTarget?: string;
}

/**
 * Page-level presence via a shared Yjs document's awareness protocol.
 * Same Yjs server as collaborative editing — no separate WebSocket needed.
 */
export function usePresence(documentId: string, currentUser: { id: string; name: string }) {
  const color = useMemo(() => generateColor(currentUser.id), [currentUser.id]);
  const { awareness, synced } = useYjsDocument(
    documentId ? `presence-${documentId}` : '',
    currentUser.name,
    color,
  );
  const [users, setUsers] = useState<UserPresence[]>([]);

  // Set our presence metadata
  useEffect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('presence', {
      userId: currentUser.id,
      name: currentUser.name,
      color,
      activity: 'idle',
    });
  }, [awareness, currentUser.id, currentUser.name, color]);

  // Listen to awareness changes and build user list from raw states
  useEffect(() => {
    if (!awareness) return;

    const onChange = () => {
      const result: UserPresence[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.doc.clientID) return; // skip self
        const p = state.presence;
        const u = state.user;
        if (p || u) {
          result.push({
            userId: p?.userId || String(clientId),
            name: p?.name || u?.name || 'Anonymous',
            color: p?.color || u?.color || '#888',
            cursor: state.cursor,
            activity: p?.activity || 'idle',
            activityTarget: p?.activityTarget,
          });
        }
      });
      setUsers(result);
    };

    awareness.on('change', onChange);
    onChange(); // initial read
    return () => awareness.off('change', onChange);
  }, [awareness]);

  const connectionStatus = synced ? 'connected' : 'connecting';

  const updateCursor = useCallback((x: number, y: number) => {
    awareness?.setLocalStateField('cursor', { x, y });
  }, [awareness]);

  const setActivity = useCallback((activity: UserPresence['activity'], activityTarget?: string) => {
    awareness?.setLocalStateField('presence', {
      userId: currentUser.id,
      name: currentUser.name,
      color,
      activity,
      activityTarget,
    });
  }, [awareness, currentUser.id, currentUser.name, color]);

  return { users, connectionStatus, updateCursor, setActivity };
}


