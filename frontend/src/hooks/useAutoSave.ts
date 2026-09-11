import { useEffect, useMemo } from 'react';

interface UseAutoSaveOptions {
  interval?: number;
  maxWait?: number;
  enabled?: boolean;
  /** Hydration/remote updates should not make a collaborative editor dirty. */
  skipInitial?: boolean;
  /** Give a different document its own save queue and deduplication state. */
  resetKey?: unknown;
}

class SaveQueue<T> {
  getData: () => T | null;
  onSave: (data: T) => Promise<void>;
  interval = 2000;
  maxWait = 10_000;
  enabled = true;
  disposed = false;
  revision = 0;
  savedRevision = 0;
  firstDirtyAt: number | null = null;
  lastSaved: string | null = null;
  running: Promise<void> | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  failures = 0;
  previousDeps: readonly unknown[] | null = null;

  constructor(getData: () => T | null, onSave: (data: T) => Promise<void>) {
    this.getData = getData;
    this.onSave = onSave;
  }

  cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(retry = false) {
    this.cancelTimer();
    if (!this.enabled || this.disposed || this.savedRevision >= this.revision) return;
    const remaining = Math.max(0, this.maxWait - (Date.now() - (this.firstDirtyAt ?? Date.now())));
    const delay = retry
      ? Math.min(1000 * 2 ** Math.min(this.failures, 5), 30_000) * (0.5 + Math.random() * 0.5)
      : Math.min(this.interval, remaining);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => console.error('[useAutoSave] save failed:', error));
    }, delay);
  }

  changed() {
    this.revision++;
    this.firstDirtyAt ??= Date.now();
    this.schedule();
  }

  flush = async (): Promise<void> => {
    this.cancelTimer();
    const requiredRevision = this.revision;
    try {
      while (this.savedRevision < requiredRevision) {
        if (this.running) {
          await this.running;
          continue;
        }
        const data = this.getData();
        if (data === null) throw new Error('Save data is not ready');
        const revision = this.revision;
        const snapshot = JSON.stringify(data);
        const save = this.onSave;
        this.running = (async () => {
          if (snapshot !== this.lastSaved) await save(data);
          this.lastSaved = snapshot;
          this.savedRevision = revision;
          this.failures = 0;
          if (this.savedRevision === this.revision) this.firstDirtyAt = null;
        })().finally(() => {
          this.running = null;
        });
        await this.running;
      }
    } catch (error) {
      this.failures++;
      this.schedule(true);
      throw error;
    }
    this.schedule();
  };
}

/**
 * Serialize saves, retry failures, and flush the revision requested by callers.
 * Navigation/unload is best-effort; durable Yjs checkpoints do not rely on the
 * browser finishing an asynchronous request while its page is being closed.
 */
export function useAutoSave<T = Record<string, string>>(
  getData: () => T | null,
  onSave: (data: T) => Promise<void>,
  deps: readonly unknown[],
  options?: UseAutoSaveOptions,
) {
  const resetKey = options?.resetKey;
  // A new document needs an independent queue. Callbacks/configuration are
  // refreshed below without discarding an in-flight save on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queue = useMemo(() => new SaveQueue(getData, onSave), [resetKey]);
  const enabled = options?.enabled ?? true;
  const interval = options?.interval ?? 2000;
  const maxWait = options?.maxWait ?? 10_000;
  const skipInitial = options?.skipInitial ?? false;

  useEffect(() => {
    queue.getData = getData;
    queue.onSave = onSave;
    queue.interval = interval;
    queue.maxWait = maxWait;
  }, [queue, getData, onSave, interval, maxWait]);

  useEffect(() => {
    const initial = queue.previousDeps === null;
    const changed =
      initial || deps.some((value, index) => !Object.is(value, queue.previousDeps![index]));
    queue.previousDeps = [...deps];
    queue.enabled = enabled;
    if (changed && !(initial && skipInitial)) queue.changed();
    else queue.schedule();
    // The caller supplies the data-change dependencies, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, ...deps, enabled, skipInitial]);

  useEffect(() => {
    queue.disposed = false;
    const unload = () => {
      queue.flush().catch((error) => console.error('[useAutoSave] unload save failed:', error));
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      queue.disposed = true;
      queue.cancelTimer();
      window.removeEventListener('beforeunload', unload);
      queue.flush().catch((error) => console.error('[useAutoSave] navigation save failed:', error));
    };
  }, [queue]);

  return { flush: queue.flush };
}
