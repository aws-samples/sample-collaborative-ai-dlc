import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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

import Project, { clearIntentsCacheForTests } from './Project';

function NewIntentStub() {
  return <span data-testid="new-intent-page">NewIntentPage</span>;
}

const V2_PROJECT = {
  id: 'p1',
  name: 'V2 Project',
  kind: 'v2',
  workflowId: 'aidlc-v2',
  gitRepo: 'owner/repo',
  userRole: 'owner',
  trackers: [],
};

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
    clearIntentsCacheForTests();
  });

  it('renders IntentsView (not the sprint UI) for a v2 project', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    renderProject();
    expect(await screen.findByText('New Intent')).toBeInTheDocument();
    expect(screen.getByText('No intents yet')).toBeInTheDocument();
    expect(screen.queryByText('New Sprint')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('p1');
  });

  it('navigates to /space/:projectId/intent/new when New Intent is clicked', async () => {
    useProjectCache.mockReturnValue({
      project: {
        ...V2_PROJECT,
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

describe('Project page — Intent list scalability', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    list.mockReset();
    projectMetrics.mockReset().mockResolvedValue({
      perIntent: [],
      project: { metrics: {}, cost: { totalCost: 0, currency: 'USD', anyUnpriced: false } },
    });
    clearIntentsCacheForTests();
  });

  function makeIntents(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `i-${i}`,
      title: `Intent ${i}`,
      status: 'SUCCEEDED',
      currentStage: null,
      createdAt: new Date(2026, 0, count - i).toISOString(),
      updatedAt: new Date(2026, 0, count - i).toISOString(),
    }));
  }

  it('shows at most 10 intents initially and a "Show all" toggle', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(15));
    renderProject();
    await screen.findByText('Intent 0');
    const rows = screen.getAllByRole('button', { name: /^Intent \d+/ });
    expect(rows.length).toBe(10);
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (15)');
  });

  it('does not show a "loaded" count badge next to the Intents heading', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(15));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.queryByText(/^\d+ loaded$/)).not.toBeInTheDocument();
  });

  it('"Show all" reveals all intents, then "Show recent" hides them', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(12));
    renderProject();
    await screen.findByText('Intent 0');
    await userEvent.click(screen.getByTestId('intent-show-toggle'));
    expect(screen.getAllByRole('button', { name: /^Intent \d+/ }).length).toBe(12);
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show recent 10');
    await userEvent.click(screen.getByTestId('intent-show-toggle'));
    expect(screen.getAllByRole('button', { name: /^Intent \d+/ }).length).toBe(10);
  });

  it('does not show the toggle when there are 10 or fewer intents', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(8));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.queryByTestId('intent-show-toggle')).not.toBeInTheDocument();
  });

  it('shows API cap notice when exactly 100 intents are loaded', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(100));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.getByTestId('intent-api-cap-notice')).toHaveTextContent(
      'Up to 100 most recent Intents are loaded in this view.',
    );
  });

  it('does not show API cap notice when fewer than 100 intents are loaded', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue(makeIntents(50));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.queryByTestId('intent-api-cap-notice')).not.toBeInTheDocument();
  });
});

describe('Project page — Space-scoped usage (coreOnly)', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    list.mockReset().mockResolvedValue([]);
    clearIntentsCacheForTests();
  });

  it('renders usage without advanced metrics (agent launch, context gauge hidden)', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    projectMetrics.mockResolvedValue({
      perIntent: [],
      project: {
        metrics: {
          tokensInput: 10000,
          tokensOutput: 5000,
          contextWindowPct: 60,
          agentLaunchMs: 900,
          artifactsCreated: 5,
        },
        cost: { totalCost: 1.23, currency: 'USD', anyUnpriced: false, anyEstimated: false },
      },
    });
    renderProject();
    await screen.findByText('Input tokens');
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.queryByText('Agent launch')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts created')).not.toBeInTheDocument();
    expect(screen.queryByText('Context window')).not.toBeInTheDocument();
    expect(screen.queryByText('Peak context window')).not.toBeInTheDocument();
  });
});
