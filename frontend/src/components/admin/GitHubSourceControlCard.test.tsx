import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getConfig = vi.fn();
const updateConfig = vi.fn();
vi.mock('@/services/gitProvider', () => ({
  githubAdminService: {
    getConfig: (...args: unknown[]) => getConfig(...args),
    updateConfig: (...args: unknown[]) => updateConfig(...args),
  },
}));
vi.mock('./OAuthAppConfigForm', () => ({
  OAuthAppConfigForm: ({ providerId }: { providerId: string }) => (
    <div data-testid="oauth-form" data-provider={providerId} />
  ),
}));

import { GitHubSourceControlCard } from './GitHubSourceControlCard';

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  oauthConfigured: false,
  appId: null,
  privateKeySet: false,
  appConfigured: false,
  appIdentity: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubSourceControlCard', () => {
  it('shows OAuth and App configuration simultaneously without an installation id', async () => {
    getConfig.mockResolvedValue(baseConfig());
    render(<GitHubSourceControlCard oauthConfigured onOAuthSaved={() => {}} />);

    expect(await screen.findByTestId('oauth-form')).toHaveAttribute(
      'data-provider',
      'github-issues',
    );
    expect(screen.getByLabelText('App ID')).toBeInTheDocument();
    expect(screen.getByLabelText(/Private Key/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Installation ID')).not.toBeInTheDocument();
    expect(screen.queryByText(/App mode|OAuth mode/)).not.toBeInTheDocument();
  });

  it('saves only platform App identity fields', async () => {
    getConfig.mockResolvedValue(baseConfig());
    updateConfig.mockResolvedValue(
      baseConfig({
        appId: '123',
        privateKeySet: true,
        appConfigured: true,
        appIdentity: 'aidlc[bot]',
      }),
    );
    const user = userEvent.setup();
    render(<GitHubSourceControlCard oauthConfigured={false} onOAuthSaved={() => {}} />);

    await screen.findByTestId('oauth-form');
    await user.type(screen.getByLabelText('App ID'), '123');
    await user.type(screen.getByLabelText(/Private Key/), 'PEM');
    await user.click(screen.getByRole('button', { name: 'Save GitHub App Settings' }));

    expect(updateConfig).toHaveBeenCalledWith({
      appId: '123',
      privateKey: 'PEM',
    });
    expect(await screen.findByText('Saved and verified')).toBeInTheDocument();
    expect(screen.getByText('aidlc[bot]')).toBeInTheDocument();
  });

  it('shows App validation errors while leaving OAuth configuration available', async () => {
    getConfig.mockResolvedValue(
      baseConfig({
        appId: '123',
        privateKeySet: true,
        appConfigurationError: 'GitHub App credentials are invalid',
      }),
    );

    render(<GitHubSourceControlCard oauthConfigured onOAuthSaved={() => {}} />);

    expect(await screen.findByText('GitHub App credentials are invalid')).toBeInTheDocument();
    expect(screen.getByTestId('oauth-form')).toBeInTheDocument();
  });
});
