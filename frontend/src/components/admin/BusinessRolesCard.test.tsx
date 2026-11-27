import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
const getEnforcement = vi.hoisted(() => vi.fn());
const updateSettings = vi.hoisted(() => vi.fn());

vi.mock('@/services/agents', () => ({
  agentsService: { getStageRoleEnforcement: getEnforcement, updateSettings },
}));

vi.mock('@/services/ssoRoleMappings', () => ({
  ssoRoleMappingsService: {
    get: (...args: unknown[]) => get(...args),
    save: (...args: unknown[]) => save(...args),
  },
}));

import { BusinessRolesCard } from './BusinessRolesCard';

const businessRoles = [
  { id: 'architect', name: 'Architect' },
  { id: 'developer', name: 'Developer' },
];

beforeEach(() => {
  get.mockReset();
  save.mockReset();
  getEnforcement.mockReset().mockResolvedValue({ enforceStageRoles: false });
  updateSettings.mockReset();
});

describe('BusinessRolesCard', () => {
  it('lets an admin toggle enforcement without an SSO provider and keeps the saved value on error', async () => {
    get.mockResolvedValue({ providers: [], businessRoles });
    updateSettings
      .mockResolvedValueOnce({ saved: true })
      .mockRejectedValueOnce(new Error('unavailable'));
    const user = userEvent.setup();
    render(<BusinessRolesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Enforce business roles' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({ enforceStageRoles: true });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({ enforceStageRoles: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(toggle).toBeChecked();
  });

  it('keeps Terraform values read-only and saves only additions, including values present in both sources', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      providers: [
        {
          providerId: 'Entra',
          displayName: 'Entra ID',
          sourceAttribute: 'groups',
          roleMappings: { developer: ['Shared', 'Contractors'] },
          terraformRoleMappings: { developer: ['Engineering', 'Shared'] },
          effectiveRoleMappings: { developer: ['Contractors', 'Engineering', 'Shared'] },
          revision: 'rev-1',
        },
      ],
      businessRoles,
    });
    save.mockResolvedValue({
      providerId: 'Entra',
      roleMappings: {},
      terraformRoleMappings: { developer: ['Engineering', 'Shared'] },
      effectiveRoleMappings: { developer: ['Engineering', 'Shared'] },
      revision: 'rev-2',
    });
    render(<BusinessRolesCard />);
    const editButton = await screen.findByRole('button', { name: 'Edit IdP values for Developer' });
    expect(within(screen.getByRole('table')).getAllByText('Read-only')).toHaveLength(2);
    await user.click(editButton);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Read-only values. Change these/)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Remove Engineering' }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove Shared' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove Contractors' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('Entra', {}, 'rev-1'));
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Shared')).toBeInTheDocument();
    expect(screen.queryByText('Contractors')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByText('Read-only')).toHaveLength(2);
  });

  it('shows a single connection directly with its source attribute and saves edited values', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      providers: [
        {
          providerId: 'Entra',
          displayName: 'Entra ID',
          sourceAttribute: 'groups',
          roleMappings: { developer: ['Engineering'] },
          terraformRoleMappings: {},
          effectiveRoleMappings: { developer: ['Engineering'] },
          revision: 'rev-1',
        },
      ],
      businessRoles,
    });
    save.mockResolvedValue({
      providerId: 'Entra',
      roleMappings: { developer: ['Contractors', 'Engineering'] },
      terraformRoleMappings: {},
      effectiveRoleMappings: { developer: ['Contractors', 'Engineering'] },
      revision: 'rev-2',
    });
    render(<BusinessRolesCard />);
    const mappings = await screen.findByRole('region', { name: 'SSO mappings' });
    expect(within(mappings).getByText('Entra ID')).toBeInTheDocument();
    expect(within(mappings).getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enforce business roles' })).not.toBeChecked();
    expect(within(mappings).queryByRole('switch')).not.toBeInTheDocument();
    // One connection: shown directly, no selector.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('groups')).toBeInTheDocument();
    expect(screen.getByText(/does not verify they exist/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit IdP values for Developer' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'IdP value' }), 'Contractors');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // The loaded revision rides along so stale saves are rejected server-side.
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'Entra',
        { developer: ['Engineering', 'Contractors'] },
        'rev-1',
      ),
    );
    expect(screen.getByText('Contractors')).toBeInTheDocument();
  });

  it('cancels without saving and surfaces a denied save', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      providers: [
        {
          providerId: 'Entra',
          displayName: 'Entra ID',
          sourceAttribute: 'groups',
          roleMappings: { developer: ['Engineering'] },
          terraformRoleMappings: {},
          effectiveRoleMappings: { developer: ['Engineering'] },
        },
      ],
      businessRoles,
    });
    render(<BusinessRolesCard />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit IdP values for Developer',
      }),
    );
    let dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Engineering' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('Engineering')).toBeInTheDocument();

    save.mockRejectedValue(new Error('Platform administrator access required'));
    await user.click(screen.getByRole('button', { name: 'Edit IdP values for Developer' }));
    dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Engineering' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Platform administrator access required',
    );
    // Removing additions preserves the infrastructure baseline.
    expect(within(dialog).getByText(/Saving keeps any read-only values/)).toBeInTheDocument();
  });

  it('shows a selector only with several connections and blocks editing without a source attribute', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    get.mockResolvedValue({
      providers: [
        {
          providerId: 'Entra',
          displayName: 'Entra ID',
          sourceAttribute: 'groups',
          roleMappings: {},
          terraformRoleMappings: {},
          effectiveRoleMappings: {},
          revision: null,
        },
        {
          providerId: 'Legacy',
          displayName: 'Legacy SAML',
          sourceAttribute: '',
          roleMappings: {},
          terraformRoleMappings: {},
          effectiveRoleMappings: {},
          revision: null,
        },
      ],
      businessRoles,
    });
    render(<BusinessRolesCard />);
    const selector = await screen.findByRole('combobox', {
      name: 'SSO connection',
    });
    await user.click(selector);
    await user.click(screen.getByRole('option', { name: 'Legacy SAML' }));
    expect(
      screen.getByText(/Complete SSO setup before saving business-role mappings/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit IdP values for Developer' }),
    ).not.toBeInTheDocument();
  });

  it('shows where to assign roles manually and omits SSO mappings when there are no providers', async () => {
    get.mockResolvedValue({ providers: [], businessRoles });
    render(<BusinessRolesCard />);
    expect(
      await screen.findByText(
        'Space Owners can assign business roles in Space Settings → Members.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Business roles' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'SSO mappings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
