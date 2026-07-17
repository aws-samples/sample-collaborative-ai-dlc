import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));

const mockProjectCache = vi.fn((): { project: { name: string; userRole?: string } | null } => ({
  project: { name: 'MySpace', userRole: 'owner' },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => mockProjectCache(),
}));

const get = vi.fn();
const cancel = vi.fn();
const deleteIntent = vi.fn();
const graph = vi.fn();
const compiled = vi.fn();
const workflowGet = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    cancel: (...a: unknown[]) => cancel(...a),
    delete: (...a: unknown[]) => deleteIntent(...a),
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: (...a: unknown[]) => workflowGet(...a),
  },
}));

import IntentObservabilityPage from './IntentObservabilityPage';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

function baseDetail(over: Record<string, unknown> = {}) {
  return {
    intent: {
      id: 'i1',
      executionId: 'i1',
      projectId: 'p1',
      title: 'Test Intent',
      prompt: 'x',
      status: 'RUNNING',
      branch: 'b',
      baseBranch: 'main',
      repos: ['o/r'],
      gitProvider: 'github',
      workflowId: 'w',
      workflowVersion: 1,
      scope: 'feature',
      currentPhase: null,
      currentStage: null,
      pendingHumanTaskId: null,
      cliModels: null,
      parkReleaseSeconds: 300,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      ...over,
    },
    stages: [],
    metrics: [],
    stageMetrics: [],
    events: [],
    units: [],
    unitPlan: null,
    gates: [],
    artifacts: [],
  };
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1/observability']}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId/observability"
          element={
            <IntentProvider>
              <IntentObservabilityPage />
            </IntentProvider>
          }
        />
        <Route path="/space/:projectId" element={<div data-testid="space-page" />} />
        <Route
          path="/space/:projectId/intent/:intentId/audit"
          element={<div data-testid="audit-page" />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearIntentCache();
  graph.mockResolvedValue({ nodes: [], edges: [] });
  compiled.mockResolvedValue({ graph: { nodes: [], edges: [] } });
  workflowGet.mockResolvedValue({ id: 'w', name: 'wf', version: 1, stages: [] });
  mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'owner' } });
});

describe('IntentObservabilityPage — Usage disclosure', () => {
  it('shows only core stats by default; More stats reveals advanced metrics', async () => {
    get.mockResolvedValue({
      ...baseDetail(),
      metrics: [
        {
          metrics: {
            tokensInput: 5000,
            tokensOutput: 2000,
            contextWindowPct: 45,
            agentLaunchMs: 1200,
          },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderPage();

    await screen.findByText('Input tokens');
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();

    expect(screen.queryByText('Agent launch')).not.toBeInTheDocument();

    const toggle = screen.getByTestId('usage-more-stats');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(screen.getByText('Agent launch')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not show More stats when no advanced metrics exist', async () => {
    get.mockResolvedValue({
      ...baseDetail(),
      metrics: [
        { metrics: { tokensInput: 1000, tokensOutput: 500 }, timestamp: '2026-01-01T00:00:00Z' },
      ],
    });
    renderPage();

    await screen.findByText('Input tokens');
    expect(screen.queryByTestId('usage-more-stats')).not.toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — Header simplification', () => {
  it('does not render a duplicate phase badge', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    await screen.findByText('Test Intent');
    const badges = screen.queryAllByText('RUNNING');
    expect(badges.length).toBe(0);
  });

  it('shows Live badge when intent is active', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    renderPage();
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('shows Completed badge for SUCCEEDED intent', async () => {
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows Failed badge for FAILED intent', async () => {
    get.mockResolvedValue(baseDetail({ status: 'FAILED' }));
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('does not render Space label; shows title and back button', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.queryByText(/^Space:/)).not.toBeInTheDocument();
    expect(screen.getByText('Test Intent')).toBeInTheDocument();
    expect(screen.getByLabelText('Back to space')).toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — Actions', () => {
  it('shows action menu with Cancel for WAITING status', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByText('Cancel run')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('shows menu with Audit only when RUNNING non-admin (no Cancel/Delete)', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByText('Audit')).toBeInTheDocument();
    expect(screen.queryByText('Cancel run')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows Delete for owner even when RUNNING is disallowed (shows for SUCCEEDED)', async () => {
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.queryByText('Cancel run')).not.toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('Cancel calls cancelIntent service', async () => {
    cancel.mockResolvedValue({ status: 'CANCELLED' });
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    window.confirm = vi.fn(() => true);
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByText('Cancel run'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('p1', 'i1'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('The run will stop'));
  });

  it('Cancel on FAILED intent uses status-aware confirmation copy', async () => {
    cancel.mockResolvedValue({ status: 'CANCELLED' });
    get.mockResolvedValue(baseDetail({ status: 'FAILED' }));
    window.confirm = vi.fn(() => true);
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByText('Cancel run'));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('failed run will be closed'),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('p1', 'i1'));
  });

  it('Delete opens confirmation dialog then navigates to space on success', async () => {
    deleteIntent.mockResolvedValue(undefined);
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByText('Delete'));

    expect(await screen.findByText(/permanently removed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Intent' }));
    await waitFor(() => expect(deleteIntent).toHaveBeenCalledWith('p1', 'i1'));
    expect(await screen.findByTestId('space-page')).toBeInTheDocument();
  });

  it('hides Delete for non-owner/admin users', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByText('Cancel run')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows Audit as first item in action menu', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('clicking Audit in menu navigates to the audit route', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByText('Audit'));
    expect(await screen.findByTestId('audit-page')).toBeInTheDocument();
  });
});
