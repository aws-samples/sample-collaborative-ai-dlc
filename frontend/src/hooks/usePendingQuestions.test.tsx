import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ApiError } from '@/services/api';
import type { PendingQuestion, PendingQuestionsPage } from '@/services/myWork';

const list = vi.fn();
vi.mock('@/services/myWork', () => ({
  myWorkService: { listPendingQuestions: (...a: unknown[]) => list(...a) },
}));

const auth = vi.hoisted(() => ({ user: { userId: 'u1' } as { userId: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

const realtime = vi.hoisted(() => ({
  handlers: new Set<(status: string) => void>(),
  status: 'connected',
}));
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onStatusChange: (handler: (status: string) => void) => {
      realtime.handlers.add(handler);
      handler(realtime.status);
      return () => realtime.handlers.delete(handler);
    },
  },
}));
const emitStatus = (status: string) => {
  realtime.status = status;
  for (const handler of realtime.handlers) handler(status);
};

import { usePendingQuestions } from './usePendingQuestions';

const item = (id: string): PendingQuestion =>
  ({ id, humanTaskId: id, projectId: 'p1', intentId: 'i1' }) as PendingQuestion;
const page = (ids: string[], over: Partial<PendingQuestionsPage> = {}): PendingQuestionsPage => ({
  items: ids.map(item),
  nextCursor: null,
  unavailable: [],
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => act(async () => {});
const setVisibility = (state: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });

describe('usePendingQuestions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    list.mockReset().mockResolvedValue(page([]));
    auth.user = { userId: 'u1' };
    realtime.handlers.clear();
    realtime.status = 'connected';
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the first page once on mount, despite the immediate status callback', async () => {
    list.mockResolvedValue(page(['a', 'b']));
    const { result } = renderHook(() => usePendingQuestions({}));
    expect(result.current.status).toBe('loading');
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ limit: 25, projectId: null, kinds: null });
    expect(result.current.status).toBe('ready');
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore appends using the cursor; refresh replaces the list', async () => {
    list.mockResolvedValueOnce(page(['a'], { nextCursor: 'c1' }));
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    expect(result.current.hasMore).toBe(true);
    list.mockResolvedValueOnce(page(['b']));
    act(() => result.current.loadMore());
    await flush();
    expect(list).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: 'c1',
      projectId: null,
      kinds: null,
    });
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);

    list.mockResolvedValueOnce(page(['z']));
    act(() => result.current.refresh());
    await flush();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, projectId: null, kinds: null });
    expect(result.current.items.map((i) => i.id)).toEqual(['z']);
  });

  it('refresh asks for as many items as are loaded, capped at 50', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `q${i}`);
    list.mockResolvedValueOnce(page(ids.slice(0, 30), { nextCursor: 'c' }));
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    act(() => result.current.refresh());
    expect(list).toHaveBeenLastCalledWith({ limit: 30, projectId: null, kinds: null });
    await flush();
    list.mockResolvedValueOnce(page(ids));
    act(() => result.current.refresh());
    await flush();
    act(() => result.current.refresh());
    expect(list).toHaveBeenLastCalledWith({ limit: 50, projectId: null, kinds: null });
    await flush();
  });

  it('a refresh during loadMore drops the loadMore response', async () => {
    list.mockResolvedValueOnce(page(['a'], { nextCursor: 'c1' }));
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    const more = deferred<PendingQuestionsPage>();
    list.mockReturnValueOnce(more.promise);
    act(() => result.current.loadMore());
    list.mockResolvedValueOnce(page(['fresh']));
    act(() => result.current.refresh());
    await flush();
    await act(async () => more.resolve(page(['stale'])));
    expect(result.current.items.map((i) => i.id)).toEqual(['fresh']);
  });

  it('a filter change resets at once and discards the in-flight response', async () => {
    const first = deferred<PendingQuestionsPage>();
    list.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook((props) => usePendingQuestions(props), {
      initialProps: { projectId: null as string | null },
    });
    list.mockResolvedValueOnce(page(['p2-item']));
    rerender({ projectId: 'p2' });
    expect(result.current.status).toBe('loading');
    await act(async () => first.resolve(page(['all-item'])));
    await flush();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, projectId: 'p2', kinds: null });
    expect(result.current.items.map((i) => i.id)).toEqual(['p2-item']);
  });

  it('passes kinds and resets when they change', async () => {
    list.mockResolvedValueOnce(page(['q']));
    const { result, rerender } = renderHook((props) => usePendingQuestions(props), {
      initialProps: { kinds: ['question'] as ('question' | 'approval')[] | null },
    });
    await flush();
    expect(list).toHaveBeenLastCalledWith({ limit: 25, projectId: null, kinds: ['question'] });
    const next = deferred<PendingQuestionsPage>();
    list.mockReturnValueOnce(next.promise);
    rerender({ kinds: ['approval'] });
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('loading');
    await act(async () => next.resolve(page(['a'])));
    expect(result.current.items.map((i) => i.id)).toEqual(['a']);
  });

  it('an account change mid-request resets state and drops the old response', async () => {
    list.mockResolvedValueOnce(page(['u1-item']));
    const { result, rerender } = renderHook(() => usePendingQuestions({}));
    await flush();
    const stale = deferred<PendingQuestionsPage>();
    list.mockReturnValueOnce(stale.promise);
    act(() => result.current.refresh());
    auth.user = { userId: 'u2' };
    const fresh = deferred<PendingQuestionsPage>();
    list.mockReturnValueOnce(fresh.promise);
    rerender();
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('loading');
    await act(async () => stale.resolve(page(['u1-late'])));
    expect(result.current.items).toEqual([]);
    await act(async () => fresh.resolve(page(['u2-item'])));
    expect(result.current.items.map((i) => i.id)).toEqual(['u2-item']);
  });

  it('logout clears items and makes no request', async () => {
    list.mockResolvedValueOnce(page(['a']));
    const { result, rerender } = renderHook(() => usePendingQuestions({}));
    await flush();
    auth.user = null;
    rerender();
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('loading');
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not request while signed out', async () => {
    auth.user = null;
    renderHook(() => usePendingQuestions({}));
    await flush();
    expect(list).not.toHaveBeenCalled();
  });

  it('refreshes on focus, online and visibilitychange outside the 15 s TTL', async () => {
    renderHook(() => usePendingQuestions({}));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(15_000));
    window.dispatchEvent(new Event('focus'));
    expect(list).toHaveBeenCalledTimes(2);
    await flush();
    act(() => vi.advanceTimersByTime(15_000));
    window.dispatchEvent(new Event('online'));
    expect(list).toHaveBeenCalledTimes(3);
    await flush();
    act(() => vi.advanceTimersByTime(15_000));
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(list).toHaveBeenCalledTimes(3);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(list).toHaveBeenCalledTimes(4);
    await flush();
  });

  it('refreshes once on a real reconnect only', async () => {
    renderHook(() => usePendingQuestions({}));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    // connecting → connected without a drop is not a reconnect.
    act(() => emitStatus('connecting'));
    act(() => emitStatus('connected'));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => emitStatus('disconnected'));
    act(() => emitStatus('connecting'));
    expect(list).toHaveBeenCalledTimes(1);
    act(() => emitStatus('connected'));
    expect(list).toHaveBeenCalledTimes(2);
    await flush();
    act(() => emitStatus('connected'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('starts with a disconnected socket without fetching twice', async () => {
    realtime.status = 'disconnected';
    renderHook(() => usePendingQuestions({}));
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('polls every 60 s only while visible', async () => {
    renderHook(() => usePendingQuestions({}));
    await flush();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(list).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(list).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('a NOT_A_MEMBER 403 on a space filter clears items and reports accessLost', async () => {
    list.mockResolvedValueOnce(page(['a']));
    const { result, rerender } = renderHook((props) => usePendingQuestions(props), {
      initialProps: { projectId: 'p1' as string | null },
    });
    await flush();
    list.mockRejectedValueOnce(new ApiError(403, 'Not a project member', { code: 'NOT_A_MEMBER' }));
    act(() => result.current.refresh());
    await flush();
    expect(result.current.items).toEqual([]);
    expect(result.current.accessLost).toBe(true);
    expect(result.current.status).toBe('ready');
    rerender({ projectId: null });
    expect(result.current.accessLost).toBe(false);
  });

  it('reports other errors as status error', async () => {
    list.mockRejectedValueOnce(new ApiError(503, 'Could not load your spaces'));
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Could not load your spaces');
    expect(result.current.accessLost).toBe(false);
  });

  it('a failed poll keeps the loaded list and reports the error inline', async () => {
    list.mockResolvedValueOnce(page(['a', 'b'], { nextCursor: 'c1' }));
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    list.mockRejectedValueOnce(new ApiError(503, 'Service unavailable'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toBe('Service unavailable');

    list.mockResolvedValueOnce(page(['b']));
    act(() => result.current.refresh());
    await flush();
    expect(result.current.items.map((i) => i.id)).toEqual(['b']);
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('a failed refresh with nothing loaded is a page error', async () => {
    const { result } = renderHook(() => usePendingQuestions({}));
    await flush();
    expect(result.current.items).toEqual([]);
    list.mockRejectedValueOnce(new ApiError(503, 'Service unavailable'));
    act(() => result.current.refresh());
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.stale).toBe(false);
  });

  it('removes listeners and the poll on unmount', async () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => usePendingQuestions({}));
    await flush();
    unmount();
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(realtime.handlers.size).toBe(0);
    await act(async () => vi.advanceTimersByTime(180_000));
    window.dispatchEvent(new Event('focus'));
    expect(list).toHaveBeenCalledTimes(1);
    removeWindow.mockRestore();
    removeDocument.mockRestore();
  });
});
