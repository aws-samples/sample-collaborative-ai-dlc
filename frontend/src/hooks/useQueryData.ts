import { useSyncExternalStore } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { queryClient as client } from '@/lib/queryClient';

export function useQueryData<T>(key: QueryKey | null): T | undefined {
  const snapshot = () => (key ? client.getQueryData<T>(key) : undefined);
  return useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    snapshot,
    snapshot,
  );
}
