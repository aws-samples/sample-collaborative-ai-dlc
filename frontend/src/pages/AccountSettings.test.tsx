import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { User } from '@/services/auth';

const mocks = vi.hoisted(() => ({ user: null as User | null }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, changePassword: vi.fn() }),
}));
vi.mock('@/components/settings/AgentCredentialScopeCard', () => ({
  AgentCredentialScopeCard: () => <div>agent credentials</div>,
}));

import AccountSettings from './AccountSettings';

const user = (identitySource: User['identitySource'], extra: Partial<User> = {}): User => ({
  userId: '647864d8-0071-7099-6eec-4fad252d5f61',
  username: 'user@example.com',
  groups: [],
  identitySource,
  ...(identitySource === 'sso' ? { identityProvider: 'CorporateOIDC' } : {}),
  ...extra,
});

describe('AccountSettings', () => {
  it('offers a collapsed password change to local Cognito accounts', async () => {
    const actor = userEvent.setup();
    mocks.user = user('cognito');
    render(<AccountSettings />);

    const password = screen.getByRole('button', { name: 'Sign-in password' });
    expect(password).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('agent credentials')).toBeInTheDocument();
    expect(screen.getByText('Password and personal agent keys.')).toBeInTheDocument();

    await actor.click(password);
    expect(screen.getByLabelText('Current password')).toBeVisible();
  });

  it('hides the password change from federated users', () => {
    mocks.user = user('sso');
    render(<AccountSettings />);
    expect(screen.queryByText('Sign-in password')).not.toBeInTheDocument();
    expect(screen.getByText('agent credentials')).toBeInTheDocument();
    expect(screen.getByText(/through CorporateOIDC/)).toBeInTheDocument();
  });

  it('introduces the account by name and email, with the identifier in the title', () => {
    mocks.user = user('cognito', { displayName: 'Hector', email: 'hector@example.com' });
    render(<AccountSettings />);

    expect(screen.getByText(/Signed in as/)).toHaveTextContent(
      'Signed in as Hector · hector@example.com',
    );
    expect(screen.queryByText('647864d8-0071-7099-6eec-4fad252d5f61')).not.toBeInTheDocument();
    expect(screen.getByTitle('User ID 647864d8-0071-7099-6eec-4fad252d5f61')).toBeInTheDocument();
  });

  it('does not repeat the email when it is the only name', () => {
    mocks.user = user('cognito', { email: 'hector@example.com' });
    render(<AccountSettings />);
    expect(screen.getByText(/Signed in as/)).toHaveTextContent(/^Signed in as hector@example.com$/);
  });
});
