import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import {
  clearNativeIntents,
  getNativeListing,
  refreshNativeIntents,
} from '@/hooks/useNativeIntents';
import { nativeIntentsService } from '@/services/nativeIntents';
import { ApiError } from '@/services/api';

const listMembers = vi.hoisted(() => vi.fn());
const listDiscussions = vi.hoisted(() => vi.fn());
const getOrCreate = vi.hoisted(() => vi.fn());
const context = vi.hoisted(() => ({
  projectId: 'project-1',
  intentId: 'intent-1',
  userId: 'sso-sub',
  sprintId: '',
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useParams: () => ({
      projectId: context.projectId,
      intentId: context.intentId,
      sprintId: context.sprintId,
    }),
  };
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      userId: context.userId,
      username: 'CorporateOIDC_external-user',
      email: 'user@example.com',
      displayName: 'Enterprise User',
      groups: [],
      identitySource: 'sso',
      identityProvider: 'CorporateOIDC',
    },
  }),
}));

vi.mock('@/services/projects', () => ({
  projectsService: {
    listMembers: (...args: unknown[]) => listMembers(...args),
  },
}));

vi.mock('@/services/discussions', () => ({
  discussionsService: {
    list: (...args: unknown[]) => listDiscussions(...args),
    getOrCreate: (...args: unknown[]) => getOrCreate(...args),
  },
}));

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    on: () => () => {},
  },
}));

vi.mock('./MentionToasts', () => ({
  MentionToasts: () => null,
}));

import { DiscussionProvider, useDiscussions } from './DiscussionProvider';

let latest: ReturnType<typeof useDiscussions>;
function CurrentRole() {
  const ctx = useDiscussions()!;
  latest = ctx;
  return (
    <>
      <div>{ctx.role || 'none'}</div>
      <button
        disabled={!ctx.scope}
        onClick={() => ctx.openDiscussion({ entityType: 'artifact', entityId: 'old-revision' })}
      >
        Open
      </button>
      <button onClick={ctx.close}>Close</button>
      <div data-testid="thread">{ctx.activeDiscussion?.id}</div>
      <div data-testid="list">{ctx.discussions.map((d) => d.id).join(',')}</div>
    </>
  );
}

beforeEach(() => {
  resetSessionExpiry();
  clearNativeIntents();
  Object.assign(context, {
    projectId: 'project-1',
    intentId: 'intent-1',
    userId: 'sso-sub',
    sprintId: '',
  });
  getOrCreate.mockReset();
  listMembers
    .mockReset()
    .mockResolvedValue([{ userId: 'sso-sub', email: 'user@example.com', role: 'admin' }]);
  listDiscussions.mockReset().mockResolvedValue([]);
});

