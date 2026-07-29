import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const listMembers = vi.hoisted(() => vi.fn());
const listDiscussions = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => ({ projectId: 'project-1', intentId: 'intent-1' }),
  };
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      userId: 'sso-sub',
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

function CurrentRole() {
  return <div>{useDiscussions()?.role || 'none'}</div>;
}

beforeEach(() => {
  listMembers
    .mockReset()
    .mockResolvedValue([{ userId: 'sso-sub', email: 'user@example.com', role: 'admin' }]);
  listDiscussions.mockReset().mockResolvedValue([]);
});

describe('DiscussionProvider current member identity', () => {
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
