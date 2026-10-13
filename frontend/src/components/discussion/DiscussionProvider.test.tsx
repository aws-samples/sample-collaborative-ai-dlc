import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import { clearNativeIntents, refreshNativeIntents } from '@/hooks/useNativeIntents';
import { nativeIntentsService } from '@/services/nativeIntents';
import { ApiError } from '@/services/api';

const listMembers = vi.hoisted(() => vi.fn());
const listDiscussions = vi.hoisted(() => vi.fn());
const getOrCreate = vi.hoisted(() => vi.fn());
const context = vi.hoisted(() => ({
  projectId: 'project-1',
  intentId: 'intent-1',
  userId: 'sso-sub',
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useParams: () => ({ projectId: context.projectId, intentId: context.intentId }),
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
  Object.assign(context, { projectId: 'project-1', intentId: 'intent-1', userId: 'sso-sub' });
  getOrCreate.mockReset();
  listMembers
    .mockReset()
    .mockResolvedValue([{ userId: 'sso-sub', email: 'user@example.com', role: 'admin' }]);
  listDiscussions.mockReset().mockResolvedValue([]);
});

describe('DiscussionProvider current member identity', () => {
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
