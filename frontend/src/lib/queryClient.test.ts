import { expect, it, vi } from 'vitest';
import { isCancelledError, QueryObserver } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { endUserCache } from './persistentCache';

it.each(['logout', 'user-switch', 'session-expired'] as const)(
  '%s drops old-session responses',
  async (reason) => {
    let resolve!: (data: string) => void;
    const pending = queryClient
      .fetchQuery({
        queryKey: ['private'],
        queryFn: () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      })
      .catch((error: unknown) => error);
    queryClient.setQueryData(['cached'], 'old user');
    endUserCache(reason);
    expect(isCancelledError(await pending)).toBe(true);
    expect(queryClient.getQueryData(['cached'])).toBeUndefined();
    queryClient.setQueryData(['private'], 'new user');
    resolve('old response');
    await Promise.resolve();
    expect(queryClient.getQueryData(['private'])).toBe('new user');
  },
);

it('bounds inactive queries by count and size, trims after 60 s hidden, and preserves observed data', () => {
  vi.useFakeTimers();
  queryClient.setDefaultOptions({ queries: { gcTime: Infinity, retry: false } });
  const observer = new QueryObserver(queryClient, { queryKey: ['observed'], enabled: false });
  const release = observer.subscribe(() => {});
  queryClient.setQueryData(['observed'], 'visible');
  for (let i = 0; i < 151; i++) {
    vi.setSystemTime(i + 1);
    queryClient.setQueryData(['inactive', i], i);
  }
  expect(queryClient.getQueryData(['inactive', 0])).toBeUndefined();
  expect(queryClient.getQueryCache().getAll()).toHaveLength(151);
  queryClient.setQueryData(['oversized'], 'x'.repeat(9 * 1024 * 1024));
  expect(queryClient.getQueryData(['oversized'])).toBeUndefined();
  for (let i = 0; i < 100; i++) queryClient.setQueryData(['hidden', i], i);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(59_999);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(101);
  vi.advanceTimersByTime(1);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(51);
  expect(queryClient.getQueryData(['observed'])).toBe('visible');
  release();
  visibility.mockRestore();
  vi.useRealTimers();
});

it.each([403, 404, 410])(
  'a %s drops the stored value instead of showing it with the error',
  async (status) => {
    queryClient.setQueryData(['entity'], 'visible before');
    await queryClient
      .fetchQuery({ queryKey: ['entity'], staleTime: 0, queryFn: () => Promise.reject({ status }) })
      .catch(() => undefined);
    expect(queryClient.getQueryData(['entity'])).toBeUndefined();
  },
);
