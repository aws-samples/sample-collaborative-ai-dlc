// Cached reads for authoring. Pages build their queries here so every reader
// of one record hits one cache entry. The services stay the raw fetchers;
// their writes invalidate these keys.

import { queryOptions, type QueryFunction, type QueryKey } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { workflowsService } from '@/services/workflows';

// Lists and records are kept 5 min once unused; block contents get the default.
const read = <T, K extends QueryKey>(
  queryKey: K,
  queryFn: QueryFunction<T, K>,
  { staleTime = 30_000, gcTime }: { staleTime?: number; gcTime?: number } = {},
) => queryOptions({ queryKey, queryFn, staleTime, ...(gcTime ? { gcTime } : {}) });

const KEEP = 5 * 60_000;

export const workflowDetailQuery = (workflowId: string, version?: number | null) =>
  read(
    qk.workflowDetail(workflowId, version),
    ({ signal }) => workflowsService.get(workflowId, version ?? undefined, { signal }),
    { gcTime: KEEP },
  );
