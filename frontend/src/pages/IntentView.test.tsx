import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Heavy leaf components are stubbed to simple markers — this test exercises
// IntentView's OWN rendering logic (DRAFT form, stage tree, gate list), not Yjs.
vi.mock('@/components/QuestionEditor', () => ({
  default: ({ question }: { question: { id: string } }) => (
    <div data-testid="question-editor" data-gate={question.id} />
  ),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: ({ entityType }: { entityType: string }) => (
    <button data-testid="discuss" data-entity={entityType} />
  ),
}));
vi.mock('@/components/discussion/DiscussionPanel', () => ({ DiscussionPanel: () => null }));
vi.mock('@/components/discussion/DiscussionProvider', () => ({
  useDiscussions: () => ({ isOpen: false }),
}));
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));

const get = vi.fn();
const compiled = vi.fn();
vi.mock('@/services/intents', () => ({ intentsService: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: (...a: unknown[]) => compiled(...a) },
}));

import IntentView from './IntentView';

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/intent/i1']}>
      <Routes>
        <Route path="/project/:projectId/intent/:intentId" element={<IntentView />} />
      </Routes>
    </MemoryRouter>,
  );

const baseDetail = (over: Record<string, unknown> = {}) => ({
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'My intent',
    prompt: 'Build X',
    status: 'DRAFT',
    branch: 'aidlc/i1',
    baseBranch: 'main',
    repos: ['owner/repo'],
    workflowId: 'aidlc-v2',
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
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

describe('IntentView', () => {
  beforeEach(() => {
    get.mockReset();
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [] } });
  });

  it('DRAFT renders the define form + Start button', async () => {
    get.mockResolvedValue(baseDetail());
    renderAt();
    expect(await screen.findByText('Define & start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
  });

  it('running state renders the stage tree as the union of plan + STAGE rows', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING', currentStage: 'stage-b' }));
    // Plan has a + b; only stage-a has a STAGE row (SUCCEEDED). stage-b is plan-only → PENDING.
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING', currentStage: 'stage-b' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'stage-a', state: 'SUCCEEDED', phase: 'p' }],
    });
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'stage-a', phasePath: 'p', order: 0 },
          { stageId: 'stage-b', phasePath: 'p', order: 1 },
        ],
      },
    });
    renderAt();
    expect(await screen.findByText('stage-a')).toBeInTheDocument();
    expect(screen.getByText('stage-b')).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument(); // plan-only stage-b
  });

  it('renders one QuestionEditor per pending gate (D3 multi-gate)', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING' }),
      gates: [
        {
          humanTaskId: 'h1',
          status: 'pending',
          kind: 'question',
          questions: '[{"text":"?","type":"single","options":[{"label":"Y"}]}]',
        },
        {
          humanTaskId: 'h2',
          status: 'pending',
          kind: 'question',
          questions: '[{"text":"?","type":"single","options":[{"label":"Y"}]}]',
        },
      ],
    });
    renderAt();
    const editors = await screen.findAllByTestId('question-editor');
    expect(editors.map((e) => e.getAttribute('data-gate')).toSorted()).toEqual(['h1', 'h2']);
  });

  it('renders artifacts with a per-artifact DiscussButton', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      artifacts: [{ id: 'a1', artifactType: 'requirements', title: 'Reqs', content: '# hi' }],
    });
    renderAt();
    expect(await screen.findByText('Reqs')).toBeInTheDocument();
    const buttons = screen.getAllByTestId('discuss');
    // intent-level + one per artifact.
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'artifact')).toBe(true);
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'intent')).toBe(true);
  });
});
