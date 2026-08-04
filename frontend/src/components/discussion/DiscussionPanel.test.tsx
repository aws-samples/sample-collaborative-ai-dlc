import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const useDiscussion = vi.hoisted(() =>
  vi.fn((_args: unknown) => ({
    messages: [],
    pending: [],
    synced: true,
    hasMoreOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    requestAssist: vi.fn(),
    setTyping: vi.fn(),
    typingUsers: [],
    remoteUsers: new Map(),
    applyMessages: vi.fn(),
  })),
);

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

vi.mock('@/hooks/useDiscussion', () => ({
  useDiscussion: (args: unknown) => useDiscussion(args),
}));

vi.mock('./DiscussionProvider', () => ({
  useDiscussions: () => null,
}));

import { DiscussionPanel } from './DiscussionPanel';

describe('DiscussionPanel current user identity', () => {
  it('initializes discussion ownership and presence with Cognito sub', () => {
    render(<DiscussionPanel />);

    expect(useDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({
        user: {
          id: 'sso-sub',
          name: 'Enterprise User',
        },
      }),
    );
  });
});
