import { expect, it, vi } from 'vitest';
import { queryClient } from './queryClient';
import { foregroundNavigation, prefetchQuery } from './prefetch';

it('limits speculation to two requests and eight queued reads, honours Save-Data and cancels on navigation', async () => {
  const pending: (() => void)[] = [];
  let calls = 0;
  for (let i = 0; i < 12; i++)
    prefetchQuery(
      {
        queryKey: ['budget', i],
        queryFn: async () => {
          calls++;
          if (calls <= 2) await new Promise<void>((resolve) => pending.push(resolve));
          return i;
        },
      },
      { priority: 'intent' },
    );
  expect(calls).toBe(2);
  pending.forEach((resolve) => resolve());
  await vi.waitFor(() => expect(calls).toBe(10));

  const signals: AbortSignal[] = [];
  for (let i = 0; i < 3; i++)
    prefetchQuery(
      {
        queryKey: ['cancel', i],
        queryFn: ({ signal }) => {
          signals.push(signal);
          return new Promise<string>(() => {});
        },
      },
      { priority: 'intent' },
    );
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  foregroundNavigation();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(queryClient.isFetching()).toBe(0);
  const connection = Object.getOwnPropertyDescriptor(navigator, 'connection');
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
  const read = vi.fn(async () => 'not needed');
  prefetchQuery({ queryKey: ['save-data'], queryFn: read }, { priority: 'intent' });
  expect(read).not.toHaveBeenCalled();
  if (connection) Object.defineProperty(navigator, 'connection', connection);
  else Reflect.deleteProperty(navigator, 'connection');
});
