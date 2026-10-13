import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeIntentsService } from '@/services/nativeIntents';
import { realtimeService } from '@/services/realtime';
import type { IntentOutput } from '@/services/intents';
import type { NativeIntentAdapter } from './nativeIntent';
import { getNativeListing } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';

// WebSocket hints wake the existing durable-history reader. Every read checks
// membership again, so a previously issued socket token cannot expose new data
// after access revocation. Periodic replay also covers lost notifications.
export function useNativeActivity(adapter: NativeIntentAdapter) {
  const { projectId, intentId, intent, publicationFailure } = adapter;
  const [rows, setRows] = useState<IntentOutput[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const cursor = useRef(0);
  const busy = useRef(false);
  const dirty = useRef(false);
  const alive = useRef(false);
  const replay = useCallback(async () => {
    if (!alive.current || !intent) return;
    if (busy.current) {
      dirty.current = true;
      return;
    }
    const request = generation.current;
    const accessRevision = getNativeListing(projectId).accessRevision;
    const epoch = currentSessionEpoch();
    const current = () =>
      alive.current &&
      request === generation.current &&
      epoch === currentSessionEpoch() &&
      !isSessionExpiryNotified() &&
      accessRevision === getNativeListing(projectId).accessRevision;
    busy.current = true;
    setLoading(true);
    try {
      do {
        dirty.current = false;
        let after = cursor.current;
        do {
          const page = await nativeIntentsService.outputs(projectId, intentId, after);
          if (!current()) return;
          setRows((previous) => {
            const map = new Map(previous.map((row) => [row.seq, row]));
            for (const row of page.outputs) map.set(row.seq, row);
            return [...map.values()].sort((a, b) => a.seq - b.seq);
          });
          cursor.current = page.outputs.at(-1)?.seq ?? after;
          if (page.nextAfter === null) break;
          if (page.nextAfter <= after) throw new Error('Invalid output cursor');
          after = page.nextAfter;
        } while (current());
      } while (dirty.current && current());
    } catch (error) {
      if (current()) publicationFailure(error);
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [projectId, intentId, intent, publicationFailure]);
  const replayRef = useRef(replay);
  replayRef.current = replay;
  useEffect(() => {
    cursor.current = 0;
    dirty.current = false;
    setRows([]);
    alive.current = Boolean(intent);
    if (!intent) {
      generation.current++;
      busy.current = false;
      cursor.current = 0;
      setRows([]);
      return;
    }
    void replayRef.current();
    void realtimeService
      .connect(`native-intent:${projectId}:${intentId}`, {
        projectId,
        intentId,
        executionBackend: 'native',
      })
      .catch(() => {});
    const off = realtimeService.on('agent.output', (event) => {
      if (
        event.executionBackend === 'native' &&
        event.intentId === intentId &&
        event.projectId === projectId
      )
        void replayRef.current();
    });
    const statusOff = realtimeService.onStatusChange((status) => {
      if (status === 'connected') void replayRef.current();
    });
    const timer = setInterval(() => void replayRef.current(), 2000);
    return () => {
      alive.current = false;
      generation.current++;
      busy.current = false;
      off();
      statusOff();
      clearInterval(timer);
      realtimeService.disconnect(`native-intent:${projectId}:${intentId}`);
    };
  }, [projectId, intentId, Boolean(intent)]);
  return { rows: intent ? rows : [], loading, replay };
}
