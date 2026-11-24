import { hashKey, QueryCache, QueryClient, type Query, type QueryKey } from '@tanstack/react-query';
import { onUserCacheBound, onUserCacheEnded } from './persistentCache';

export type { FetchQueryOptions as QueryOptions, QueryKey } from '@tanstack/react-query';
const usage = new WeakMap<Query, { at: number; bytes: number }>();

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if ([403, 404, 410].includes((error as { status?: number }).status ?? 0))
          query.setState({ data: undefined, dataUpdatedAt: 0 });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 60_000,
        // One retry: a list that fails twice says so instead of spinning.
        retry: (failures, error) =>
          failures < 1 &&
          ![401, 403, 404, 410].includes((error as { status?: number }).status ?? 0),
        refetchOnWindowFocus: false,
      },
    },
  });
}

export const queryClient = createQueryClient();

export let querySessionOpen = true;
onUserCacheEnded(() => {
  querySessionOpen = false;
  queryClient.clear();
});
onUserCacheBound(() => {
  querySessionOpen = true;
});

export function boundQueryMemory(client: QueryClient): () => void {
  const cache = client.getQueryCache();
  let hidden = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trimming = false;
  const trim = () => {
    if (trimming) return;
    trimming = true;
    const inactive = cache
      .getAll()
      .filter(
        (q) =>
          !q.getObserversCount() &&
          q.state.fetchStatus === 'idle' &&
          (q.state.data !== undefined || q.state.error !== null),
      );
    inactive.sort((a, b) => (usage.get(a)?.at ?? 0) - (usage.get(b)?.at ?? 0));
    let bytes = inactive.reduce((sum, q) => sum + (usage.get(q)?.bytes ?? 0), 0);
    let count = inactive.length;
    for (const query of inactive) {
      if (count <= (hidden ? 50 : 150) && bytes <= (hidden ? 2 : 8) * 1024 * 1024) break;
      bytes -= usage.get(query)?.bytes ?? 0;
      count--;
      cache.remove(query);
    }
    trimming = false;
  };
  // Recency is the last cache event (data change, observer added or removed).
  // A fresh fetchQuery() hit emits none, so it does not count as a use.
  const unsubscribe = cache.subscribe((event) => {
    const { query } = event;
    if (event.type === 'removed') return;
    if (
      event.type !== 'updated' &&
      event.type !== 'observerAdded' &&
      event.type !== 'observerRemoved'
    )
      return;
    const previous = usage.get(query);
    // Measure only when the stored value changes, not on every fetch-state event.
    const changed =
      !previous ||
      (event.type === 'updated' && ['success', 'error', 'setState'].includes(event.action.type));
    usage.set(query, {
      at: Date.now(),
      bytes: changed
        ? JSON.stringify([query.state.data, query.state.error]).length
        : previous.bytes,
    });
    trim();
  });
  const visibility = () => {
    clearTimeout(timer);
    hidden = false;
    if (document.visibilityState === 'hidden')
      timer = setTimeout(() => {
        hidden = true;
        trim();
      }, 60_000);
  };
  document.addEventListener('visibilitychange', visibility);
  visibility();
  return () => {
    unsubscribe();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibility);
  };
}

export function inactiveQueryBytes(client: QueryClient): number {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => !query.getObserversCount() && query.state.fetchStatus === 'idle')
    .reduce((total, query) => total + (usage.get(query)?.bytes ?? 0), 0);
}

/** The size of the cached response for `key`, 0 when it is not cached. */
export const knownQueryBytes = (client: QueryClient, key: QueryKey): number => {
  const query = client.getQueryCache().get(hashKey(key));
  return query ? (usage.get(query)?.bytes ?? 0) : 0;
};

boundQueryMemory(queryClient);
