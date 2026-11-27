import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Member } from '@/services/projects';

const listMembers = vi.hoisted(() => vi.fn());
const listAssignableUsers = vi.hoisted(() => vi.fn());
const addMember = vi.hoisted(() => vi.fn());
const removeMember = vi.hoisted(() => vi.fn());
const listBusinessRoles = vi.hoisted(() => vi.fn());
const updateMemberBusinessRoles = vi.hoisted(() => vi.fn());
const updateMemberExcludedRoles = vi.hoisted(() => vi.fn());
const getResponsibilities = vi.hoisted(() => vi.fn());
const getEnforcement = vi.hoisted(() => vi.fn());
const setEnforcement = vi.hoisted(() => vi.fn());

vi.mock('@/services/stageResponsibilities', () => ({
  stageResponsibilitiesService: { get: getResponsibilities },
}));

vi.mock('@/services/projects', () => ({
  projectsService: {
    getStageRoleEnforcement: getEnforcement,
    setStageRoleEnforcement: setEnforcement,
    listMembers: (...args: unknown[]) => listMembers(...args),
    listAssignableUsers: (...args: unknown[]) => listAssignableUsers(...args),
    addMember: (...args: unknown[]) => addMember(...args),
    updateMemberRole: vi.fn(),
    removeMember: (...args: unknown[]) => removeMember(...args),
    listBusinessRoles: (...args: unknown[]) => listBusinessRoles(...args),
    updateMemberBusinessRoles: (...args: unknown[]) => updateMemberBusinessRoles(...args),
    updateMemberExcludedRoles: (...args: unknown[]) => updateMemberExcludedRoles(...args),
  },
}));

import { MembersTab } from './MembersTab';

beforeEach(() => {
  getEnforcement
    .mockReset()
    .mockResolvedValue({ platformDefault: true, override: null, enforceStageRoles: true });
  setEnforcement.mockReset();
  getResponsibilities.mockReset().mockResolvedValue({
    previewOnly: true,
    workflowId: 'flow',
    workflowVersion: 3,
    roles: [],
    stages: [],
  });
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
  addMember.mockReset().mockImplementation(async (_projectId, member) => member);
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
  updateMemberExcludedRoles
    .mockReset()
    .mockImplementation(async (_projectId, userId, excludedRoles) => ({
      userId,
      role: 'member',
      excludedRoles,
    }));
});

