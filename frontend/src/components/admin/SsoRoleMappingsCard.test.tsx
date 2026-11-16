import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());

vi.mock('@/services/ssoRoleMappings', () => ({
  ssoRoleMappingsService: {
    get: (...args: unknown[]) => get(...args),
    save: (...args: unknown[]) => save(...args),
  },
}));

import { SsoRoleMappingsCard } from './SsoRoleMappingsCard';

const businessRoles = [
  { id: 'architect', name: 'Architect' },
  { id: 'developer', name: 'Developer' },
];

beforeEach(() => {
  get.mockReset();
  save.mockReset();
});

describe('SsoRoleMappingsCard', () => {
  it('shows a single connection directly with its source attribute and saves edited values', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      providers: [
        {
          providerId: 'Entra',
          displayName: 'Entra ID',
          sourceAttribute: 'groups',
          roleMappings: { developer: ['Engineering'] },
          revision: 'rev-1',
        },
      ],
      businessRoles,
    });
    save.mockResolvedValue({
      providerId: 'Entra',
      roleMappings: { developer: ['Contractors', 'Engineering'] },
      revision: 'rev-2',
    });
    render(<SsoRoleMappingsCard />);
    expect(await screen.findByText('Entra ID')).toBeInTheDocument();
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
        },
      ],
      businessRoles,
    });
    render(<SsoRoleMappingsCard />);
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
    // Removing every value tells the admin the role will be unmapped.
    expect(
      within(dialog).getByText(/Saving removes this role from the mapping/),
    ).toBeInTheDocument();
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
          revision: null,
        },
        {
          providerId: 'Legacy',
          displayName: 'Legacy SAML',
          sourceAttribute: '',
          roleMappings: {},
          revision: null,
        },
      ],
      businessRoles,
    });
    render(<SsoRoleMappingsCard />);
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

  it('explains when no SSO connection is configured', async () => {
    get.mockResolvedValue({ providers: [], businessRoles });
    render(<SsoRoleMappingsCard />);
    expect(
      await screen.findByText(/No enterprise SSO connection is configured/),
    ).toBeInTheDocument();
  });
});