describe('DiscussionProvider current member identity', () => {
  it('keeps a retained sprint scope when a message is missing and no project route is supplied', async () => {
    Object.assign(context, { projectId: '', intentId: '', sprintId: 'retained' });
    render(
      <DiscussionProvider>
        <CurrentRole />
      </DiscussionProvider>,
    );
    await act(async () => {
      await latest!.onAccessFailure(new ApiError(404, 'Message not found'));
    });
    expect(latest?.scope).toEqual({ kind: 'sprint', sprintId: 'retained' });
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('keeps native project access when one discussion artifact is missing', async () => {
    getOrCreate.mockRejectedValueOnce(
      new ApiError(404, 'Artifact revision not found in this execution'),
    );
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(getOrCreate).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(getNativeListing('project-1').denied).toBe(false);
    expect(latest?.scope).not.toBeNull();
    expect(latest?.error).toBe('Artifact revision not found in this execution');
    expect(listDiscussions).toHaveBeenCalledTimes(2);
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it.each(['native', 'platform'] as const)(
    'keeps an authorized %s member in the thread after a missing message or lost moderation role',
    async (backend) => {
      getOrCreate.mockResolvedValue({ id: 'thread', entityId: 'old-revision' });
      listDiscussions.mockResolvedValue([{ id: 'thread', entityId: 'old-revision' }]);
      render(
        <DiscussionProvider backend={backend}>
          <CurrentRole />
        </DiscussionProvider>,
      );
      await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
      fireEvent.click(screen.getByText('Open'));
      await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('thread'));
      await act(async () => {
        await latest!.onAccessFailure(new ApiError(404, 'Message not found'));
      });
      expect(latest?.scope).not.toBeNull();
      expect(latest?.role).toBe('admin');
      expect(screen.getByTestId('thread')).toHaveTextContent('thread');

      listMembers.mockResolvedValue([{ userId: context.userId, role: 'member' }]);
      await act(async () => {
        await latest!.onAccessFailure(
          new ApiError(403, 'Only project admins or owners can redact messages'),
        );
      });
      expect(latest?.role).toBe('member');
      expect(latest?.scope).not.toBeNull();
      expect(screen.getByTestId('thread')).toHaveTextContent('thread');
      expect(screen.getByTestId('list')).toHaveTextContent('thread');
      expect(getNativeListing('project-1').denied).toBe(false);
    },
  );

  it.each(['native', 'platform'] as const)(
    'detaches %s discussions after protected scope denial, without revoking a known project member',
    async (backend) => {
      getOrCreate.mockResolvedValue({ id: 'thread', entityId: 'old-revision' });
      render(
        <DiscussionProvider backend={backend}>
          <CurrentRole />
        </DiscussionProvider>,
      );
      await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
      fireEvent.click(screen.getByText('Open'));
      await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('thread'));
      listDiscussions.mockRejectedValueOnce(new ApiError(404, 'Intent not found'));
      await act(async () => {
        await latest!.onAccessFailure(new ApiError(404, 'Discussion not found'));
      });
      expect(latest?.scope).toBeNull();
      expect(latest?.role).toBeNull();
      expect(screen.getByTestId('thread')).toBeEmptyDOMElement();
      expect(screen.getByTestId('list')).toBeEmptyDOMElement();
      expect(screen.getByText('Open')).toBeDisabled();
      expect(getNativeListing('project-1').denied).toBe(false);
    },
  );

  it('evicts project data only after protected membership confirms removal', async () => {
    getOrCreate.mockResolvedValue({ id: 'thread', entityId: 'old-revision' });
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('thread'));
    listDiscussions.mockRejectedValueOnce(new ApiError(403, 'Not a project member'));
    listMembers.mockRejectedValueOnce(new ApiError(403, 'Access denied'));
    await act(async () => {
      await latest!.onAccessFailure(new ApiError(403, 'Not a project member'));
    });
    expect(latest?.scope).toBeNull();
    expect(latest?.role).toBeNull();
    expect(getNativeListing('project-1').denied).toBe(true);
    expect(screen.getByTestId('thread')).toBeEmptyDOMElement();
    expect(screen.getByText('Open')).toBeDisabled();

    // Restored membership plus the existing protected listing retry enables a
    // fresh thread in this route; the previous denial must not latch forever.
    listMembers.mockResolvedValue([{ userId: context.userId, role: 'member' }]);
    const listing = vi.spyOn(nativeIntentsService, 'list').mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    await act(async () => refreshNativeIntents('project-1', 'refresh', true));
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('thread'));
    expect(latest?.role).toBe('member');
    listing.mockRestore();
  });

  it('does not turn unavailable authorization reads into a confirmed project denial', async () => {
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    listDiscussions.mockRejectedValueOnce(new ApiError(503, 'Graph unavailable'));
    listMembers.mockRejectedValueOnce(new Error('Network unavailable'));
    getOrCreate.mockRejectedValueOnce(
      new ApiError(404, 'Artifact revision not found in this execution'),
    );
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(latest?.error).toBe('Artifact revision not found in this execution');
    expect(latest?.scope).not.toBeNull();
    expect(getNativeListing('project-1').denied).toBe(false);
  });

  it.each(
    (['denied', 'authorized'] as const).flatMap((result) =>
      (['project', 'account', 'thread', 'session'] as const).map((change) => ({ result, change })),
    ),
  )('ignores a delayed $result check after switching $change', async ({ change, result }) => {
    let rejectScope!: (error: unknown) => void;
    let rejectMembers!: (error: unknown) => void;
    let authorizeScope!: (value: unknown) => void;
    let authorizeMembers!: (value: unknown) => void;
    const scopeCheck = new Promise((resolve, reject) => {
      authorizeScope = resolve;
      rejectScope = reject;
    });
    const memberCheck = new Promise((resolve, reject) => {
      authorizeMembers = resolve;
      rejectMembers = reject;
    });
    listMembers.mockResolvedValue([{ userId: context.userId, role: 'member' }]);
    getOrCreate.mockResolvedValue({ id: 'old-thread', entityId: 'old-revision' });
    const view = render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('old-thread'));
    listDiscussions.mockReturnValueOnce(scopeCheck);
    listMembers.mockReturnValueOnce(memberCheck);
    act(() => {
      latest!.onAccessFailure(new ApiError(403, 'Denied old action'));
    });
    // Replace the project/account or thread while its access reads are in flight.
    if (change === 'project') context.projectId = 'project-2';
    if (change === 'account') context.userId = 'member-2';
    if (change === 'session') act(() => resetSessionExpiry());
    listMembers.mockResolvedValue([{ userId: context.userId, role: 'member' }]);
    getOrCreate.mockResolvedValue({ id: 'replacement-thread', entityId: 'new-revision' });
    if (change !== 'thread')
      view.rerender(
        <DiscussionProvider backend="native">
          <CurrentRole />
        </DiscussionProvider>,
      );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() =>
      expect(screen.getByTestId('thread')).toHaveTextContent('replacement-thread'),
    );
    await act(async () => {
      if (result === 'denied') {
        rejectScope(new ApiError(403, 'Not a project member'));
        rejectMembers(new ApiError(403, 'Access denied'));
      } else {
        authorizeScope([{ id: 'private-old-thread' }]);
        authorizeMembers([{ userId: context.userId, role: 'owner' }]);
      }
    });
    expect(latest?.scope).not.toBeNull();
    expect(latest?.role).toBe('member');
    expect(getNativeListing('project-1').denied).toBe(false);
    expect(getNativeListing(context.projectId).denied).toBe(false);
    expect(screen.getByTestId('thread')).toHaveTextContent('replacement-thread');
  });

  it('does not restore an older authorization after a newer check denied the same thread', async () => {
    let authorizeScope!: (value: unknown) => void;
    let authorizeMembers!: (value: unknown) => void;
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    listDiscussions.mockReturnValueOnce(
      new Promise((resolve) => {
        authorizeScope = resolve;
      }),
    );
    listMembers.mockReturnValueOnce(
      new Promise((resolve) => {
        authorizeMembers = resolve;
      }),
    );
    act(() => {
      latest!.onAccessFailure(new ApiError(404, 'Old message missing'));
    });
    listDiscussions.mockRejectedValueOnce(new ApiError(403, 'Not a project member'));
    listMembers.mockRejectedValueOnce(new ApiError(403, 'Access denied'));
    await act(async () => {
      await latest!.onAccessFailure(new ApiError(403, 'Current scope denied'));
    });
    await act(async () => {
      authorizeScope([{ id: 'private-old-thread' }]);
      authorizeMembers([{ userId: context.userId, role: 'owner' }]);
    });
    expect(latest?.scope).toBeNull();
    expect(latest?.role).toBeNull();
    expect(screen.getByTestId('thread')).toBeEmptyDOMElement();
    expect(getNativeListing(context.projectId).denied).toBe(true);
  });

  it('honors a protected list denial even if the subsequent membership read is unavailable', async () => {
    listDiscussions.mockRejectedValueOnce(new ApiError(404, 'Intent not found'));
    listMembers.mockRejectedValue(new ApiError(503, 'Graph unavailable'));
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(listDiscussions).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(latest?.scope).toBeNull();
    expect(getNativeListing(context.projectId).denied).toBe(false);
  });

  it('ignores a pending access check after session expiry', async () => {
    let authorize!: (value: unknown) => void;
    render(
      <DiscussionProvider backend="native">
        <CurrentRole />
      </DiscussionProvider>,
    );
    await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
    listMembers.mockReturnValueOnce(
      new Promise((resolve) => {
        authorize = resolve;
      }),
    );
    act(() => {
      latest!.onAccessFailure(new ApiError(404, 'Message not found'));
    });
    act(() => notifySessionExpired());
    await act(async () => authorize([{ userId: context.userId, role: 'owner' }]));
    expect(latest?.scope).toBeNull();
    expect(latest?.role).toBeNull();
    expect(screen.getByText('Open')).toBeDisabled();
  });

  it('rejects retained open callbacks immediately at a session boundary', async () => {
    render(
      <DiscussionProvider>
        <CurrentRole />
      </DiscussionProvider>,
    );
    const old = latest!;
    act(() => {
      resetSessionExpiry();
      old.openDiscussion({ entityType: 'artifact', entityId: 'old-revision' });
    });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'closes a native thread on project access denial (disabled: %s)',
    async (disabled) => {
      getOrCreate.mockResolvedValue({ id: 'private-thread', entityId: 'old-revision' });
      render(
        <DiscussionProvider backend="native">
          <CurrentRole />
        </DiscussionProvider>,
      );
      await act(async () => {});
      await waitFor(() => expect(screen.getByText('Open')).toBeEnabled());
      fireEvent.click(screen.getByText('Open'));
      await waitFor(() => expect(screen.getByTestId('thread')).toHaveTextContent('private-thread'));
      const denied = vi
        .spyOn(nativeIntentsService, 'list')
        .mockRejectedValueOnce(
          new ApiError(
            403,
            'Forbidden',
            disabled ? { code: 'NATIVE_PREPARATION_PROJECT_DISABLED' } : {},
          ),
        );
      await act(async () => {
        await refreshNativeIntents('project-1', 'refresh', true);
      });
      expect(screen.getByTestId('thread')).toBeEmptyDOMElement();
      expect(screen.getByTestId('list')).toBeEmptyDOMElement();
      fireEvent.click(screen.getByText('Open'));
      expect(getOrCreate).toHaveBeenCalledOnce();
      denied.mockRestore();
    },
  );

  it.each(['project', 'account', 'close'])(
    'ignores a late open after %s changes',
    async (change) => {
      let finish!: (value: unknown) => void;
      getOrCreate.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const tree = (
        <DiscussionProvider>
          <CurrentRole />
        </DiscussionProvider>
      );
      const view = render(tree);
      fireEvent.click(screen.getByText('Open'));
      await waitFor(() => expect(getOrCreate).toHaveBeenCalledOnce());
      if (change === 'close') fireEvent.click(screen.getByText('Close'));
      else {
        if (change === 'project') context.projectId = 'project-2';
        else context.userId = 'member-2';
        view.rerender(
          <DiscussionProvider>
            <CurrentRole />
          </DiscussionProvider>,
        );
      }
      await act(async () => {
        finish({ id: 'old-thread', entityId: 'old-revision' });
      });
      expect(screen.getByTestId('thread')).toBeEmptyDOMElement();
    },
  );

  it('does not restore the previous project list or role from a delayed request', async () => {
    let finishList!: (value: unknown) => void;
    let finishMembers!: (value: unknown) => void;
    listDiscussions.mockReturnValueOnce(
      new Promise((resolve) => {
        finishList = resolve;
      }),
    );
    listMembers
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishMembers = resolve;
        }),
      )
      .mockResolvedValue([]);
    const view = render(
      <DiscussionProvider>
        <CurrentRole />
      </DiscussionProvider>,
    );
    context.projectId = 'project-2';
    view.rerender(
      <DiscussionProvider>
        <CurrentRole />
      </DiscussionProvider>,
    );
    await act(async () => {
      finishList([{ id: 'private-old-thread' }]);
      finishMembers([{ userId: context.userId, role: 'owner' }]);
    });
    expect(screen.getByTestId('list')).toBeEmptyDOMElement();
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('resolves an SSO member role by Cognito sub rather than username', async () => {
    render(
      <DiscussionProvider>
        <CurrentRole />
      </DiscussionProvider>,
    );

    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(listMembers).toHaveBeenCalledWith('project-1');
  });
});
