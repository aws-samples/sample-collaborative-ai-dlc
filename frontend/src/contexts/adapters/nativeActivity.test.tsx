import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeActivity } from './nativeActivity';
import type { NativeIntentAdapter } from './nativeIntent';
import { ApiError } from '@/services/api';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
const state = vi.hoisted(() => ({
  outputs: vi.fn(),
  handlers: new Map<string, (value: any) => void>(),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(),
}));
vi.mock('@/services/nativeIntents', () => ({ nativeIntentsService: { outputs: state.outputs } }));
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    connect: state.connect,
    disconnect: state.disconnect,
    on: (name: string, handler: (value: any) => void) => {
      state.handlers.set(name, handler);
      return () => state.handlers.delete(name);
    },
    onStatusChange: (handler: (value: any) => void) => {
      state.handlers.set('status', handler);
      return () => state.handlers.delete('status');
    },
  },
}));
const adapter = (intentId = 'i1') =>
  ({
    projectId: 'p1',
    intentId,
    intent: { id: intentId },
    publicationFailure: vi.fn(),
  }) as unknown as NativeIntentAdapter;
const row = (seq: number) => ({
  seq,
  kind: 'stdout',
  stageInstanceId: null,
  content: `Output ${seq}.`,
  timestamp: '2026-10-01T00:00:00Z',
});
beforeEach(() => {
  resetSessionExpiry();
  vi.clearAllMocks();
  state.handlers.clear();
  state.outputs.mockResolvedValue({ outputs: [], nextAfter: null });
});
describe('native durable transcript adapter', () => {
  it('replays more than 64 rows and catches up on reconnect without duplicates', async () => {
    state.outputs
      .mockResolvedValueOnce({
        outputs: Array.from({ length: 64 }, (_, i) => row(i + 1)),
        nextAfter: 64,
      })
      .mockResolvedValueOnce({ outputs: [row(65)], nextAfter: null });
    const current = adapter();
    const { result } = renderHook(() => useNativeActivity(current));
    await waitFor(() => expect(result.current.rows).toHaveLength(65));
    state.outputs.mockResolvedValueOnce({ outputs: [row(66)], nextAfter: null });
    act(() => state.handlers.get('status')?.('connected'));
    await waitFor(() => expect(result.current.rows).toHaveLength(66));
    expect(state.outputs).toHaveBeenLastCalledWith('p1', 'i1', 65, 0);
  });
  it('does not render a new event after revocation on an already-connected socket', async () => {
    state.outputs.mockResolvedValueOnce({ outputs: [row(1)], nextAfter: null });
    const current = adapter();
    const { result, rerender } = renderHook(({ value }) => useNativeActivity(value), {
      initialProps: { value: current },
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(state.connect).toHaveBeenCalled();
    const denial = new ApiError(403, 'Forbidden', { error: 'Forbidden' });
    state.outputs.mockRejectedValueOnce(denial);
    act(() =>
      state.handlers.get('agent.output')?.({
        executionBackend: 'native',
        projectId: 'p1',
        intentId: 'i1',
        seq: 2,
        content: 'Must never render socket content',
      }),
    );
    await waitFor(() => expect(result.current.error).toContain('Activity could not be refreshed'));
    expect(current.publicationFailure).not.toHaveBeenCalled();
    expect(result.current.rows).toEqual([]);
    rerender({ value: { ...current, intent: null } });
    expect(result.current.rows).toEqual([]);
    expect(state.disconnect).toHaveBeenCalledWith('native-intent:p1:i1');
  });
  it('ignores old run responses and foreign project invalidations', async () => {
    let finish!: (value: any) => void;
    state.outputs.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ value }) => useNativeActivity(value), {
      initialProps: { value: adapter() },
    });
    await waitFor(() => expect(state.outputs).toHaveBeenCalledTimes(1));
    rerender({ value: adapter('i2') });
    expect(state.disconnect).toHaveBeenCalledWith('native-intent:p1:i1');
    await act(async () => finish({ outputs: [row(1)], nextAfter: null }));
    expect(result.current.rows).toEqual([]);
    const calls = state.outputs.mock.calls.length;
    act(() =>
      state.handlers.get('agent.output')?.({
        executionBackend: 'native',
        projectId: 'foreign',
        intentId: 'i2',
      }),
    );
    expect(state.outputs).toHaveBeenCalledTimes(calls);
  });
  it('recovers lost notifications and a failed middle page without duplicate rows or events', async () => {
    const event = (revision: number) => ({
      revision,
      eventId: `native-${revision}`,
      summary: `Fact ${revision}`,
    });
    const outputs = Array.from({ length: 147 }, (_, i) => row(i + 1));
    const events = Array.from({ length: 135 }, (_, i) => event((i + 1) * 2));
    let failPage = true;
    state.outputs.mockImplementation(async (_p, _i, after, afterEvent) => {
      if (after === 64 && failPage) {
        failPage = false;
        throw new Error('Read unavailable');
      }
      const remaining = outputs.filter((r) => r.seq > after);
      const remainingEvents = events.filter((e) => e.revision > afterEvent);
      return {
        outputs: remaining.slice(0, 64),
        nextAfter: remaining.length > 64 ? remaining[63].seq : null,
        events: remainingEvents.slice(0, 64),
        nextEventAfter: remainingEvents.length > 64 ? remainingEvents[63].revision : null,
      };
    });
    const current = adapter();
    const { result } = renderHook(() => useNativeActivity(current));
    await waitFor(() => expect(result.current.error).toContain('incomplete'));
    expect(result.current.rows).toHaveLength(64);
    await act(async () => {
      await result.current.replay();
    });
    expect(result.current.rows.map((r) => r.seq)).toEqual(outputs.map((r) => r.seq));
    expect(result.current.events.map((e) => e.revision)).toEqual(events.map((e) => e.revision));
    expect(result.current.error).toBe(null);
    // No notification: the periodic reader still discovers the next durable row.
    vi.useFakeTimers();
    try {
      outputs.push(row(148));
      await act(async () => {
        state.handlers.get('status')?.('connected');
      });
      expect(result.current.rows).toHaveLength(148);
      await act(async () => {
        state.handlers.get('status')?.('connected');
      });
      expect(result.current.rows).toHaveLength(148);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls durable history when every notification is lost', async () => {
    const current = adapter();
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useNativeActivity(current));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      state.outputs.mockResolvedValueOnce({ outputs: [row(1)], nextAfter: null });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.rows.map((r) => r.seq)).toEqual([1]);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches project and identity callbacks and ignores delayed pages after token expiry', async () => {
    let finish!: (value: any) => void;
    state.outputs.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ value }) => useNativeActivity(value), {
      initialProps: { value: adapter() },
    });
    const oldHandler = state.handlers.get('agent.output');
    rerender({ value: { ...adapter(), projectId: 'p2' } });
    await waitFor(() => expect(state.outputs).toHaveBeenCalledTimes(2));
    const calls = state.outputs.mock.calls.length;
    await act(async () =>
      oldHandler?.({ executionBackend: 'native', projectId: 'p1', intentId: 'i1' }),
    );
    expect(state.outputs).toHaveBeenCalledTimes(calls);
    await act(async () => {
      finish({ outputs: [row(1)], nextAfter: null });
    });
    expect(result.current.rows).toEqual([]);
    state.outputs.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => {
      void result.current.replay();
    });
    act(() => notifySessionExpired());
    await act(async () => {
      finish({ outputs: [row(2)], nextAfter: null });
    });
    rerender({ value: { ...adapter(), projectId: 'p2', intent: null } });
    expect(result.current.rows).toEqual([]);
    expect(state.disconnect).toHaveBeenCalledWith('native-intent:p2:i1');
  });
});
