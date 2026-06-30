import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Fake realtimeService: a tiny event bus we can emit into. connect() records the
// channel + explicit scope target the hook passes.
const handlers = new Map<string, ((d: unknown) => void)[]>();
const connect = vi.fn();
const emit = (action: string, data: unknown) =>
  (handlers.get(action) ?? []).forEach((h) => h(data));
vi.mock('../services/realtime', () => ({
  realtimeService: {
    connect: (...a: unknown[]) => connect(...a),
    on: (action: string, handler: (d: unknown) => void) => {
      const list = handlers.get(action) ?? [];
      list.push(handler);
      handlers.set(action, list);
      return () =>
        handlers.set(
          action,
          (handlers.get(action) ?? []).filter((h) => h !== handler),
        );
    },
  },
}));

import { useIntentEvents, type IntentEvent } from './useIntentEvents';

describe('useIntentEvents', () => {
  beforeEach(() => {
    handlers.clear();
    connect.mockReset();
  });

  it('connects to the intent channel with an explicit {intentId,projectId} scope target', () => {
    renderHook(() => useIntentEvents('p1', 'i1', () => {}));
    expect(connect).toHaveBeenCalledWith('intent:i1', { intentId: 'i1', projectId: 'p1' });
  });

  it('forwards each agent.* event to the callback (consumer accumulates, D3)', () => {
    const events: IntentEvent[] = [];
    renderHook(() => useIntentEvents('p1', 'i1', (e) => events.push(e)));

    // Two distinct gates arrive — the hook forwards BOTH (it does not collapse;
    // the IntentView keeps a list keyed by humanTaskId).
    emit('agent.question', { intentId: 'i1', humanTaskId: 'h1', questions: '[]' });
    emit('agent.question', { intentId: 'i1', humanTaskId: 'h2', questions: '[]' });
    emit('agent.output', { intentId: 'i1', stageInstanceId: 'si1', content: 'chunk' });
    emit('agent.stage', { intentId: 'i1', state: 'RUNNING' });

    const questionIds = events
      .filter((e) => e.action === 'agent.question')
      .map((e) => e.humanTaskId);
    expect(questionIds).toEqual(['h1', 'h2']);
    expect(events.some((e) => e.action === 'agent.output' && e.content === 'chunk')).toBe(true);
    expect(events.some((e) => e.action === 'agent.stage')).toBe(true);
  });

  it('ignores events for a different intentId', () => {
    const events: IntentEvent[] = [];
    renderHook(() => useIntentEvents('p1', 'i1', (e) => events.push(e)));
    emit('agent.stage', { intentId: 'OTHER', state: 'RUNNING' });
    expect(events).toHaveLength(0);
  });

  it('does nothing without ids', () => {
    renderHook(() => useIntentEvents('', '', () => {}));
    expect(connect).not.toHaveBeenCalled();
  });
});
