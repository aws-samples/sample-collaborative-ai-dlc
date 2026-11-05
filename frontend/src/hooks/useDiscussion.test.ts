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
  vi.resetAllMocks();
  collaboration.doc = new Y.Doc();
  vi.mocked(discussionsService.assist).mockImplementation(async (_scope, _id, input) => ({
    requestId: input.requestId,
    message: {
      ...persisted,
      id: 'reply-1',
      requestId: input.requestId,
      content: 'The risks are…',
      authorType: 'agent',
    },
  }));
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
      sending = result.current.sendMessage(question, []);
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
      await result.current.sendMessage(question, ['u2']);
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
    expect(vi.mocked(discussionsService.postMessage).mock.calls[1][2]).toEqual(
      vi.mocked(discussionsService.postMessage).mock.calls[0][2],
    );
    expect(discussionsService.assist).toHaveBeenCalledTimes(1);
    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ instructions: 'check the risks' }),
    );
    expect(result.current.pending).toEqual([]);
    expect(result.current.messages[0].content).toBe(question);
  });

  it('retains a failed assist submission and retries with the same request ID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(discussionsService.postMessage).mockImplementation(async (_scope, _id, input) => ({
      ...persisted,
      ...input,
    }));
    vi.mocked(discussionsService.assist).mockRejectedValueOnce(new Error('unavailable'));
    const { result } = renderDiscussion();

    await act(async () => {
      await result.current.sendMessage(question, ['u2']);
    });

    expect(result.current.messages[0].content).toBe(question);
    expect(result.current.pending).toEqual([
      expect.objectContaining({ status: 'failed', mentions: ['u2'] }),
    ]);
    const id = result.current.pending[0].id;

    await act(async () => {
      await result.current.retryMessage(id);
    });

    const calls = vi.mocked(discussionsService.assist).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2]).toEqual(calls[0][2]);
    expect(calls[0][2].requestId).toBe(`assist-${id}`);
    expect(result.current.pending).toEqual([]);
    expect(result.current.messages.filter((m) => m.authorType === 'user')).toHaveLength(1);
  });

  it('retains an ask after its broadcast arrives but the message POST response is lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(discussionsService.postMessage)
      .mockImplementationOnce(async (_scope, _id, input) => {
        collaboration.doc!.getMap<DiscussionMessage>('messages').set(input.id, {
          ...persisted,
          ...input,
        });
        throw new Error('response lost');
      })
      .mockImplementationOnce(async (_scope, _id, input) => ({ ...persisted, ...input }));
    const { result } = renderDiscussion();

    await act(async () => {
      await result.current.sendMessage(question, ['u2']);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.pending[0].status).toBe('failed');
    expect(discussionsService.assist).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.retryMessage(result.current.pending[0].id);
    });

    const calls = vi.mocked(discussionsService.postMessage).mock.calls;
    expect(calls[1][2]).toEqual(calls[0][2]);
    expect(calls[1][2].mentions).toEqual(['u2']);
    expect(result.current.pending).toEqual([]);
    expect(discussionsService.assist).toHaveBeenCalledTimes(1);
  });

  it('recovers unanswered persisted asks after reopening, scoped to the current author', async () => {
    collaboration.doc!.getMap<DiscussionMessage>('messages').set(persisted.id, {
      ...persisted,
      mentions: ['u2'],
    });
    collaboration.doc!.getMap<DiscussionMessage>('messages').set('other-question', {
      ...persisted,
      id: 'other-question',
      authorId: 'u2',
    });
    vi.mocked(discussionsService.postMessage).mockImplementation(async (_scope, _id, input) => ({
      ...persisted,
      ...input,
    }));
    const { result } = renderDiscussion();

    expect(result.current.pending).toEqual([
      expect.objectContaining({ id: persisted.id, status: 'failed', mentions: ['u2'] }),
    ]);

    await act(async () => {
      await result.current.retryMessage(persisted.id);
    });

    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({
        requestId: `assist-${persisted.id}`,
        instructions: 'check the risks',
      }),
    );
    expect(result.current.pending).toEqual([]);
  });

  it('does not recover an ask with an existing assist after its submission response is lost', () => {
    collaboration.doc!.getMap<DiscussionMessage>('messages').set(persisted.id, persisted);
    collaboration.doc!.getMap<DiscussionMessage>('messages').set('reply', {
      ...persisted,
      id: 'reply',
      authorType: 'agent',
      requestId: `assist-${persisted.id}`,
      assistStatus: 'running',
    });

    const { result } = renderDiscussion();

    expect(result.current.pending).toEqual([]);
    expect(discussionsService.assist).not.toHaveBeenCalled();
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
      await result.current.sendMessage('@quorum', []);
    });

    expect(discussionsService.assist).toHaveBeenCalledWith(
      scope,
      'd1',
      expect.objectContaining({ command: 'ask', instructions: '' }),
    );
  });
});
