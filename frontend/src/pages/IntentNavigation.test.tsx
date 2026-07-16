import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({ project: { name: 'MySpace' } }),
}));

const get = vi.fn();
const audit = vi.fn();
const graph = vi.fn();
const compiled = vi.fn();
const workflowGet = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    audit: (...a: unknown[]) => audit(...a),
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: (...a: unknown[]) => workflowGet(...a),
  },
}));

import IntentObservabilityPage from '@/pages/IntentObservabilityPage';
import IntentAuditPage from '@/pages/IntentAuditPage';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

function LocationCapture() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function baseDetail(over: Record<string, unknown> = {}) {
  return {
    intent: {
      id: 'i1',
      executionId: 'i1',
      projectId: 'p1',
      title: 'Test',
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

function baseAudit() {
  return {
    summary: {
      stageCount: 0,
      eventCount: 0,
      humanTaskCount: 0,
      metricSamples: 0,
      graphReadCalls: 0,
      graphReadBytes: 0,
      sensorRuns: 0,
      sensorFindings: 0,
    },
    graphReads: { byTool: [] },
    enrichment: {
      mode: 'off',
      calls: 0,
      tokensInput: 0,
      tokensOutput: 0,
      credits: 0,
      reads: { compactCalls: 0, fullCalls: 0, compactBytes: 0, fullBytes: 0, compactShare: null },
    },
    derivation: {
      runs: 0,
      failures: 0,
      structuredBlocks: { checked: 0, present: 0, absent: 0, malformed: 0, complianceRate: null },
    },
    promptContext: { samples: 0, promptBytes: 0, avgPromptBytes: 0, compiledContextBytes: 0 },
    units: [],
    sensors: { findings: [] },
    advisories: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearIntentCache();
  get.mockResolvedValue(baseDetail());
  audit.mockResolvedValue(baseAudit());
  graph.mockResolvedValue({ nodes: [], edges: [] });
  compiled.mockResolvedValue({ graph: { nodes: [], edges: [] } });
  workflowGet.mockResolvedValue({ id: 'w', name: 'wf', version: 1, stages: [] });
});

describe('IntentObservabilityPage back navigation', () => {
  it('back arrow navigates to space home, not intent work', async () => {
    const user = userEvent.setup();
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
          <Route path="/space/:projectId" element={<LocationCapture />} />
          <Route path="/space/:projectId/intent/:intentId" element={<LocationCapture />} />
        </Routes>
      </MemoryRouter>,
    );
    const backBtn = await screen.findByLabelText('Back to space');
    await user.click(backBtn);
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1');
  });

  it('does not render a duplicate Overview button', async () => {
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
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByLabelText('Back to space');
    expect(screen.queryByRole('button', { name: /^Overview$/i })).not.toBeInTheDocument();
  });
});

describe('IntentAuditPage back navigation', () => {
  it('back arrow navigates to intent observability', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/space/p1/intent/i1/audit']}>
        <Routes>
          <Route
            path="/space/:projectId/intent/:intentId/audit"
            element={
              <IntentProvider>
                <IntentAuditPage />
              </IntentProvider>
            }
          />
          <Route
            path="/space/:projectId/intent/:intentId/observability"
            element={<LocationCapture />}
          />
          <Route path="/space/:projectId/intent/:intentId" element={<LocationCapture />} />
        </Routes>
      </MemoryRouter>,
    );
    const backBtn = await screen.findByLabelText('Back to intent overview');
    await user.click(backBtn);
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1/intent/i1/observability');
  });
});
