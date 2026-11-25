import { act, renderHook } from '@/test/query';
import { expect, it } from 'vitest';
import { queryClient } from '@/lib/queryClient';
import { useQueryData } from './useQueryData';

it('watches writes and eviction without creating or retaining a query', async () => {
  const { result } = renderHook(() => useQueryData<string>(['pill']));
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  await act(async () => {
    queryClient.setQueryData(['pill'], 'running');
  });
  expect(result.current).toBe('running');
  expect(
    queryClient
      .getQueryCache()
      .find({ queryKey: ['pill'] })
      ?.getObserversCount(),
  ).toBe(0);
  await act(async () => {
    queryClient.removeQueries({ queryKey: ['pill'] });
  });
  expect(result.current).toBeUndefined();
});
