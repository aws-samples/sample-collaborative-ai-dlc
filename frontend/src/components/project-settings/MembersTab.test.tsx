import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listMembers = vi.hoisted(() => vi.fn());
const listAssignableUsers = vi.hoisted(() => vi.fn());
const addMember = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());
const listBusinessRoles = vi.hoisted(() => vi.fn());
const updateMemberBusinessRoles = vi.hoisted(() => vi.fn());

vi.mock('@/services/projects', () => ({
  projectsService: {
    listMembers: (...args: unknown[]) => listMembers(...args),
    listAssignableUsers: (...args: unknown[]) => listAssignableUsers(...args),
    addMember: (...args: unknown[]) => addMember(...args),
    updateMemberRole: vi.fn(),
    removeMember: (...args: unknown[]) => removeMember(...args),
    listBusinessRoles: (...args: unknown[]) => listBusinessRoles(...args),
    updateMemberBusinessRoles: (...args: unknown[]) => updateMemberBusinessRoles(...args),
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
  listBusinessRoles.mockReset().mockResolvedValue([
    { id: 'architect', name: 'Architect' },
    { id: 'developer', name: 'Developer' },
    { id: 'product-owner', name: 'Product Owner / Product Manager' },
  ]);
  updateMemberBusinessRoles
    .mockReset()
    .mockImplementation(async (_projectId, userId, localRoles) => ({
      userId,
      role: 'member',
      localRoles,
    }));
});

describe('space business roles', () => {
  it('lets an Owner add multiple roles, save chips, and clear assignments', async () => {
    const user = userEvent.setup();
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', { name: 'Edit business roles for existing@example.com' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit business roles' });
    for (const name of ['Developer', 'Architect']) {
      await user.click(within(dialog).getByRole('combobox', { name: 'Add a business role' }));
      await user.click(screen.getByRole('option', { name }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateMemberBusinessRoles).toHaveBeenCalledWith('project-1', 'existing-sub', [
        'architect',
        'developer',
      ]),
    );
    expect(screen.getByText('Architect')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Edit business roles for existing@example.com' }),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Architect' }));
    await user.click(screen.getByRole('button', { name: 'Remove Developer' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateMemberBusinessRoles).toHaveBeenLastCalledWith('project-1', 'existing-sub', []),
    );
    expect(screen.getByText('No business roles')).toBeInTheDocument();
  });

  it('cancels without saving and retains the draft when a save is denied', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      { userId: 'member', role: 'member', localRoles: ['architect'] },
    ]);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(await screen.findByRole('button', { name: 'Edit business roles for member' }));
    await user.click(screen.getByRole('button', { name: 'Remove Architect' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateMemberBusinessRoles).not.toHaveBeenCalled();
    expect(screen.getByText('Architect')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit business roles for member' }));
    await user.click(screen.getByRole('button', { name: 'Remove Architect' }));
    updateMemberBusinessRoles.mockRejectedValue(new Error('Space Owner access required'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Space Owner access required');
    expect(screen.getByText('No business roles assigned.')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  it('shows business-role chips to Members without edit controls or management rights', async () => {
    listMembers.mockResolvedValue([
      {
        userId: 'member',
        role: 'member',
        localRoles: ['product-owner', 'developer'],
      },
    ]);
    render(<MembersTab projectId="project-1" userRole="member" />);
    expect(await screen.findByText('Product Owner / Product Manager')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    const icon = (text: string) => screen.getByText(text).querySelector('svg[aria-hidden="true"]');
    expect(icon('Product Owner / Product Manager')).toHaveClass('lucide-lightbulb');
    expect(icon('Developer')).toHaveClass('lucide-code-xml');
    expect(screen.queryByRole('button', { name: /Edit business roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Business roles describe responsibilities for now/),
    ).toBeInTheDocument();
  });

  it('clears the role editor and ignores old member loads when switching spaces', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(await screen.findByRole('button', { name: /Edit business roles/ }));
    let finishOldLoad!: (value: unknown) => void;
    listMembers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldLoad = resolve;
        }),
    );
    rerender(<MembersTab projectId="slow-space" userRole="owner" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    listMembers.mockResolvedValue([
      { userId: 'new-member', role: 'member', localRoles: ['developer'] },
    ]);
    rerender(<MembersTab projectId="new-space" userRole="owner" />);
    expect(await screen.findByText('Developer')).toBeInTheDocument();
    finishOldLoad([{ userId: 'old-member', role: 'member', localRoles: ['architect'] }]);
    await waitFor(() => expect(screen.queryByText('old-member')).not.toBeInTheDocument());
    expect(screen.queryByText('Architect')).not.toBeInTheDocument();
  });
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
