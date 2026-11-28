import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/test/query';
import { useVisiblePoll } from './useVisiblePoll';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.useRealTimers();
});

describe('useVisiblePoll', () => {
  it('polls on the interval while visible', async () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePoll(fn, 1_000));
    await tick(999);
    expect(fn).not.toHaveBeenCalled();
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs immediately when asked', async () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePoll(fn, 1_000, { immediate: true }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops while hidden and runs once on return when stale', async () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePoll(fn, 1_000));
    await tick(1_000);
    expect(fn).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await tick(10_000);
    expect(fn).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not run on return when the last run is still fresh', async () => {
    const fn = vi.fn();
    renderHook(() => useVisiblePoll(fn, 1_000, { runOnVisibleIfStaleMs: 5_000 }));
    await tick(1_000);
    setVisibility('hidden');
    await tick(2_000);
    setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not start while mounted hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const fn = vi.fn();
    renderHook(() => useVisiblePoll(fn, 1_000, { immediate: true }));
    await tick(5_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('null interval disables polling', async () => {
    const fn = vi.fn();
    const { rerender } = renderHook(({ ms }) => useVisiblePoll(fn, ms), {
      initialProps: { ms: 1_000 as number | null },
    });
    rerender({ ms: null });
    await tick(5_000);
    setVisibility('hidden');
    setVisibility('visible');
    expect(fn).not.toHaveBeenCalled();
  });

  it('never overlaps a slow async call', async () => {
    let resolve!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        }),
    );
    renderHook(() => useVisiblePoll(fn, 1_000));
    await tick(1_000);
    await tick(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
    resolve();
    await tick(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls the latest fn and cleans up on unmount', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { rerender, unmount } = renderHook(({ fn }) => useVisiblePoll(fn, 1_000), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    await tick(1_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    await tick(5_000);
    setVisibility('visible');
    expect(second).toHaveBeenCalledTimes(1);
    removeSpy.mockRestore();
  });
});
