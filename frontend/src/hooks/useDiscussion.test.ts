import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { discussionsService } from '../services/discussions';
import type { DiscussionMessage, DiscussionScope } from '../services/discussions';
import { useDiscussion } from './useDiscussion';

const collaboration = vi.hoisted(() => ({ doc: null as Y.Doc | null }));

vi.mock('./useYjsDocument', () => ({
  useYjsDocument: () => ({
    doc: collaboration.doc,
    synced: false,
    awareness: null,
    remoteUsers: new Map(),
  }),
}));

vi.mock('../services/realtime', () => ({
  realtimeService: { on: vi.fn(() => vi.fn()) },
}));

vi.mock('../services/discussions', () => ({
  discussionsService: { postMessage: vi.fn(), assist: vi.fn() },
}));

const scope: DiscussionScope = { kind: 'intent', projectId: 'p1', intentId: 'i1' };
const question = '@quorum check the risks';
const persisted: DiscussionMessage = {
  id: 'dm-persisted',
  content: question,
  authorId: 'u1',
  authorName: 'Alice',
  authorType: 'user',
  mentions: [],
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  discussionId: 'd1',
  sprintId: 'i1',
};

const renderDiscussion = () =>
  renderHook(() =>
    useDiscussion({
      scope,
      discussionId: 'd1',
      open: true,
      user: { id: 'u1', name: 'Alice' },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  collaboration.doc = new Y.Doc();
  vi.mocked(discussionsService.assist).mockResolvedValue({
    requestId: 'assist-1',
    message: { ...persisted, id: 'reply-1', content: 'The risks are…', authorType: 'agent' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  collaboration.doc?.destroy();
});

describe('useDiscussion Quorum questions', () => {
  it('waits for persistence before requesting Quorum and retains both messages', async () => {
    let save!: (message: DiscussionMessage) => void;
    vi.mocked(discussionsService.postMessage).mockReturnValue(
      new Promise((resolve) => {
        save = resolve;
      }),
    );
    const { result } = renderDiscussion();
    let sending!: Promise<void>;

    act(() => {
      sending = result.current.sendMessage(question, [], 'check the risks');
    });

    expect(discussionsService.postMessage).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ content: question }),
    );
    expect(discussionsService.assist).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([
      expect.objectContaining({ content: question, status: 'sending' }),
    ]);

    await act(async () => {
      const id = vi.mocked(discussionsService.postMessage).mock.calls[0][2].id;
      save({ ...persisted, id });
      await sending;
    });

    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ command: 'ask', instructions: 'check the risks' }),
    );
    expect(result.current.messages.map((m) => m.content)).toEqual([question, 'The risks are…']);
    expect(result.current.pending).toEqual([]);
  });

  it('does not start Quorum after a failed save and starts it after retrying the same message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(discussionsService.postMessage)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (_scope, _discussionId, input) => ({
        ...persisted,
        id: input.id,
      }));
    const { result } = renderDiscussion();

    await act(async () => {
      await result.current.sendMessage(question, [], 'check the risks');
    });

    expect(discussionsService.assist).not.toHaveBeenCalled();
    expect(result.current.pending).toEqual([
      expect.objectContaining({ content: question, status: 'failed' }),
    ]);
    const id = result.current.pending[0].id;

    await act(async () => {
      await result.current.retryMessage(id);
    });

    expect(vi.mocked(discussionsService.postMessage).mock.calls.map((call) => call[2].id)).toEqual([
      id,
      id,
    ]);
    expect(discussionsService.assist).toHaveBeenCalledTimes(1);
    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ instructions: 'check the risks' }),
    );
    expect(result.current.pending).toEqual([]);
    expect(result.current.messages[0].content).toBe(question);
  });

  it('does not request assist for ordinary messages', async () => {
    vi.mocked(discussionsService.postMessage).mockResolvedValue(persisted);
    const { result } = renderDiscussion();

    await act(async () => {
      await result.current.sendMessage('Hello', []);
    });

    expect(discussionsService.assist).not.toHaveBeenCalled();
  });

  it('requests assist even when @quorum has no additional instructions', async () => {
    vi.mocked(discussionsService.postMessage).mockResolvedValue(persisted);
    const { result } = renderDiscussion();

    await act(async () => {
      await result.current.sendMessage('@quorum', [], '');
    });

    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ command: 'ask', instructions: '' }),
    );
  });
});
