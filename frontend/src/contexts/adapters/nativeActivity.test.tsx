import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeActivity } from './nativeActivity';
import type { NativeIntentAdapter } from './nativeIntent';
import { ApiError } from '@/services/api';
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
    expect(state.outputs).toHaveBeenLastCalledWith('p1', 'i1', 65);
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
    await waitFor(() => expect(current.publicationFailure).toHaveBeenCalledWith(denial));
    expect(result.current.rows.map((r) => r.content)).toEqual(['Output 1.']);
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
});
