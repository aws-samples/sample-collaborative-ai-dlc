import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listMembers = vi.hoisted(() => vi.fn());
const listAssignableUsers = vi.hoisted(() => vi.fn());
const addMember = vi.hoisted(() => vi.fn());

vi.mock('@/services/projects', () => ({
  projectsService: {
    listMembers: (...args: unknown[]) => listMembers(...args),
    listAssignableUsers: (...args: unknown[]) => listAssignableUsers(...args),
    addMember: (...args: unknown[]) => addMember(...args),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
  },
}));

import { MembersTab } from './MembersTab';

beforeEach(() => {
  listMembers
    .mockReset()
    .mockResolvedValue([{ userId: 'existing-sub', email: 'existing@example.com', role: 'member' }]);
  listAssignableUsers.mockReset().mockResolvedValue([
    {
      userId: 'local-sub',
      email: 'shared@example.com',
      displayName: 'Local User',
      enabled: true,
      status: 'CONFIRMED',
      identitySource: 'cognito',
      identityProvider: null,
    },
    {
      userId: 'sso-sub',
      email: 'shared@example.com',
      displayName: 'SSO User',
      enabled: true,
      status: 'EXTERNAL_PROVIDER',
      identitySource: 'sso',
      identityProvider: 'CorporateOIDC',
    },
    {
      userId: 'existing-sub',
      email: 'existing@example.com',
      displayName: 'Existing User',
      enabled: true,
      status: 'CONFIRMED',
      identitySource: 'cognito',
      identityProvider: null,
    },
  ]);
  addMember.mockReset().mockResolvedValue({});
});

describe('MembersTab assignable identity picker', () => {
  it('shows local and federated identities and adds the SSO identity by sub', async () => {
    const user = userEvent.setup();
    render(<MembersTab projectId="project-1" userRole="owner" />);

    await screen.findByText('existing@example.com');
    await user.click(screen.getByRole('button', { name: 'Add Member' }));

    const dialog = screen.getByRole('dialog', { name: 'Add Member' });
    await user.click(within(dialog).getByPlaceholderText('Search by email or name...'));

    expect(await within(dialog).findByText('Local User · Cognito account')).toBeInTheDocument();
    expect(within(dialog).getByText('SSO User · CorporateOIDC')).toBeInTheDocument();
    expect(within(dialog).queryByText('Existing User · Cognito account')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /SSO User · CorporateOIDC/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Member' }));

    await waitFor(() =>
      expect(addMember).toHaveBeenCalledWith('project-1', {
        userId: 'sso-sub',
        email: 'shared@example.com',
        role: 'member',
      }),
    );
  });
});
