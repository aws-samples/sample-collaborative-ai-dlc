import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listMembers = vi.hoisted(() => vi.fn());
const listAssignableUsers = vi.hoisted(() => vi.fn());
const addMember = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());

vi.mock('@/services/projects', () => ({
  projectsService: {
    listMembers: (...args: unknown[]) => listMembers(...args),
    listAssignableUsers: (...args: unknown[]) => listAssignableUsers(...args),
    addMember: (...args: unknown[]) => addMember(...args),
    updateMemberRole: vi.fn(),
    removeMember: (...args: unknown[]) => removeMember(...args),
  },
}));

import { MembersTab } from './MembersTab';

beforeEach(() => {
  // Radix Select uses browser APIs that jsdom does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
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
  removeMember.mockReset().mockResolvedValue({});
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

  it('lets an Owner manage another Owner with only the two membership roles', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      { userId: 'other-owner', email: 'owner@example.com', role: 'owner' },
    ]);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await screen.findByText('owner@example.com');
    await user.click(screen.getByRole('combobox', { name: 'Space access for owner@example.com' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Owner',
      'Member',
    ]);
    await user.click(screen.getByRole('option', { name: 'Member' }));
    const roleDialog = screen.getByRole('alertdialog', { name: 'Change Role' });
    expect(within(roleDialog).getByText('Member')).toBeInTheDocument();
    await user.click(within(roleDialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTitle('Remove member'));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Member' });
    expect(
      within(dialog).getByText(/existing realtime connections expire within ten minutes/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(removeMember).not.toHaveBeenCalled();
    await user.click(screen.getByTitle('Remove member'));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('project-1', 'other-owner'));
  });

  it('shows membership without management controls for a Member', async () => {
    render(<MembersTab projectId="project-1" userRole="member" />);
    await screen.findByText('existing@example.com');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Remove member')).not.toBeInTheDocument();
  });
});
