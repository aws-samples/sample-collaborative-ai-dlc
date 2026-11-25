import { StrictMode } from 'react';
import { render, screen, waitFor } from '@/test/query';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({ panelsInline: false }));
vi.mock('@/hooks/usePanelsInline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/usePanelsInline')>()),
  usePanelsInline: () => layout.panelsInline,
}));

import { GitOAuthCallback } from './GitOAuthCallback';

beforeEach(() => {
  layout.panelsInline = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function CurrentLocation() {
  const { pathname, search } = useLocation();
  return <span data-testid="current-location">{pathname + search}</span>;
}
function show(query: string) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/github/callback?${query}`]}>
        <CurrentLocation />
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

it.each([
  [false, '/spaces'],
  [true, '/dashboard'],
])(
  'without a settings page to resume, continues the Create space flow where the spaces are (inline: %s)',
  async (panelsInline, home) => {
    layout.panelsInline = panelsInline;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true }) }));
    show('code=sample&state=s');
    await waitFor(
      () =>
        expect(screen.getByTestId('current-location')).toHaveTextContent(
          `${home}?reopenCreateSpace=1&gitProvider=github`,
        ),
      { timeout: 3000 },
    );
  },
);

it('carries the self-managed GitLab instance back to the Create space flow', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: async () => ({ success: true, instance: 'git.example.org' }),
    }),
  );
  render(
    <MemoryRouter initialEntries={['/gitlab/callback?code=sample&state=s']}>
      <CurrentLocation />
      <GitOAuthCallback trackerProviderId="gitlab-issues" />
    </MemoryRouter>,
  );
  await waitFor(
    () =>
      expect(screen.getByTestId('current-location')).toHaveTextContent(
        '/spaces?reopenCreateSpace=1&gitProvider=gitlab&gitlabInstance=git.example.org',
      ),
    { timeout: 3000 },
  );
});

it('labels the error return by its destination', () => {
  layout.panelsInline = true;
  vi.stubGlobal('fetch', vi.fn());
  show('error=access_denied');
  expect(screen.getByRole('link', { name: 'Back to My work' })).toHaveAttribute(
    'href',
    '/dashboard',
  );
});
