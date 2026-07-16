import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Heavy tab components are stubbed — these tests cover the page's OWN logic:
// project loading, v2 redirect, tab rendering, and URL <-> tab sync.

vi.mock('@/components/project-settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="general-tab" />,
}));
vi.mock('@/components/project-settings/MembersTab', () => ({
  MembersTab: () => <div data-testid="members-tab" />,
}));
vi.mock('@/components/project-settings/AgentTab', () => ({
  AgentTab: () => <div data-testid="agent-tab" />,
}));
vi.mock('@/components/project-settings/RepositoriesTab', () => ({
  RepositoriesTab: () => <div data-testid="repositories-tab" />,
}));
vi.mock('@/components/project-settings/TrackersTab', () => ({
  TrackersTab: () => <div data-testid="trackers-tab" />,
}));

const getProject = vi.fn();
vi.mock('@/services/projects', () => ({
  projectsService: {
    get: (...a: unknown[]) => getProject(...a),
  },
}));

import ProjectSettings from './ProjectSettings';

const V2_PROJECT = {
  id: 'p1',
  name: 'My Project',
  gitProvider: 'github',
  gitRepo: 'owner/repo',
  agentCli: 'kiro',
  kind: 'v2',
  userRole: 'owner',
  trackers: [],
  repos: [],
};

const renderAt = (initialEntry = '/space/p1/settings') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/space/:projectId/settings" element={<ProjectSettings />} />
        <Route path="/space/:projectId" element={<div data-testid="project-page" />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue(V2_PROJECT);
});

describe('ProjectSettings', () => {
  it('renders the project name, role badge and all five tabs', async () => {
    renderAt();
    expect(await screen.findByRole('heading', { name: 'My Project' })).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    for (const name of ['General', 'Members', 'Agent', 'Source Control', 'Trackers']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('does not render the "Space settings" subtitle', async () => {
    renderAt();
    await screen.findByRole('heading', { name: 'My Project' });
    expect(screen.queryByText('Space settings')).not.toBeInTheDocument();
  });

  it('shows the General tab by default', async () => {
    renderAt();
    expect(await screen.findByTestId('general-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('members-tab')).not.toBeInTheDocument();
  });

  it('opens the tab from the ?tab= query param', async () => {
    renderAt('/space/p1/settings?tab=trackers');
    expect(await screen.findByTestId('trackers-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
  });

  it('falls back to General for an unknown ?tab= value', async () => {
    renderAt('/space/p1/settings?tab=nonsense');
    expect(await screen.findByTestId('general-tab')).toBeInTheDocument();
  });

  it('switches tabs on click', async () => {
    const user = userEvent.setup();
    renderAt();
    await screen.findByTestId('general-tab');
    await user.click(screen.getByRole('tab', { name: 'Source Control' }));
    expect(await screen.findByTestId('repositories-tab')).toBeInTheDocument();
  });

  it('redirects v1 projects to the project page', async () => {
    getProject.mockResolvedValue({ ...V2_PROJECT, kind: 'v1' });
    renderAt();
    expect(await screen.findByTestId('project-page')).toBeInTheDocument();
  });
});
