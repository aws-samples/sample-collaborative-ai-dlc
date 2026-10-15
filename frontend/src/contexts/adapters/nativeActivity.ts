import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeIntentsService, type NativeActivityEvent } from '@/services/nativeIntents';
import { ApiError } from '@/services/api';
import { realtimeService } from '@/services/realtime';
import type { IntentOutput } from '@/services/intents';
import type { NativeIntentAdapter } from './nativeIntent';
import { getNativeListing } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';

// WebSocket hints wake the existing durable-history reader. Every read checks
// membership again, so a previously issued socket token cannot expose new data
// after access revocation. Periodic replay also covers lost notifications.
export function useNativeActivity(adapter: NativeIntentAdapter) {
  const { projectId, intentId, intent } = adapter;
  const enabled = Boolean(intent);
  const [rows, setRows] = useState<IntentOutput[]>([]);
  const [events, setEvents] = useState<NativeActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const scope = JSON.stringify([projectId, intentId, currentSessionEpoch()]);
  const loadedScope = useRef(scope);
  const generation = useRef(0);
  const cursor = useRef(0);
  const eventCursor = useRef(0);
  const busy = useRef(false);
  const dirty = useRef(false);
  const alive = useRef(false);
  const replay = useCallback(async () => {
    if (!alive.current || !enabled) return;
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
          const page = await nativeIntentsService.outputs(
            projectId,
            intentId,
            after,
            eventCursor.current,
          );
          if (!current()) return;
          // The service verifies strict ordering after each independent cursor.
          // One reader owns them, including retries. Empty polls keep the same
          // arrays; there is no full-history merge/sort on every two-second tick.
          if (page.outputs.length)
            setRows((previous) => (current() ? [...previous, ...page.outputs] : previous));
          if (page.events?.length)
            setEvents((previous) => (current() ? [...previous, ...page.events!] : previous));
          cursor.current = page.outputs.at(-1)?.seq ?? after;
          const previousEvent = eventCursor.current;
          eventCursor.current = page.events?.at(-1)?.revision ?? previousEvent;
          setError(null);
          if (page.nextAfter === null && page.nextEventAfter == null) break;
          if (
            (page.nextAfter !== null && page.nextAfter <= after) ||
            (page.nextEventAfter != null && page.nextEventAfter <= previousEvent)
          )
            throw new Error('Invalid output cursor');
          after = cursor.current;
        } while (current());
      } while (dirty.current && current());
      if (current()) setObservedAt(Date.now());
    } catch (failure) {
      if (current()) {
        // A resource/action denial is not proof of lost project membership.
        // Clear this scoped history; only the detail/list owner evicts access.
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          setRows([]);
          setEvents([]);
          cursor.current = 0;
          eventCursor.current = 0;
          setObservedAt(null);
        }
        setError('Activity could not be refreshed. History may be incomplete; retry refresh.');
      }
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [projectId, intentId, enabled]);
  const replayRef = useRef(replay);
  replayRef.current = replay;
  useEffect(() => {
    cursor.current = 0;
    eventCursor.current = 0;
    loadedScope.current = scope;
    dirty.current = false;
    setRows([]);
    setEvents([]);
    setError(null);
    setObservedAt(null);
    setNow(Date.now());
    alive.current = enabled;
    if (!enabled) {
      generation.current++;
      busy.current = false;
      cursor.current = 0;
      setRows([]);
      return;
    }
    void replayRef.current();
    const subscription = generation.current;
    void realtimeService
      .connect(`native-intent:${projectId}:${intentId}`, {
        projectId,
        intentId,
        executionBackend: 'native',
      })
      .catch(() => {});
    const off = realtimeService.on('agent.output', (event) => {
      if (
        subscription === generation.current &&
        event.executionBackend === 'native' &&
        event.intentId === intentId &&
        event.projectId === projectId
      )
        void replayRef.current();
    });
    const statusOff = realtimeService.onStatusChange((status) => {
      if (subscription === generation.current && status === 'connected') void replayRef.current();
    });
    const timer = setInterval(() => {
      // Reuse the history clock even when a read stalls. This is observation
      // age, never a runtime heartbeat or evidence of execution progress.
      setNow(Date.now());
      void replayRef.current();
    }, 2000);
    return () => {
      alive.current = false;
      generation.current++;
      busy.current = false;
      off();
      statusOff();
      clearInterval(timer);
      realtimeService.disconnect(`native-intent:${projectId}:${intentId}`);
    };
  }, [projectId, intentId, enabled, scope]);
  const visible = intent && loadedScope.current === scope;
  return {
    rows: visible ? rows : [],
    events: visible ? events : [],
    error: visible ? error : null,
    loading,
    observedAt: visible ? observedAt : null,
    now,
    replay,
  };
}
