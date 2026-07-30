import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setOAuthConfig = vi.fn();

vi.mock('@/services/trackers', () => ({
  trackersService: {
    setOAuthConfig: (...args: unknown[]) => setOAuthConfig(...args),
  },
}));

import { OAuthAppConfigForm } from './OAuthAppConfigForm';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const openSetupGuide = async () => {
  const user = userEvent.setup();
  render(<OAuthAppConfigForm providerId="github-issues" configured={false} onSaved={() => {}} />);
  await user.click(screen.getByRole('button', { name: /Setup guide/ }));
};

describe('OAuthAppConfigForm', () => {
  it('shows the callback URL for the deployment canonical origin', async () => {
    // The backend builds its redirect URI from the same canonical hostname, so
    // the value an admin pastes into the provider has to match it.
    vi.stubEnv('VITE_APP_ORIGIN', 'https://aidlc.example.com');
    await openSetupGuide();

    expect(
      await screen.findByText('https://aidlc.example.com/github/callback'),
    ).toBeInTheDocument();
  });

  it('shows the canonical callback URL even when browsed via another hostname', async () => {
    vi.stubEnv('VITE_APP_ORIGIN', 'https://aidlc.example.com');
    await openSetupGuide();

    expect(screen.queryByText(`${window.location.origin}/github/callback`)).not.toBeInTheDocument();
  });

  it('falls back to the browsing origin when no canonical origin is configured', async () => {
    vi.stubEnv('VITE_APP_ORIGIN', '');
    await openSetupGuide();

    expect(
      await screen.findByText(`${window.location.origin}/github/callback`),
    ).toBeInTheDocument();
  });
});
