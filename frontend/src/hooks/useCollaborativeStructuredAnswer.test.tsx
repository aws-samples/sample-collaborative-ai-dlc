// The structured-answer hook forwards the transport's live-collaboration
// verdict so the question card can say WHY its options are locked (and offer
// a retry) instead of silently greying them out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@/test/query';
import * as Y from 'yjs';

const transport = vi.hoisted(() => ({
  doc: null as unknown as Y.Doc,
  connection: 'synced' as 'connecting' | 'synced' | 'unavailable',
  retryNow: vi.fn(),
}));

vi.mock('./useYjsDocument', () => ({
  useYjsDocument: () => ({
    doc: transport.doc,
    synced: transport.connection === 'synced',
    connection: transport.connection,
    retryNow: transport.retryNow,
    awareness: {},
    remoteUsers: new Map(),
    setCursor: vi.fn(),
    localRevision: 0,
    flushDocument: vi.fn().mockResolvedValue(undefined),
    beforeDisconnect: vi.fn(),
  }),
}));

import { useCollaborativeStructuredAnswer } from './useCollaborativeStructuredAnswer';

const scope = { kind: 'intent', id: 'i1', projectId: 'p1' } as const;

describe('useCollaborativeStructuredAnswer — connection state', () => {
  beforeEach(() => {
    transport.doc = new Y.Doc();
    transport.connection = 'synced';
    transport.retryNow.mockReset();
  });

  it('exposes the transport connection and its retry', () => {
    transport.connection = 'unavailable';
    const { result } = renderHook(() => useCollaborativeStructuredAnswer(scope, 'q1', 2, 'ana'));

    expect(result.current.connection).toBe('unavailable');
    expect(result.current.synced).toBe(false);

    act(() => result.current.retryNow());
    expect(transport.retryNow).toHaveBeenCalledTimes(1);
  });

  it('reports synced once the document has synchronized', () => {
    const { result } = renderHook(() => useCollaborativeStructuredAnswer(scope, 'q1', 2, 'ana'));

    expect(result.current.connection).toBe('synced');
    expect(result.current.synced).toBe(true);
  });

  it('still records selections in the shared document', () => {
    const { result } = renderHook(() => useCollaborativeStructuredAnswer(scope, 'q1', 2, 'ana'));

    act(() => result.current.setSelection(1, [2]));

    expect(result.current.selections.get(1)).toEqual([2]);
    expect(result.current.toStructuredAnswer()).toEqual({
      answers: [
        { selectedOptions: [], freeText: undefined },
        { selectedOptions: [2], freeText: undefined },
      ],
    });
  });
});
