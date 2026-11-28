import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('@/services/api', () => ({
  api: { get: (...args: unknown[]) => get(...args) },
  ApiError: class ApiError extends Error {},
}));

import { workflowDetailQuery } from './authoringQueries';
import { queryClient } from './queryClient';
import type { FetchQueryOptions, QueryFunction } from '@tanstack/react-query';
type QueryOptions<T> = FetchQueryOptions<T, Error, T, any>;

const ctx = () => ({ signal: new AbortController().signal });

async function runFetcher<T>(query: QueryOptions<T>) {
  const fetchCtx = ctx();
  const data = await (query.queryFn as QueryFunction<T, any>)({
    ...fetchCtx,
    queryKey: query.queryKey,
    client: queryClient,
    meta: undefined,
  });
  return { data, fetchCtx };
}

beforeEach(() => {
  get.mockReset();
  queryClient.clear();
});

describe('authoring query factories', () => {
  it.each([
    [
      'workflow detail',
      workflowDetailQuery('w1'),
      ['workflow', 'w1', 'detail', null],
      '/workflows/w1',
      { id: 'w1' },
      { id: 'w1' },
    ],
    [
      'pinned workflow detail',
      workflowDetailQuery('w1', 3),
      ['workflow', 'w1', 'detail', 3],
      '/workflows/w1?version=3',
      { id: 'w1' },
      { id: 'w1' },
    ],
  ])(
    '%s: key, request, signal/meta forwarding and stored shape',
    async (_, query, key, path, response, stored) => {
      expect(query.queryKey).toEqual(key);
      get.mockResolvedValue(response);
      const { data, fetchCtx } = await runFetcher(query as QueryOptions<unknown>);
      expect(get).toHaveBeenCalledWith(path, { signal: fetchCtx.signal });
      expect(data).toEqual(stored);
    },
  );

  it('treats version 0 like the live draft, as the service does', () => {
    expect(workflowDetailQuery('w1', 0).queryKey).toEqual(workflowDetailQuery('w1').queryKey);
    expect(workflowDetailQuery('w1', null).queryKey).toEqual(workflowDetailQuery('w1').queryKey);
  });
});
