import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { User } from '@/services/auth';

const mocks = vi.hoisted(() => ({ user: null as User | null }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, changePassword: vi.fn() }),
}));
vi.mock('@/components/settings/AgentCredentialScopeCard', () => ({
  AgentCredentialScopeCard: () => <div>agent credentials</div>,
}));

import AccountSettings from './AccountSettings';

const user = (identitySource: User['identitySource']): User => ({
  userId: 'sub-1',
  username: 'user@example.com',
  groups: [],
  identitySource,
  ...(identitySource === 'sso' ? { identityProvider: 'CorporateOIDC' } : {}),
});

describe('AccountSettings', () => {
  it('offers a password change to local Cognito accounts', () => {
    mocks.user = user('cognito');
    render(<AccountSettings />);
    expect(screen.getByText('Sign-in password')).toBeInTheDocument();
    expect(screen.getByText('agent credentials')).toBeInTheDocument();
  });

  it('hides the password change from federated users', () => {
    mocks.user = user('sso');
    render(<AccountSettings />);
    expect(screen.queryByText('Sign-in password')).not.toBeInTheDocument();
    expect(screen.getByText('agent credentials')).toBeInTheDocument();
  });
});
