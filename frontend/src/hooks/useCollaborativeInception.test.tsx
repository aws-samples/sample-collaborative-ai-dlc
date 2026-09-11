import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCollaborativeInception } from './useCollaborativeInception';

const mocks = vi.hoisted(() => ({ useYjsDocument: vi.fn() }));
vi.mock('./useYjsDocument', () => ({ useYjsDocument: mocks.useYjsDocument }));

describe('inception autosave ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('ignores remote edits and saves only the section edited locally', async () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const remote = new Y.Doc();
    const onSaveDescription = vi.fn().mockResolvedValue(undefined);
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    mocks.useYjsDocument.mockReturnValue({
      doc,
      synced: true,
      remoteUsers: new Map(),
      setCursor: vi.fn(),
      flushDocument: vi.fn().mockResolvedValue(undefined),
    });
    const { unmount } = renderHook(() =>
      useCollaborativeInception('project', 'alice-id', 'Alice', {
        onSaveDescription,
        onSaveDraft,
      }),
    );
    remote.getText('description').insert(0, 'remote seed');
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(onSaveDescription).not.toHaveBeenCalled();
    expect(onSaveDraft).not.toHaveBeenCalled();
    act(() => doc.getText('description').insert(0, 'local '));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(onSaveDescription).toHaveBeenCalledExactlyOnceWith('local remote seed');
    expect(onSaveDraft).not.toHaveBeenCalled();
    act(() => {
      const answer = new Y.Map();
      const freeTexts = new Y.Map();
      const text = new Y.Text('answer');
      freeTexts.set('0', text);
      answer.set('freeTexts', freeTexts);
      doc.getMap('answers').set('question', answer);
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(onSaveDraft).toHaveBeenCalledExactlyOnceWith('question', {
      answers: [{ selectedOptions: [], freeText: 'answer' }],
    });
    expect(onSaveDescription).toHaveBeenCalledTimes(1);
    unmount();
    doc.destroy();
    remote.destroy();
  });
});
