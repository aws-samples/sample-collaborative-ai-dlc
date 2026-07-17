import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Covers the card's mode-conditional rendering: OAuth credentials only in
// OAuth mode, GitHub App fields only in App mode, and the mode-switch save
// affordance.

const getConfig = vi.fn();
const updateConfig = vi.fn();
vi.mock('@/services/gitProvider', () => ({
  githubAdminService: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    updateConfig: (...a: unknown[]) => updateConfig(...a),
  },
}));
vi.mock('./OAuthAppConfigForm', () => ({
  OAuthAppConfigForm: ({ providerId }: { providerId: string }) => (
    <div data-testid="oauth-form" data-provider={providerId} />
  ),
}));

import { GitHubSourceControlCard } from './GitHubSourceControlCard';

const baseConfig = (over: Record<string, unknown> = {}) => ({
  mode: 'oauth',
  appId: null,
  installationId: null,
  privateKeySet: false,
  appConfigured: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubSourceControlCard', () => {
  it('shows OAuth app credentials (not App config) in OAuth mode', async () => {
    getConfig.mockResolvedValue(baseConfig());
    render(<GitHubSourceControlCard oauthConfigured onOAuthSaved={() => {}} />);

    expect(await screen.findByTestId('oauth-form')).toHaveAttribute(
      'data-provider',
      'github-issues',
    );
    expect(screen.queryByLabelText('App ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Private Key/)).not.toBeInTheDocument();
    // No mode change pending → no save button either.
    expect(screen.queryByRole('button', { name: /Save|Switch/ })).not.toBeInTheDocument();
  });

  it('shows GitHub App fields (not OAuth credentials) when App mode is selected', async () => {
    getConfig.mockResolvedValue(baseConfig());
    const user = userEvent.setup();
    render(<GitHubSourceControlCard oauthConfigured onOAuthSaved={() => {}} />);

    await screen.findByTestId('oauth-form');
    await user.click(screen.getByRole('button', { name: /GitHub App \(bot\)/ }));

    expect(screen.queryByTestId('oauth-form')).not.toBeInTheDocument();
    expect(screen.getByLabelText('App ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Installation ID')).toBeInTheDocument();
    expect(screen.getByLabelText(/Private Key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & switch to App mode' })).toBeInTheDocument();
    // Warns that the switch is live-validated.
    expect(screen.getByText(/validated live against GitHub/)).toBeInTheDocument();
  });

  it('saves the mode switch with the app fields', async () => {
    getConfig.mockResolvedValue(baseConfig());
    updateConfig.mockResolvedValue(
      baseConfig({
        mode: 'app',
        appId: '123',
        installationId: '456',
        privateKeySet: true,
        appConfigured: true,
        installationAccount: 'acme',
      }),
    );
    const user = userEvent.setup();
    render(<GitHubSourceControlCard oauthConfigured onOAuthSaved={() => {}} />);

    await screen.findByTestId('oauth-form');
    await user.click(screen.getByRole('button', { name: /GitHub App \(bot\)/ }));
    await user.type(screen.getByLabelText('App ID'), '123');
    await user.type(screen.getByLabelText('Installation ID'), '456');
    await user.type(screen.getByLabelText(/Private Key/), 'PEM');
    await user.click(screen.getByRole('button', { name: 'Save & switch to App mode' }));

    expect(updateConfig).toHaveBeenCalledWith({
      mode: 'app',
      appId: '123',
      installationId: '456',
      privateKey: 'PEM',
    });
    expect(await screen.findByText(/installation verified \(@acme\)/)).toBeInTheDocument();
  });

  it('starts in App mode when configured that way and offers switching back', async () => {
    getConfig.mockResolvedValue(
      baseConfig({
        mode: 'app',
        appId: '123',
        installationId: '456',
        privateKeySet: true,
        appConfigured: true,
      }),
    );
    const user = userEvent.setup();
    render(<GitHubSourceControlCard oauthConfigured={false} onOAuthSaved={() => {}} />);

    expect(await screen.findByLabelText('App ID')).toHaveValue('123');
    expect(screen.queryByTestId('oauth-form')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /OAuth \(user accounts\)/ }));
    expect(screen.getByTestId('oauth-form')).toBeInTheDocument();
    expect(screen.queryByLabelText('App ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to OAuth mode' })).toBeInTheDocument();
  });

  it('shows a live GitHub App permission validation error', async () => {
    getConfig.mockResolvedValue(
      baseConfig({
        mode: 'app',
        appId: '123',
        installationId: '456',
        privateKeySet: true,
        appConfigured: false,
        appConfigurationError:
          'GitHub App installation is missing required permissions: workflows:write',
      }),
    );

    render(<GitHubSourceControlCard oauthConfigured={false} onOAuthSaved={() => {}} />);

    expect(await screen.findByText(/workflows:write/)).toBeInTheDocument();
    expect(screen.getByText(/App mode · setup needed/)).toBeInTheDocument();
  });
});
