import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  prefetchHref: vi.fn(),
  preloadHref: vi.fn(),
  hrefWantsData: vi.fn((_href: string, _user: unknown) => true),
}));
vi.mock('@/lib/routePrefetch', () => route);

import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import { offerIdleCandidates } from '@/lib/idleCandidates';
import { startIdleNext as start } from './useIdleNext';

const member = { isPlatformAdmin: false };
const IDLE = 2_000;
const withdraw: (() => void)[] = [];
const offer = (source: 'page' | 'shell', hrefs: string[]) =>
  withdraw.push(offerIdleCandidates(source, hrefs));
const visits: (() => void)[] = [];
const startIdleNext = (href: string, user: { isPlatformAdmin: boolean }) => {
  const cancel = start(href, user);
  visits.push(cancel);
  return cancel;
};
const dataHrefs = () => route.prefetchHref.mock.calls.map(([href]) => href);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  route.hrefWantsData.mockImplementation(() => true);
  queryClient.clear();
});
afterEach(() => {
  for (const cancel of visits.splice(0)) cancel();
  for (const cancel of withdraw.splice(0)) cancel();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  queryClient.clear();
});

describe('idle next page', () => {
  it('waits for the page critical reads, then warms at most two targets with data', () => {
    let resolve!: (value: unknown) => void;
    void queryClient.fetchQuery({
      queryKey: qk.projectIntents('p1'),
      queryFn: () => new Promise((done) => (resolve = done)),
    });
    offer('shell', ['/space/p1/intent/a', '/space/p1/intent/b', '/space/p2/intent/c']);
    startIdleNext('/space/p1', member);
    vi.advanceTimersByTime(IDLE * 2);
    expect(route.prefetchHref).not.toHaveBeenCalled();

    resolve([]);
    return vi.waitFor(() => {
      vi.advanceTimersByTime(IDLE);
      expect(dataHrefs()).toEqual(['/space/p1/intent/a', '/space/p1/intent/b']);
      expect(route.prefetchHref.mock.calls[0][1]).toEqual(
        expect.objectContaining({ trigger: 'idle', currentHref: '/space/p1' }),
      );
      // The third target gets code only.
      expect(route.preloadHref).toHaveBeenCalledExactlyOnceWith('/space/p2/intent/c', member);
    });
  });

  it('runs once per visit: re-offering the same rows (polls) warms nothing again', () => {
    offer('shell', ['/space/p1/intent/a']);
    startIdleNext('/dashboard', member);
    vi.advanceTimersByTime(IDLE);
    expect(dataHrefs()).toEqual(['/space/p1/intent/a']);
    offer('shell', ['/space/p1/intent/a']);
    vi.advanceTimersByTime(IDLE);
    expect(dataHrefs()).toEqual(['/space/p1/intent/a']);
    // A row that appears later joins the same visit, within the cap.
    offer('shell', ['/space/p1/intent/b']);
    vi.advanceTimersByTime(IDLE);
    expect(dataHrefs()).toEqual(['/space/p1/intent/a', '/space/p1/intent/b']);
  });

  it('counts only targets that would read data against the data cap', () => {
    route.hrefWantsData.mockImplementation((href: string) => href !== '/graph');
    offer('shell', ['/graph', '/x', '/y']);
    startIdleNext('/dashboard', member);
    vi.advanceTimersByTime(IDLE);
    expect(dataHrefs()).toEqual(['/x', '/y']);
    expect(route.preloadHref).toHaveBeenCalledExactlyOnceWith('/graph', member);
  });

  it.each([
    [
      'Save-Data',
      () =>
        Object.defineProperty(navigator, 'connection', {
          value: { saveData: true },
          configurable: true,
        }),
    ],
    [
      'a hidden tab',
      () =>
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }),
    ],
    [
      'more than half of the cache budget',
      () => {
        queryClient.setQueryData(['memory-pressure'], 'x'.repeat(4.1 * 1024 * 1024));
      },
    ],
  ])('is skipped under %s', (_, gate) => {
    offer('shell', ['/space/p1/intent/a']);
    gate();
    startIdleNext('/dashboard', member);
    vi.advanceTimersByTime(IDLE);
    expect(route.prefetchHref).not.toHaveBeenCalled();
    expect(route.preloadHref).not.toHaveBeenCalled();
  });

  it('does nothing on an admin page for a member, and stops when the visit ends', () => {
    offer('shell', ['/space/p1/intent/a']);
    startIdleNext('/workflows', member);
    const cancel = startIdleNext('/dashboard', member);
    cancel();
    vi.advanceTimersByTime(IDLE);
    expect(route.prefetchHref).not.toHaveBeenCalled();
  });
});
