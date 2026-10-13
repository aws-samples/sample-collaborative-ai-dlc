import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/services/api';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import type { Discussion, DiscussionMessage, DiscussionScope } from '@/services/discussions';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  redact: vi.fn(),
  applyMessages: vi.fn(),
  setActiveDiscussion: vi.fn(),
  onAccessFailure: vi.fn(),
  useDiscussion: vi.fn(),
  userId: 'sso-sub',
  scope: {} as DiscussionScope,
  discussion: {} as Discussion,
  role: 'member',
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      userId: mocks.userId,
      username: 'CorporateOIDC_external-user',
      displayName: 'Ada',
    },
  }),
}));
vi.mock('@/services/discussions', () => ({
  discussionsService: { update: mocks.update, redact: mocks.redact },
}));
vi.mock('./DiscussionProvider', () => ({
  useDiscussions: () => ({
    scope: mocks.scope,
    activeDiscussion: mocks.discussion,
    isOpen: true,
    role: mocks.role,
    members: [],
    loading: false,
    error: null,
    setActiveDiscussion: mocks.setActiveDiscussion,
    onAccessFailure: mocks.onAccessFailure,
  }),
}));
vi.mock('@/hooks/useDiscussion', () => ({
  useDiscussion: (args: unknown) => mocks.useDiscussion(args),
}));
vi.mock('./DiscussionThread', () => ({
  DiscussionThread: ({
    canRedact,
    onRedact,
  }: {
    canRedact: boolean;
    onRedact: (id: string) => void;
  }) => (canRedact ? <button onClick={() => onRedact('message-1')}>Redact</button> : null),
}));
vi.mock('./DiscussionInput', () => ({ DiscussionInput: () => null }));

import { DiscussionPanel } from './DiscussionPanel';

const outcome = {
  id: 'message-1',
  authorName: 'Grace',
  content: 'Use the accessible plan',
  redacted: false,
} as DiscussionMessage;

beforeEach(() => {
  resetSessionExpiry();
  vi.resetAllMocks();
  mocks.userId = 'sso-sub';
  mocks.role = 'member';
  mocks.scope = { kind: 'native', projectId: 'p', intentId: 'i', digest: 'a'.repeat(64) };
  mocks.discussion = {
    id: 'thread',
    entityType: 'artifact',
    status: 'open',
    unreadCount: 0,
  } as Discussion;
  mocks.useDiscussion.mockReturnValue({
    messages: [outcome],
    pending: [],
    synced: true,
    hasMoreOlder: false,
    loadingOlder: false,
    typingUsers: [],
    remoteUsers: new Map(),
    applyMessages: mocks.applyMessages,
  });
});

function submitResolution() {
  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'Keep the accessible version of the plan.' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: /Use the accessible plan/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve' }));
}

it('initializes discussion ownership and presence with Cognito sub', () => {
  render(<DiscussionPanel />);
  expect(mocks.useDiscussion).toHaveBeenCalledWith(
    expect.objectContaining({ user: { id: 'sso-sub', name: 'Ada' } }),
  );
});

it('preserves read-only sprint discussions without resolve, reopen or redact controls', () => {
  mocks.scope = { kind: 'sprint', sprintId: 'retained' };
  mocks.role = 'owner';
  const view = render(<DiscussionPanel />);
  expect(screen.queryByRole('button', { name: /Resolve|Reopen|Redact/ })).not.toBeInTheDocument();
  mocks.discussion.status = 'resolved';
  view.rerender(<DiscussionPanel />);
  expect(screen.queryByRole('button', { name: /Resolve|Reopen|Redact/ })).not.toBeInTheDocument();
});

it.each([
  ['native', new Error('Discussion service temporarily unavailable')],
  ['native', new ApiError(500, 'Discussion update failed')],
  ['intent', new ApiError(422, 'Invalid outcome message')],
] as const)(
  'retains the resolution text and outcome after a %s save fails with %s',
  async (kind, failure) => {
    if (kind === 'intent') mocks.scope = { kind, projectId: 'p', intentId: 'i' };
    mocks.update.mockRejectedValueOnce(failure);
    render(<DiscussionPanel />);
    submitResolution();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(await screen.findByText(failure.message)).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(within(screen.getByRole('dialog')).getByRole('textbox')).toHaveValue(
      'Keep the accessible version of the plan.',
    );
    expect(mocks.setActiveDiscussion).not.toHaveBeenCalled();
    expect(mocks.onAccessFailure).toHaveBeenCalledWith(failure);
    mocks.update.mockResolvedValueOnce({ ...mocks.discussion, status: 'resolved' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.update.mock.calls[1]).toEqual(mocks.update.mock.calls[0]);
    expect(mocks.update).toHaveBeenLastCalledWith(mocks.scope, 'thread', {
      status: 'resolved',
      resolutionSummary: 'Keep the accessible version of the plan.',
      outcomeMessageId: 'message-1',
    });
  },
);

it.each(['native', 'intent'] as const)('resolves and reopens a %s discussion', async (kind) => {
  if (kind === 'intent') mocks.scope = { kind, projectId: 'p', intentId: 'i' };
  const resolved = { ...mocks.discussion, status: 'resolved' as const };
  mocks.update.mockResolvedValueOnce(resolved);
  const view = render(<DiscussionPanel />);
  submitResolution();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.setActiveDiscussion).toHaveBeenCalledWith(resolved);
  mocks.discussion = resolved;
  view.rerender(<DiscussionPanel />);
  const reopened = { ...resolved, status: 'open' as const };
  mocks.update.mockResolvedValueOnce(reopened);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  await waitFor(() => expect(mocks.setActiveDiscussion).toHaveBeenLastCalledWith(reopened));
  expect(mocks.update).toHaveBeenLastCalledWith(mocks.scope, 'thread', { status: 'open' });
  expect(mocks.onAccessFailure).not.toHaveBeenCalled();
});

