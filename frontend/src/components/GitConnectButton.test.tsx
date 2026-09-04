import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/gitProvider', () => ({
  getGitProviderService: () => ({
    getAuthUrl: vi.fn(),
    disconnect: vi.fn(),
  }),
  trackerIdForGitProvider: () => 'github-issues',
}));

vi.mock('@/hooks/useTrackerProviders', () => ({
  useTrackerProviders: () => ({
    providers: [{ id: 'github-issues', configured: true }],
    loading: false,
    failed: false,
  }),
}));

import { GitConnectButton } from './GitConnectButton';

describe('GitConnectButton', () => {
  it('prompts an existing GitHub connection to grant missing scopes', () => {
    render(
      <GitConnectButton
        provider="github"
        connected={false}
        reauthorizationRequired
        missingScopes={['workflow']}
        onDisconnect={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Reauthorize GitHub' })).toBeInTheDocument();
    expect(screen.getByText(/grant workflow permission/)).toBeInTheDocument();
  });

  it('keeps the normal connected state when reauthorization is not required', () => {
    render(<GitConnectButton provider="github" connected onDisconnect={() => {}} />);

    expect(screen.getByText('GitHub Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});
