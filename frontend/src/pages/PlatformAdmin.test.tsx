import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The page is exercised with mocked services and stubbed heavy cards — these
// tests cover PlatformAdmin's OWN logic: tab rendering, URL <-> tab sync, and
// the provider-status plumbing into the Source Control / Trackers tabs.

vi.mock('@/components/admin/UserManagementCard', () => ({
  UserManagementCard: () => <div data-testid="user-management-card" />,
}));
vi.mock('@/components/admin/AgentCredentialsCard', () => ({
  AgentCredentialsCard: () => <div data-testid="agent-credentials-card" />,
}));
vi.mock('@/components/admin/DefaultModelsCard', () => ({
  DefaultModelsCard: () => <div data-testid="default-models-card" />,
}));
vi.mock('@/components/admin/GitHubSourceControlCard', () => ({
  GitHubSourceControlCard: ({ oauthConfigured }: { oauthConfigured: boolean }) => (
    <div data-testid="github-card" data-oauth-configured={String(oauthConfigured)} />
  ),
}));
vi.mock('@/components/admin/BitbucketSourceControlCard', () => ({
  BitbucketSourceControlCard: () => <div data-testid="bitbucket-card" />,
}));
vi.mock('@/components/admin/TrackerMigrationCard', () => ({
  TrackerMigrationCard: () => <div data-testid="tracker-migration-card" />,
}));

const listProviders = vi.fn();
vi.mock('@/services/trackers', () => ({
  trackersService: {
    listProviders: (...a: unknown[]) => listProviders(...a),
    setOAuthConfig: vi.fn(),
  },
}));

import PlatformAdmin from './PlatformAdmin';

const PROVIDERS = [
  { id: 'github-issues', label: 'GitHub Issues', instances: ['public'], configured: true },
  { id: 'gitlab-issues', label: 'GitLab Issues', instances: ['public'], configured: false },
  { id: 'jira-cloud', label: 'Jira Cloud', instances: ['cloud'], configured: false },
];

const renderAt = (initialEntry = '/admin') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/admin" element={<PlatformAdmin />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  listProviders.mockResolvedValue(PROVIDERS);
});

describe('PlatformAdmin', () => {
  it('renders the header and all four tabs', async () => {
    renderAt();
    expect(screen.getByRole('heading', { name: 'Platform Admin' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Source Control' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trackers' })).toBeInTheDocument();
    // Let the async provider load settle inside act().
    await screen.findByTestId('user-management-card');
  });

  it('shows the Users tab by default', async () => {
    renderAt();
    expect(await screen.findByTestId('user-management-card')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-credentials-card')).not.toBeInTheDocument();
  });

  it('opens the tab from the ?tab= query param', async () => {
    renderAt('/admin?tab=agents');
    expect(await screen.findByTestId('agent-credentials-card')).toBeInTheDocument();
    expect(screen.getByTestId('default-models-card')).toBeInTheDocument();
    expect(screen.queryByTestId('user-management-card')).not.toBeInTheDocument();
  });

  it('falls back to Users for an unknown ?tab= value', async () => {
    renderAt('/admin?tab=nonsense');
    expect(await screen.findByTestId('user-management-card')).toBeInTheDocument();
  });

  it('switches tabs on click and passes provider status to the Source Control tab', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole('tab', { name: 'Source Control' }));
    const githubCard = await screen.findByTestId('github-card');
    // github-issues is configured in the mocked provider list.
    expect(githubCard).toHaveAttribute('data-oauth-configured', 'true');
    // GitLab renders with a tracker-provided not-configured badge. Bitbucket
    // loads its configuration directly from the Bitbucket source-control API.
    expect(screen.getByText('GitLab')).toBeInTheDocument();
    expect(screen.getByTestId('bitbucket-card')).toBeInTheDocument();
    expect(screen.getAllByText('Not configured')).toHaveLength(1);
  });

  it('renders Jira and git-backed tracker rows on the Trackers tab', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole('tab', { name: 'Trackers' }));
    expect(await screen.findByText('Jira Cloud')).toBeInTheDocument();
    // Git-backed trackers appear as status rows pointing at Source Control.
    expect(screen.getByText('GitHub Issues')).toBeInTheDocument();
    expect(screen.getByText('GitLab Issues')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Configure in Source Control/ })).toHaveLength(2);
    expect(screen.getByTestId('tracker-migration-card')).toBeInTheDocument();
  });
});
