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
const projectMetrics = vi.fn().mockResolvedValue({
  perIntent: [],
  project: { metrics: {}, cost: { totalCost: 0, currency: 'USD', anyUnpriced: false } },
});
vi.mock('@/services/intents', () => ({
  intentsService: {
    list: (...a: unknown[]) => list(...a),
    projectMetrics: (...a: unknown[]) => projectMetrics(...a),
  },
}));
vi.mock('@/services/projects', () => ({ projectsService: {} }));

import Project from './Project';

function NewIntentStub() {
  return <span data-testid="new-intent-page">NewIntentPage</span>;
}

const renderProject = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1']}>
      <Routes>
        <Route path="/space/:projectId" element={<Project />} />
        <Route path="/space/:projectId/intent/new" element={<NewIntentStub />} />
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

  it('navigates to /space/:projectId/intent/new when New Intent is clicked', async () => {
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
    expect(await screen.findByTestId('new-intent-page')).toBeInTheDocument();
  });
});
