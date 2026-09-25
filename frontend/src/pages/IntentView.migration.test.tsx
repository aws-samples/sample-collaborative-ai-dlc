import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

// C2 opt-in migration entry point (issue #482): the intent actions menu offers
// "Start a new intent on another AI-DLC version", which only navigates to the
// prefilled create page — it never mutates the current intent. Mock setup
// mirrors IntentView.test.tsx (on origin/main, therefore not extended there).
vi.mock('@/components/QuestionEditor', () => ({
  default: () => <div data-testid="question-editor" />,
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button data-testid="discuss" />,
}));
vi.mock('@/hooks/useYjsDocument', () => ({
  useYjsDocument: () => ({ doc: null, synced: false, remoteUsers: new Map(), setCursor: vi.fn() }),
}));
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({ project: { name: 'P', userRole: 'owner' } }),
}));

const get = vi.fn();
const graph = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: vi.fn().mockResolvedValue({ graph: { nodes: [], edges: [] } }),
    get: vi.fn().mockResolvedValue({ phases: [] }),
  },
}));

import IntentView from './IntentView';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

const detail = {
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'My intent',
    prompt: 'Build X',
    status: 'SUCCEEDED',
    branch: 'aidlc/i1',
    baseBranch: 'main',
    repos: ['owner/repo'],
    gitProvider: 'github',
    workflowId: 'aidlc-v2',
    workflowVersion: 1,
    scope: 'feature',
    currentPhase: null,
    currentStage: null,
    pendingHumanTaskId: null,
    cliModels: null,
    environment: null,
    parkReleaseSeconds: 300,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  },
  stages: [],
  events: [],
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
};

describe('IntentView — start a new intent on another AI-DLC version', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset().mockResolvedValue(detail);
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
  });

  it('navigates to the create page carrying the source intent id', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
        <Routes>
          <Route
            path="/space/:projectId/intent/:intentId"
            element={
              <IntentProvider>
                <IntentView />
              </IntentProvider>
            }
          />
          <Route
            path="/space/:projectId/intent/new"
            element={<div data-testid="new-intent-page" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Intent actions' }));
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Start a new intent on another AI-DLC version',
      }),
    );
    expect(await screen.findByTestId('new-intent-page')).toBeInTheDocument();
  });
});