it('surfaces a failed Reopen and allows retry without an unhandled rejection', async () => {
  mocks.discussion.status = 'resolved';
  mocks.update.mockRejectedValueOnce(new Error('Reopen temporarily unavailable'));
  render(<DiscussionPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Reopen temporarily unavailable');
  expect(screen.getByRole('button', { name: 'Reopen' })).toBeEnabled();
  expect(mocks.setActiveDiscussion).not.toHaveBeenCalled();
  mocks.update.mockResolvedValueOnce({ ...mocks.discussion, status: 'open' });
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  await waitFor(() => expect(mocks.setActiveDiscussion).toHaveBeenCalledOnce());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each(
  (['resolve', 'reopen'] as const).flatMap((action) =>
    (['thread', 'project', 'account', 'session'] as const).map((change) => ({ action, change })),
  ),
)('ignores a delayed $action failure after a $change change', async ({ action, change }) => {
  let fail!: (error: Error) => void;
  mocks.update.mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  if (action === 'reopen') mocks.discussion.status = 'resolved';
  const view = render(<DiscussionPanel />);
  if (action === 'resolve') submitResolution();
  else fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  if (change === 'thread') mocks.discussion = { ...mocks.discussion, id: 'replacement' };
  if (change === 'project')
    mocks.scope = {
      kind: 'native',
      projectId: 'replacement',
      intentId: 'i',
      digest: 'b'.repeat(64),
    };
  if (change === 'account') mocks.userId = 'replacement';
  if (change === 'session') {
    // Finish before React unmounts the old panel: the epoch must fence it too.
    await act(async () => {
      resetSessionExpiry();
      fail(new ApiError(403, 'Old session denied'));
    });
    view.unmount();
  } else {
    mocks.discussion = { ...mocks.discussion, status: 'open' };
    view.rerender(<DiscussionPanel />);
    await act(async () => fail(new ApiError(403, 'Old scope denied')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeEnabled();
  }
  expect(mocks.onAccessFailure).not.toHaveBeenCalled();
  expect(mocks.setActiveDiscussion).not.toHaveBeenCalled();
});

it.each([
  new ApiError(404, 'Message not found'),
  new ApiError(403, 'Only project admins or owners can redact messages'),
])('keeps redaction failure visible and does not remove content: %s', async (failure) => {
  mocks.role = 'admin';
  mocks.redact.mockRejectedValueOnce(failure);
  render(<DiscussionPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Redact' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(failure.message);
  expect(mocks.onAccessFailure).toHaveBeenCalledWith(failure);
  expect(mocks.applyMessages).not.toHaveBeenCalled();
});

it('ignores a delayed redaction denial after replacing the thread', async () => {
  let fail!: (error: Error) => void;
  mocks.role = 'admin';
  mocks.redact.mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  const view = render(<DiscussionPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Redact' }));
  mocks.discussion = { ...mocks.discussion, id: 'replacement' };
  view.rerender(<DiscussionPanel />);
  await act(async () => fail(new ApiError(403, 'Old role denied')));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(mocks.onAccessFailure).not.toHaveBeenCalled();
  expect(mocks.applyMessages).not.toHaveBeenCalled();
});

it('forwards a current resolution access failure without losing its draft', async () => {
  const failure = new ApiError(403, 'Not a project member');
  mocks.update.mockRejectedValueOnce(failure);
  render(<DiscussionPanel />);
  submitResolution();
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
  expect(await screen.findByText(failure.message)).toBeVisible();
  expect(mocks.onAccessFailure).toHaveBeenCalledWith(failure);
  expect(within(screen.getByRole('dialog')).getByRole('textbox')).toHaveValue(
    'Keep the accessible version of the plan.',
  );
});
