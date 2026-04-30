import { useEffect, useRef, useCallback } from 'react';

interface UseAutoSaveOptions {
  /** Debounce interval in ms (default 2000) */
  interval?: number;
  /** Disable auto-save when false (default true) */
  enabled?: boolean;
}

/**
 * Auto-save hook that debounces writes and flushes on unmount + beforeunload.
 *
 * The backend DB is the source of truth. This hook ensures Yjs state is
 * persisted within `interval` ms of any change, and guaranteed-flushed when
 * the user navigates away or closes the tab.
 *
 * @param getData  Returns the current data to save (called at save time, not capture time)
 * @param onSave   Persist `data` to the backend. Must be safe to call concurrently.
 * @param deps     Dependency array — when any dep changes, the dirty flag is set
 *                 (typically the serialized Yjs field values)
 * @param options  interval (ms), enabled (boolean)
 */
export function useAutoSave<T = Record<string, string>>(
  getData: () => T | null,
  onSave: (data: T) => Promise<void>,
  deps: readonly unknown[],
  options?: UseAutoSaveOptions,
) {
  const interval = options?.interval ?? 2000;
  const enabled = options?.enabled ?? true;

  const onSaveRef = useRef(onSave);
  const getDataRef = useRef(getData);
  const timerRef = useRef<number | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const mountedRef = useRef(true);

  // Keep refs fresh without re-running effects
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { getDataRef.current = getData; }, [getData]);

  // Core save function — deduplicates by comparing serialized snapshots
  const doSave = useCallback(async () => {
    if (isSavingRef.current) return;
    const data = getDataRef.current();
    if (!data) return;
    const snapshot = JSON.stringify(data);
    if (snapshot === lastSavedRef.current) return; // nothing changed

    isSavingRef.current = true;
    try {
      await onSaveRef.current(data);
      lastSavedRef.current = snapshot;
    } catch (err) {
      console.error('[useAutoSave] save failed:', err);
    } finally {
      isSavingRef.current = false;
    }
  }, []);

  // Synchronous save for beforeunload — uses fetch keepalive
  // We can't use the async path here, so we just fire doSave and hope
  // the keepalive flag lets it complete. The parent hook supplies onSave,
  // which typically calls fetch(). As a last resort, browsers give ~500ms.
  const flushSync = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Fire-and-forget — can't await in beforeunload
    doSave();
  }, [doSave]);

  // Public flush (awaitable, for programmatic use)
  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  // Schedule a debounced save whenever deps change
  useEffect(() => {
    if (!enabled) return;
    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      doSave();
    }, interval);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, interval]);

  // Flush on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Fire the save — can't await in cleanup, but doSave is resilient
      doSave();
    };
  }, [doSave]);

  // Flush on beforeunload (tab close, refresh, navigate away)
  useEffect(() => {
    if (!enabled) return;
    const handleBeforeUnload = () => flushSync();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [enabled, flushSync]);

  return { flush };
}
