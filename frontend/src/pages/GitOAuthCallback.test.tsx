import { StrictMode } from 'react';
import { render, screen, waitFor } from '@/test/query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { GitOAuthCallback } from './GitOAuthCallback';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function show(query: string) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/github/callback?${query}`]}>
        <GitOAuthCallback trackerProviderId="github-issues" />
      </MemoryRouter>
    </StrictMode>,
  );
}

it('returns a declined connection to its settings tab without restarting the picker', () => {
  const exchange = vi.fn();
  vi.stubGlobal('fetch', exchange);
  sessionStorage.setItem(
    'oauth_return_to',
    '/space/example/settings?tab=trackers&addJiraProject=1#connections',
  );
  show('error=access_denied');
  expect(screen.getByText('Authorization was not granted.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Back to space settings' })).toHaveAttribute(
    'href',
    '/space/example/settings?tab=trackers#connections',
  );
  expect(exchange).not.toHaveBeenCalled();
});

it('exchanges a single-use code once when effects replay, and keeps query values intact', async () => {
  const exchange = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', exchange);
  show('code=sample%2Bcode&state=a%26b');
  await waitFor(() => expect(screen.getByRole('heading', { name: /connected$/ })).toBeVisible());
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange.mock.calls[0][0]).toContain('code=sample%2Bcode&state=a%26b');
});
