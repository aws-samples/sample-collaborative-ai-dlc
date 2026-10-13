import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/services/api';
import type { DiscussionMessage, DiscussionScope } from '@/services/discussions';
import { resetCollaborationFakes } from '@/test/collaborationFakes';
import { useDiscussion } from './useDiscussion';
import { resetSessionExpiry } from '@/services/sessionExpiry';

const service = vi.hoisted(() => ({
  listMessages: vi.fn(),
  postMessage: vi.fn(),
  assist: vi.fn(),
  handlers: new Map<string, Set<(event: any) => void>>(),
}));
vi.mock('./useYjsDocument', async () => import('@/test/collaborationFakes'));
vi.mock('@/services/discussions', () => ({ discussionsService: service }));
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    on: (name: string, fn: (event: any) => void) => {
      const set = service.handlers.get(name) ?? new Set();
      set.add(fn);
      service.handlers.set(name, set);
      return () => set.delete(fn);
    },
  },
}));
const scope: DiscussionScope = {
  kind: 'native',
  projectId: 'p',
  intentId: 'i',
  digest: 'a'.repeat(64),
};
const user = { id: 'ada', name: 'Ada' };
const message = (id: string, discussionId: string, content = id): DiscussionMessage => ({
  id,
  discussionId,
  content,
  sprintId: `native-discussions-${scope.digest}`,
  authorId: 'quorum',
  authorName: 'Quorum',
  authorType: 'agent',
  mentions: [],
  redacted: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  resetSessionExpiry();
  vi.clearAllMocks();
  service.handlers.clear();
  resetCollaborationFakes();
  service.listMessages.mockResolvedValue({ messages: [], hasMore: false });
});

it('rejects retained callbacks immediately when the session changes, before React replaces the reader', async () => {
  const denied = vi.fn();
  const { result } = renderHook(() =>
    useDiscussion({
      scope,
      discussionId: 'old',
      user,
      open: true,
      onAccessFailure: denied,
    }),
  );
  await waitFor(() => expect(result.current.seeded).toBe(true));
  const old = result.current;
  act(() => resetSessionExpiry());
  await act(async () => {
    await old.requestAssist('explain');
    await old.sendMessage('Old member comment');
  });
  expect(service.assist).not.toHaveBeenCalled();
  expect(service.postMessage).not.toHaveBeenCalled();
  expect(denied).not.toHaveBeenCalled();
});

it('seeds a different revision and discards the old pending message and its late acknowledgement', async () => {
  let finish!: (value: unknown) => void;
  service.postMessage.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(
    ({ discussionId }) => useDiscussion({ scope, discussionId, user, open: true }),
    { initialProps: { discussionId: 'old-revision' } },
  );
  await waitFor(() => expect(result.current.seeded).toBe(true));
  let sending!: Promise<void>;
  act(() => {
    sending = result.current.sendMessage('Old revision comment');
  });
  expect(result.current.pending).toHaveLength(1);
  const old = result.current.pending[0];
  service.listMessages.mockResolvedValueOnce({
    messages: [message('new', 'new-revision')],
    hasMore: false,
  });
  rerender({ discussionId: 'new-revision' });
  await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['new']));
  expect(result.current.pending).toEqual([]);
  await act(async () => {
    finish(message(old.id, 'old-revision', old.content));
    await sending;
  });
  expect(result.current.messages.map((m) => m.id)).toEqual(['new']);
  await act(async () => {
    await result.current.retryMessage(old.id);
  });
  expect(service.postMessage).toHaveBeenCalledTimes(1);
});

it('ignores delayed Quorum, reconciliation and fanout callbacks after changing threads', async () => {
  let finishAssist!: (value: unknown) => void;
  let finishRead!: (value: unknown) => void;
  const { result, rerender } = renderHook(
    ({ discussionId }) => useDiscussion({ scope, discussionId, user, open: true }),
    { initialProps: { discussionId: 'old' } },
  );
  await waitFor(() => expect(result.current.seeded).toBe(true));
  service.assist.mockReturnValueOnce(
    new Promise((resolve) => {
      finishAssist = resolve;
    }),
  );
  service.listMessages.mockReturnValueOnce(
    new Promise((resolve) => {
      finishRead = resolve;
    }),
  );
  let assist!: Promise<void>;
  let reconcile!: Promise<void>;
  act(() => {
    assist = result.current.requestAssist('explain');
    reconcile = result.current.reconcile();
  });
  const lateFanout = [...service.handlers.get('discussion.message')!][0];
  rerender({ discussionId: 'new' });
  await waitFor(() => expect(result.current.seeded).toBe(true));
  await act(async () => {
    finishAssist({ message: message('advice', 'old') });
    finishRead({ messages: [message('historical', 'old')], hasMore: false });
    lateFanout({ discussionId: 'old', message: message('late', 'old') });
    await Promise.all([assist, reconcile]);
  });
  expect(result.current.messages).toEqual([]);
});

it('retries failed Quorum advice with its request identity and merges current completion', async () => {
  const { result } = renderHook(() =>
    useDiscussion({ scope, discussionId: 'old', user, open: true }),
  );
  await waitFor(() => expect(result.current.seeded).toBe(true));
  service.assist.mockResolvedValueOnce({
    message: { ...message('advice', 'old'), assistStatus: 'failed' },
  });
  await act(async () => {
    await result.current.requestAssist('explain', '', { requestId: 'assist-one' });
  });
  expect(result.current.messages[0].assistStatus).toBe('failed');
  service.assist.mockResolvedValueOnce({
    message: {
      ...message('advice', 'old'),
      assistStatus: 'running',
      updatedAt: '2026-10-01T00:00:01Z',
    },
  });
  await act(async () => {
    await result.current.requestAssist('explain', '', { requestId: 'assist-one' });
  });
  expect(service.assist.mock.calls.map((call) => call[2].requestId)).toEqual([
    'assist-one',
    'assist-one',
  ]);
  act(() => {
    for (const handler of service.handlers.get('discussion.message')!)
      handler({
        discussionId: 'old',
        message: {
          ...message('advice', 'old', 'Advisory only'),
          assistStatus: 'completed',
          updatedAt: '2026-10-01T00:00:02Z',
        },
      });
  });
  expect(result.current.messages[0]).toMatchObject({
    assistStatus: 'completed',
    content: 'Advisory only',
  });
  expect(service.postMessage).not.toHaveBeenCalled();
});

it('reports current access revocation but ignores a denial from a retired reader', async () => {
  const denied = vi.fn();
  let reject!: (reason: unknown) => void;
  const { result, rerender } = renderHook(
    ({ discussionId }) =>
      useDiscussion({ scope, discussionId, user, open: true, onAccessFailure: denied }),
    { initialProps: { discussionId: 'old' } },
  );
  await waitFor(() => expect(result.current.seeded).toBe(true));
  service.assist.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.requestAssist('explain');
  });
  rerender({ discussionId: 'new' });
  await act(async () => {
    reject(new ApiError(403, 'Denied'));
    await pending;
  });
  expect(denied).not.toHaveBeenCalled();
  service.assist.mockRejectedValueOnce(new ApiError(403, 'Denied'));
  await act(async () => {
    await result.current.requestAssist('explain');
  });
  expect(denied).toHaveBeenCalledOnce();
});
