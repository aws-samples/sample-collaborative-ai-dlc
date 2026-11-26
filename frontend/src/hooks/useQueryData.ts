import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

export function useQueryData<T>(key: QueryKey | null): T | undefined {
  const client = useQueryClient();
  const snapshot = () => (key ? client.getQueryData<T>(key) : undefined);
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    snapshot,
    snapshot,
  );
}
