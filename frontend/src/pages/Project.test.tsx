import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock the projects cache hooks so we can hand Project a v2 project and assert
// it renders the IntentsView branch (not the sprint UI) — the regression the
// shared-shell fix addressed.
const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
  useProjectSprintsCache: () => ({ sprints: [], refresh: () => {} }),
  useProjectsCache: () => ({ invalidate: () => {} }),
}));
vi.mock('@/hooks/useSprintEvents', () => ({ useSprintEvents: () => {} }));
const list = vi.fn().mockResolvedValue([]);
vi.mock('@/services/intents', () => ({
  intentsService: { list: (...a: unknown[]) => list(...a) },
}));
vi.mock('@/services/projects', () => ({ projectsService: {} }));
const compiled = vi.fn().mockResolvedValue({ scopeGrid: { feature: {} } });
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: (...a: unknown[]) => compiled(...a) },
}));

import Project from './Project';

const renderProject = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1']}>
      <Routes>
        <Route path="/project/:projectId" element={<Project />} />
      </Routes>
    </MemoryRouter>,
  );

describe('Project page — v2 routing', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    list.mockReset().mockResolvedValue([]);
  });

  it('renders IntentsView (not the sprint UI) for a v2 project', async () => {
    useProjectCache.mockReturnValue({
      project: {
        id: 'p1',
        name: 'V2 Project',
        kind: 'v2',
        workflowId: 'aidlc-v2',
        gitRepo: 'owner/repo',
        trackers: [],
      },
      loading: false,
    });
    renderProject();
    // IntentsView markers — the v2 branch.
    expect(await screen.findByText('New Intent')).toBeInTheDocument();
    expect(screen.getByText('No intents yet')).toBeInTheDocument();
    // The sprint-only "New Sprint" affordance must NOT be present.
    expect(screen.queryByText('New Sprint')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('p1');
  });

  it('offers a "From tracker issue" mode in New Intent only when a tracker is bound', async () => {
    useProjectCache.mockReturnValue({
      project: {
        id: 'p1',
        name: 'V2 Project',
        kind: 'v2',
        workflowId: 'aidlc-v2',
        gitRepo: 'owner/repo',
        trackers: [
          {
            id: 'tb-1',
            provider: 'github-issues',
            instance: 'public',
            externalProjectKey: 'owner/repo',
            displayName: 'owner/repo',
            createdAt: null,
            createdBy: null,
          },
        ],
      },
      loading: false,
    });
    renderProject();
    await userEvent.click(await screen.findByText('New Intent'));
    expect(await screen.findByText('From tracker issue')).toBeInTheDocument();
    expect(screen.getByText('Write a prompt')).toBeInTheDocument();
  });

  it('hides the tracker mode toggle when the v2 project has no tracker', async () => {
    useProjectCache.mockReturnValue({
      project: {
        id: 'p1',
        name: 'V2 Project',
        kind: 'v2',
        workflowId: 'aidlc-v2',
        gitRepo: 'owner/repo',
        trackers: [],
      },
      loading: false,
    });
    renderProject();
    await userEvent.click(await screen.findByText('New Intent'));
    // The prompt textarea is present, but no source-mode toggle.
    expect(
      await screen.findByPlaceholderText('Describe the intent in detail…'),
    ).toBeInTheDocument();
    expect(screen.queryByText('From tracker issue')).not.toBeInTheDocument();
  });
});
