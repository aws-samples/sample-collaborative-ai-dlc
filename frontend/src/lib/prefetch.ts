import { hashKey, type FetchQueryOptions, type QueryKey } from '@tanstack/react-query';
import { inactiveQueryBytes, queryClient, querySessionOpen } from './queryClient';
import { onUserCacheEnded } from './persistentCache';

type Task = {
  hash: string;
  key: QueryKey;
  priority: 'intent' | 'idle';
  ready: boolean;
  cancelIdle?: () => void;
  notify: () => void;
  run: () => Promise<void>;
};
let queue: Task[] = [];
const running = new Map<string, Task>();
let wake: ReturnType<typeof setTimeout> | undefined;
let quietUntil = 0;

export function canPreloadOnHover(): boolean {
  const network = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  return (
    querySessionOpen &&
    !network?.saveData &&
    !/(^|-)2g$/.test(network?.effectiveType ?? '') &&
    !window.matchMedia?.('(prefers-reduced-data: reduce)').matches
  );
}

export function canPrefetchAtIdle(): boolean {
  return (
    canPreloadOnHover() &&
    document.visibilityState !== 'hidden' &&
    ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) > 2 &&
    inactiveQueryBytes(queryClient) <= 4 * 1024 * 1024
  );
}

function onIdle(run: () => void): () => void {
  if (window.requestIdleCallback) {
    const id = window.requestIdleCallback(run, { timeout: 2_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(run, 2_000);
  return () => clearTimeout(id);
}

function pump(): void {
  if (!queue.length) return;
  if (!canPreloadOnHover()) {
    queue = [];
    return;
  }
  if (document.visibilityState === 'hidden') return;
  // Only idle work waits for foreground quiet; hover/press warming does not.
  const quiet = !queryClient.isFetching({ type: 'active' }) && Date.now() >= quietUntil;
  while (running.size < 2 && queue.length) {
    if (!queue[0].ready) return;
    if (queue[0].priority === 'idle' && !quiet) {
      clearTimeout(wake);
      wake = setTimeout(pump, 300);
      return;
    }
    const task = queue.shift()!;
    if (task.priority === 'idle' && !canPrefetchAtIdle()) continue;
    running.set(task.hash, task);
    void task
      .run()
      .catch(() => {})
      .finally(() => {
        if (running.get(task.hash) === task) running.delete(task.hash);
        pump();
      });
  }
}

export function prefetchQuery<T, K extends QueryKey>(
  options: FetchQueryOptions<T, Error, T, K>,
  { priority = 'idle', onData }: { priority?: 'intent' | 'idle'; onData?: (data: T) => void } = {},
): void {
  if (!canPreloadOnHover()) return;
  const hash = hashKey(options.queryKey);
  const task: Task = {
    hash,
    key: options.queryKey,
    priority,
    ready: priority === 'intent',
    notify: () => {
      const state = queryClient.getQueryState<T>(options.queryKey);
      if (
        querySessionOpen &&
        state?.status === 'success' &&
        !state.isInvalidated &&
        state.data !== undefined
      )
        onData?.(state.data);
    },
    run: async () => {
      await queryClient.prefetchQuery(options);
      if (running.get(hash) === task) task.notify();
    },
  };
  const existing = running.get(hash) ?? queue.find((queued) => queued.hash === hash);
  if (existing) {
    if (priority === 'intent') {
      existing.priority = priority;
      existing.ready = true;
      existing.cancelIdle?.();
      if (onData) existing.notify = task.notify;
      if (!running.has(hash)) {
        queue = queue.filter((queued) => queued !== existing);
        queue.unshift(existing);
      }
      pump();
    }
    return;
  }
  if (queue.length === 8) queue.pop()?.cancelIdle?.();
  if (priority === 'intent') queue.unshift(task);
  else queue.push(task);
  if (priority === 'idle')
    task.cancelIdle = onIdle(() => {
      task.ready = true;
      pump();
    });
  else pump();
}

export function cancelPrefetch(hash: string): boolean {
  const length = queue.length;
  queue = queue.filter((task) => {
    if (task.hash !== hash) return true;
    task.cancelIdle?.();
    return false;
  });
  return length !== queue.length;
}

export function foregroundNavigation(keep: ReadonlySet<string> = new Set(), quietMs = 300): void {
  quietUntil = quietMs ? Date.now() + quietMs : 0;
  queue = queue.filter((task) => {
    if (keep.has(task.hash)) return true;
    task.cancelIdle?.();
    return false;
  });
  for (const [hash, task] of running) {
    if (keep.has(hash)) continue;
    void queryClient.cancelQueries({ queryKey: task.key, exact: true, type: 'inactive' });
    running.delete(hash);
  }
  clearTimeout(wake);
  if (queue.length) wake = setTimeout(pump, 300);
}

onUserCacheEnded(() => foregroundNavigation());
document.addEventListener('visibilitychange', pump);