describe('space business roles', () => {
  it('fetches updated responsibilities after adding and removing business roles', async () => {
    const user = userEvent.setup();
    const initialResponsibilities = {
      previewOnly: true,
      workflowId: 'flow',
      workflowVersion: 3,
      roles: [{ id: 'developer', name: 'Developer' }],
      stages: [
        {
          stageId: 'code-generation',
          stageInstanceId: null,
          gateIds: [],
          name: 'Code Generation',
          permissions: { decisionMakerRoles: ['developer'], contributorRoles: [] },
          reason: 'owners',
          decisionMakers: [],
          contributors: [],
          missingDecisionMakerRoles: ['developer'],
          missingContributorRoles: [],
        },
      ],
    };
    getResponsibilities.mockResolvedValue(initialResponsibilities);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await screen.findByText('Code Generation');
    const row = () => screen.getByText('Code Generation').closest('tr')!;
    expect(within(row()).queryByText('existing@example.com')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Edit business roles for existing@example.com' }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Roles added in this space' }));
    await user.click(screen.getByRole('option', { name: 'Developer' }));
    // Draft edits must not update the saved preview.
    expect(within(row()).queryByText('existing@example.com')).not.toBeInTheDocument();
    getResponsibilities.mockResolvedValue({
      ...initialResponsibilities,
      stages: [
        {
          ...initialResponsibilities.stages[0],
          reason: 'decision-makers',
          decisionMakers: [
            { userId: 'existing-sub', email: 'existing@example.com', roles: ['developer'] },
          ],
          missingDecisionMakerRoles: [],
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(row()).getByText('existing@example.com')).toBeInTheDocument(),
    );
    expect(within(row()).getByText('Developer')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Edit business roles for existing@example.com' }),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Developer' }));
    getResponsibilities.mockResolvedValue(initialResponsibilities);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(row()).queryByText('existing@example.com')).not.toBeInTheDocument(),
    );
    expect(within(row()).getAllByRole('img', { name: 'No members' })).toHaveLength(2);
    expect(getResponsibilities).toHaveBeenCalledTimes(3);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'preserves policy-selected people when loading members fails=%s',
    async (fails) => {
      const response = {
        previewOnly: true,
        workflowId: 'flow',
        workflowVersion: 3,
        roles: [],
        stages: [
          {
            stageId: 'design',
            name: 'Design',
            permissions: { decisionMakerRoles: ['product-owner'], contributorRoles: [] },
            reason: 'decision-makers',
            decisionMakers: [
              { userId: 'architect', name: 'Policy-selected architect', roles: ['architect'] },
            ],
            contributors: [],
          },
        ],
      };
      getResponsibilities.mockResolvedValue(response);
      if (fails) listMembers.mockRejectedValue(new Error('Members unavailable'));
      else
        listMembers.mockResolvedValue([
          {
            userId: 'po',
            email: 'po@example.com',
            role: 'member',
            effectiveRoles: ['product-owner'],
          },
        ]);
      render(<MembersTab projectId="project-1" userRole="owner" />);
      await screen.findByText(fails ? 'Members unavailable' : 'po@example.com');
      const row = (await screen.findByText('Design')).closest('tr')!;
      expect(row).toHaveTextContent('Policy-selected architect');
      expect(row).not.toHaveTextContent('po@example.com');
      expect(row).not.toHaveTextContent('Space Owners decide');
    },
  );

  it('refreshes responsibilities when local roles save but SSO exclusions fail', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      {
        userId: 'alice',
        email: 'alice@example.com',
        role: 'member',
        localRoles: [],
        ssoRoles: ['architect'],
        excludedRoles: [],
      },
    ]);
    updateMemberExcludedRoles.mockRejectedValue(new Error('Exclusion failed'));
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', { name: 'Edit business roles for alice@example.com' }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Roles added in this space' }));
    await user.click(screen.getByRole('option', { name: 'Developer' }));
    await user.click(screen.getByRole('button', { name: 'Exclude Architect' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Exclusion failed');
    await waitFor(() => expect(getResponsibilities).toHaveBeenCalledTimes(2));
    expect(updateMemberBusinessRoles).toHaveBeenCalledWith('project-1', 'alice', ['developer']);
  });

  it('loads stage responsibilities in a separate block below Members without a popup', async () => {
    render(<MembersTab projectId="project-1" userRole="member" />);
    await screen.findByRole('columnheader', { name: 'Decision Makers' });
    const members = screen.getByRole('heading', { name: 'Members' });
    const responsibilities = screen.getByRole('heading', { name: 'Stage responsibilities' });
    expect(
      members.compareDocumentPosition(responsibilities) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getResponsibilities).toHaveBeenCalledWith('project-1', {});
    expect(
      screen.queryByRole('button', { name: 'Stage responsibilities' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('flow · Version 3')).not.toBeInTheDocument();
  });

  it('lets an Owner add multiple roles, save chips, and clear assignments', async () => {
    const user = userEvent.setup();
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit business roles for existing@example.com',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit business roles' });
    for (const name of ['Developer', 'Architect']) {
      await user.click(
        within(dialog).getByRole('combobox', {
          name: 'Roles added in this space',
        }),
      );
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
      screen.getByRole('button', {
        name: 'Edit business roles for existing@example.com',
      }),
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
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit business roles for member',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Architect' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateMemberBusinessRoles).not.toHaveBeenCalled();
    expect(screen.getByText('Architect')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit business roles for member' }));
    await user.click(screen.getByRole('button', { name: 'Remove Architect' }));
    updateMemberBusinessRoles.mockRejectedValue(new Error('Space Owner access required'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Space Owner access required');
    expect(screen.getByText('No roles added in this space.')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  it('lets an Owner turn off the platform default for this space and restore inheritance', async () => {
    setEnforcement
      .mockResolvedValueOnce({ platformDefault: true, override: false, enforceStageRoles: false })
      .mockResolvedValueOnce({ platformDefault: true, override: null, enforceStageRoles: true });
    const user = userEvent.setup();
    render(<MembersTab projectId="project-1" userRole="owner" />);
    const toggle = await screen.findByRole('switch', { name: 'Enforce business roles' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      'Stage responsibilities determine who can edit and decide in this space',
    );
    await user.click(toggle);
    expect(setEnforcement).toHaveBeenCalledWith('project-1', false);
    await waitFor(() =>
      expect(toggle).toHaveAccessibleDescription(
        'Space Owners and Members can answer and approve stage questions',
      ),
    );
    expect(screen.queryByText(/Space Settings → Members/)).not.toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Use platform default' }));
    expect(setEnforcement).toHaveBeenCalledWith('project-1', null);
    expect(toggle).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Use platform default' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('switch', { name: 'Enforce business roles' })).toBeDisabled();
    const icon = (text: string) => screen.getByText(text).querySelector('svg[aria-hidden="true"]');
    expect(icon('Product Owner / Product Manager')).toHaveClass('lucide-lightbulb');
    expect(icon('Developer')).toHaveClass('lucide-code-xml');
    expect(screen.queryByRole('button', { name: /Edit business roles/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Space Owners can manage business role assignments here.'),
    ).toBeInTheDocument();
  });

  it('lets an Owner exclude and restore inherited SSO roles while local roles use Remove', async () => {
    const user = userEvent.setup();
    const alice = {
      userId: 'alice',
      email: 'alice@example.com',
      role: 'member' as const,
      localRoles: ['product-owner'],
      ssoRoles: ['architect', 'developer'],
      excludedRoles: [],
      effectiveRoles: ['architect', 'developer', 'product-owner'],
    };
    listMembers.mockResolvedValue([alice]);
    updateMemberExcludedRoles.mockResolvedValue({
      userId: 'alice',
      role: 'member',
      localRoles: ['product-owner'],
      ssoRoles: ['architect', 'developer'],
      excludedRoles: ['developer'],
      effectiveRoles: ['architect', 'product-owner'],
    });
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit business roles for alice@example.com',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit business roles' });
    // Company roles offer Exclude/Restore; only local roles have Remove.
    expect(within(dialog).getByRole('button', { name: 'Exclude Developer' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', {
        name: 'Remove Product Owner / Product Manager',
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Remove Developer' }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Exclude Developer' }));
    expect(within(dialog).getByRole('button', { name: 'Restore Developer' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateMemberExcludedRoles).toHaveBeenCalledWith('project-1', 'alice', ['developer']),
    );
    // Only the exclusion changed, so local assignments are not re-saved.
    expect(updateMemberBusinessRoles).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The row now shows the effective roles (SSO − excluded + local).
    expect(screen.getByText('Architect')).toBeInTheDocument();
    expect(screen.getByText('Product Owner / Product Manager')).toBeInTheDocument();
    expect(screen.queryByText('Developer')).not.toBeInTheDocument();
  });

  it('keeps a persisted exclusion editable when the role is no longer received from SSO', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      {
        userId: 'member',
        email: 'member@example.com',
        role: 'member',
        localRoles: [],
        ssoRoles: [],
        excludedRoles: ['developer'],
        effectiveRoles: [],
      },
    ]);
    updateMemberExcludedRoles.mockResolvedValue({
      userId: 'member',
      role: 'member',
      localRoles: [],
      ssoRoles: [],
      excludedRoles: [],
      effectiveRoles: [],
    });
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', { name: 'Edit business roles for member@example.com' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit business roles' });
    // The dormant exclusion is visible, flagged, and restorable.
    expect(within(dialog).getByText('(not currently received)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore Developer' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateMemberExcludedRoles).toHaveBeenCalledWith('project-1', 'member', []),
    );
  });

  it('keeps the draft and shows the error when an exclusion save is denied', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      {
        userId: 'member',
        role: 'member',
        localRoles: [],
        ssoRoles: ['developer'],
        excludedRoles: [],
        effectiveRoles: ['developer'],
      },
    ]);
    updateMemberExcludedRoles.mockRejectedValue(new Error('Space Owner access required'));
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit business roles for member',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit business roles' });
    await user.click(within(dialog).getByRole('button', { name: 'Exclude Developer' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Space Owner access required');
    expect(within(dialog).getByRole('button', { name: 'Restore Developer' })).toBeInTheDocument();
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
  it.each(['pending', 'failed'])(
    'uses hydrated SSO roles while the responsibilities request is %s',
    async (requestState) => {
      const user = userEvent.setup();
      const owner: Member = { userId: 'owner', email: 'owner@example.com', role: 'owner' };
      listMembers.mockResolvedValueOnce([owner]);
      let resolveMembers!: (members: Member[]) => void;
      listMembers.mockImplementationOnce(
        () =>
          new Promise<Member[]>((resolve) => {
            resolveMembers = resolve;
          }),
      );
      addMember.mockResolvedValueOnce({
        projectId: 'project-1',
        userId: 'sso-sub',
        role: 'member',
      });
      getResponsibilities.mockResolvedValueOnce({
        previewOnly: true,
        workflowId: 'flow',
        workflowVersion: 3,
        roles: [{ id: 'architect', name: 'Architect' }],
        stages: [
          {
            stageId: 'design',
            name: 'Design',
            permissions: { decisionMakerRoles: ['architect'], contributorRoles: [] },
            reason: 'owners',
            decisionMakers: [{ userId: owner.userId, email: owner.email, roles: [] }],
            contributors: [],
            missingDecisionMakerRoles: ['architect'],
            missingContributorRoles: [],
          },
        ],
      });
      if (requestState === 'failed') {
        getResponsibilities.mockRejectedValueOnce(new Error('Responsibilities unavailable'));
      } else {
        getResponsibilities.mockImplementationOnce(() => new Promise(() => {}));
      }
      render(<MembersTab projectId="project-1" userRole="owner" />);
      const row = await screen.findByRole('row', { name: /Design/ });
      const decisionMakers = within(row).getAllByRole('cell')[1];
      expect(decisionMakers).toHaveTextContent('owner@example.com');
      await user.click(screen.getByRole('button', { name: 'Add Member' }));
      const dialog = screen.getByRole('dialog', { name: 'Add Member' });
      await user.click(within(dialog).getByPlaceholderText('Search by email or name...'));
      await user.click(
        await within(dialog).findByRole('button', { name: /SSO User · CorporateOIDC/ }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Add Member' }));
      await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
      expect(decisionMakers).toHaveTextContent('owner@example.com');
      if (requestState === 'failed') {
        await screen.findByText('Responsibilities unavailable');
      }
      await act(async () =>
        resolveMembers([
          owner,
          {
            userId: 'sso-sub',
            email: 'shared@example.com',
            role: 'member',
            localRoles: [],
            ssoRoles: ['architect'],
            effectiveRoles: ['architect'],
          },
        ]),
      );
      expect(decisionMakers).toHaveTextContent('shared@example.com');
      expect(decisionMakers).toHaveTextContent('Architect');
      expect(decisionMakers).not.toHaveTextContent('owner@example.com');
      expect(screen.queryByText('Loading responsibilities…')).not.toBeInTheDocument();
      expect(getResponsibilities).toHaveBeenCalledTimes(2);
    },
  );

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

  it('lets an Owner manage another Owner with the three membership roles', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      { userId: 'other-owner', email: 'owner@example.com', role: 'owner' },
    ]);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await screen.findByText('owner@example.com');
    await user.click(
      screen.getByRole('combobox', {
        name: 'Space access for owner@example.com',
      }),
    );
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Owner',
      'Member',
      'Viewer',
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

  it('explains that a member becoming a Viewer keeps business roles that no longer apply', async () => {
    const user = userEvent.setup();
    listMembers.mockResolvedValue([
      {
        userId: 'architect-sub',
        email: 'architect@example.com',
        role: 'member',
        effectiveRoles: ['architect', 'developer'],
      },
    ]);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await screen.findByText('architect@example.com');
    await user.click(
      screen.getByRole('combobox', { name: 'Space access for architect@example.com' }),
    );
    await user.click(screen.getByRole('option', { name: 'Viewer' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Change Role' });
    expect(dialog).toHaveTextContent('cannot decide or contribute to any stage');
    expect(dialog).toHaveTextContent(
      'Their business roles (Architect, Developer) stay assigned and apply again if they become a Member or Owner.',
    );
  });

  it('shows a Viewer business roles as inactive', async () => {
    listMembers.mockResolvedValue([
      {
        userId: 'viewer-sub',
        email: 'viewer@example.com',
        role: 'viewer',
        effectiveRoles: ['architect'],
      },
    ]);
    render(<MembersTab projectId="project-1" userRole="owner" />);
    await screen.findByText('viewer@example.com');
    expect(screen.getByText('Inactive while Viewer')).toBeInTheDocument();
    expect(screen.getByText('Architect').closest('[class*="border-dashed"]')).not.toBeNull();
  });

  it('shows membership without management controls for a Member', async () => {
    render(<MembersTab projectId="project-1" userRole="member" />);
    await screen.findByText('existing@example.com');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Remove member')).not.toBeInTheDocument();
  });
});
