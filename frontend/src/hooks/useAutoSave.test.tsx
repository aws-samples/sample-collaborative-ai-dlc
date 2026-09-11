import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoSave } from './useAutoSave';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('skips hydration, saves explicit clears, and separates document queues', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value, revision, id }) =>
        useAutoSave(() => value, save, [revision], { skipInitial: true, resetKey: id }),
      { initialProps: { value: 'hydrated', revision: 0, id: 'a' } },
    );
    await advance(3000);
    expect(save).not.toHaveBeenCalled();
    rerender({ value: '', revision: 1, id: 'a' });
    await advance(2000);
    expect(save).toHaveBeenLastCalledWith('');
    rerender({ value: 'other document', revision: 0, id: 'b' });
    await advance(3000);
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('saves continuous edits by the maximum wait deadline', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ revision }) => useAutoSave(() => revision, save, [revision], { skipInitial: true }),
      { initialProps: { revision: 0 } },
    );
    for (let revision = 1; revision <= 10; revision++) {
      rerender({ revision });
      await advance(1000);
    }
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(10);
    unmount();
  });

  it('serializes a flush with edits that arrived during an in-flight save', async () => {
    const first = deferred();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useAutoSave(() => value, save, [value], { skipInitial: true }),
      { initialProps: { value: 'initial' } },
    );
    rerender({ value: 'first' });
    await advance(2000);
    rerender({ value: 'second' });
    let completed = false;
    const flush = result.current.flush().then(() => {
      completed = true;
    });
    await advance(2000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    await act(async () => {
      first.resolve();
      await flush;
    });
    expect(save.mock.calls.map(([value]) => value)).toEqual(['first', 'second']);
    expect(completed).toBe(true);
    unmount();
  });

  it('retries failed saves without requiring another edit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn().mockRejectedValueOnce(new Error('Throttled')).mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutoSave(() => value, save, [value], { skipInitial: true }),
      { initialProps: { value: 'initial' } },
    );
    rerender({ value: 'dirty' });
    await advance(2000);
    expect(save).toHaveBeenCalledTimes(1);
    await advance(2100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('dirty');
    unmount();
  });

  it('retains local changes made while automatic saving is disabled', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ revision, enabled }) =>
        useAutoSave(() => revision, save, [revision], { skipInitial: true, enabled }),
      { initialProps: { revision: 0, enabled: false } },
    );
    rerender({ revision: 1, enabled: false });
    await advance(3000);
    expect(save).not.toHaveBeenCalled();
    rerender({ revision: 1, enabled: true });
    await advance(2000);
    expect(save).toHaveBeenCalledWith(1);
    unmount();
  });

  it('does not report an explicit flush as successful while dirty data is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender, unmount } = renderHook(
      ({ revision }) =>
        useAutoSave(() => null, save, [revision], { skipInitial: true, enabled: false }),
      { initialProps: { revision: 0 } },
    );
    rerender({ revision: 1 });
    await expect(result.current.flush()).rejects.toThrow('not ready');
    expect(save).not.toHaveBeenCalled();
    unmount();
  });
});
