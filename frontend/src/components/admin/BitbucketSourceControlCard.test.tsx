import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const getConfig = vi.fn();
const setOAuthConfig = vi.fn();
vi.mock('@/services/gitProvider', () => ({
  bitbucketAdminService: {
    getConfig: (...args: unknown[]) => getConfig(...args),
    setOAuthConfig: (...args: unknown[]) => setOAuthConfig(...args),
  },
}));
vi.mock('./OAuthAppConfigForm', () => ({
  OAuthAppConfigForm: ({ providerId, configured }: { providerId: string; configured: boolean }) => (
    <div data-testid="oauth-form" data-provider={providerId} data-configured={String(configured)} />
  ),
}));

import { BitbucketSourceControlCard } from './BitbucketSourceControlCard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BitbucketSourceControlCard', () => {
  it('loads its OAuth configuration directly from the Bitbucket API', async () => {
    getConfig.mockResolvedValue({ configured: true });

    render(<BitbucketSourceControlCard />);

    expect(await screen.findByTestId('oauth-form')).toHaveAttribute('data-provider', 'bitbucket');
    expect(screen.getByTestId('oauth-form')).toHaveAttribute('data-configured', 'true');
    expect(getConfig).toHaveBeenCalledTimes(1);
  });
});
