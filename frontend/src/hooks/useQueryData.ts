import { useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient, type QueryKey } from '@tanstack/react-query';

export function useQueryData<T>(key: QueryKey | null): T | undefined {
  const client = useQueryClient();
  const snapshot = () => (key ? client.getQueryData<T>(key) : undefined);
  return useSyncExternalStore(
    // The cache notifies synchronously, also while another component renders
    // (a query is created during its first render); batchCalls defers the
    // update the way TanStack's own hooks do.
    (notify) => client.getQueryCache().subscribe(notifyManager.batchCalls(notify)),
    snapshot,
    snapshot,
  );
}
