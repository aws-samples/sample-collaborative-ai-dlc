import type { QueryKey } from '@tanstack/react-query';
import { queryClient } from './queryClient';

/**
 * Marks every cached view under `prefixes` stale once a read changed it
 * (`invalidateQueries`) and supersedes reads that started before it: a read
 * in flight is cancelled and restarted, so its waiters get post-write data.
 */
export function refreshAfterWrite(...prefixes: QueryKey[]): void {
  for (const queryKey of prefixes) {
    const pending = queryClient.getQueryCache().findAll({ queryKey, fetchStatus: 'fetching' });
    void queryClient.cancelQueries({ queryKey }, { silent: true });
    void queryClient.invalidateQueries({ queryKey });
    for (const query of pending)
      void queryClient
        .fetchQuery({ ...query.options, queryKey: query.queryKey, staleTime: 0 })
        .catch(() => {});
  }
}

/** Runs a write, then refreshes `prefixes`. A failed write may still have been applied. */
export const afterWrite = <T>(write: Promise<T>, ...prefixes: QueryKey[]): Promise<T> =>
  write.finally(() => refreshAfterWrite(...prefixes));
