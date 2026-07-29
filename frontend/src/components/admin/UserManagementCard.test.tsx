import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const list = vi.fn();
const setPlatformAdmin = vi.fn();

vi.mock('@/services/adminUsers', () => ({
  adminUsersService: {
    list: (...args: unknown[]) => list(...args),
    setPlatformAdmin: (...args: unknown[]) => setPlatformAdmin(...args),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'local-admin' } }),
}));

import { UserManagementCard } from './UserManagementCard';

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([
    {
      userId: 'local-1',
      username: 'local-admin',
      email: 'local@example.com',
      displayName: 'Local Admin',
      enabled: true,
      status: 'CONFIRMED',
      platformAdmin: true,
      identitySource: 'cognito',
      mappedRoles: [],
      roleManagedExternally: false,
      accessGranted: true,
    },
    {
      userId: 'sso-1',
      username: 'CorporateOIDC_sso-1',
      email: 'sso@example.com',
      displayName: 'SSO Admin',
      enabled: true,
      status: 'EXTERNAL_PROVIDER',
      platformAdmin: true,
      identitySource: 'sso',
      identityProvider: 'CorporateOIDC',
      mappedRoles: ['platform-admin'],
      roleManagedExternally: true,
      accessGranted: true,
    },
    {
      userId: 'sso-denied',
      username: 'CorporateOIDC_sso-denied',
      email: 'denied@example.com',
      displayName: 'Denied SSO User',
      enabled: true,
      status: 'EXTERNAL_PROVIDER',
      platformAdmin: false,
      identitySource: 'sso',
      identityProvider: 'CorporateOIDC',
      mappedRoles: [],
      roleManagedExternally: true,
      accessGranted: false,
    },
  ]);
});

describe('UserManagementCard role ownership', () => {
  it('marks federated roles read-only while retaining local Cognito controls', async () => {
    render(<UserManagementCard />);

    expect(await screen.findAllByText('Managed by CorporateOIDC')).toHaveLength(2);
    expect(screen.getAllByText('Read only')).toHaveLength(2);
    expect(screen.getByText('access denied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke admin' })).toBeDisabled();
    expect(setPlatformAdmin).not.toHaveBeenCalled();
  });
});
