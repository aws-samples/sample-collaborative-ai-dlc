import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Heavy leaf components are stubbed to simple markers — these tests exercise
// IntentView's OWN rendering logic (DRAFT card, pipeline, gates, artifacts)
// through a real IntentProvider (mocked services), not Yjs/realtime.
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
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));
// The knowledge graph has its own suite (KnowledgeGraph.test.tsx) and pulls the
// discussions provider — stub it here so IntentView tests stay hermetic.
vi.mock('@/components/intent/KnowledgeGraph', () => ({
  KnowledgeGraph: () => <div data-testid="knowledge-graph" />,
}));

const get = vi.fn();
const start = vi.fn();
const answerGate = vi.fn();
const compiled = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    start: (...a: unknown[]) => start(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: (...a: unknown[]) => compiled(...a) },
}));

import IntentView from './IntentView';
import { IntentProvider } from '@/contexts/IntentContext';

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/intent/i1']}>
      <Routes>
        <Route
          path="/project/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <IntentView />
            </IntentProvider>
          }
        />
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
  events: [],
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

describe('IntentView', () => {
  beforeEach(() => {
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
  });

  it('DRAFT renders the review card with a read-only prompt + Start button', async () => {
    get.mockResolvedValue(baseDetail());
    renderAt();
    expect(await screen.findByText('Review & start')).toBeInTheDocument();
    expect(screen.getByText('Build X')).toBeInTheDocument();
    // Read-only: the prompt is NOT an editable field (edits used to be
    // silently discarded on Start — no update endpoint exists).
    expect(screen.queryByRole('textbox', { name: /prompt/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
  });

  it('running state renders the pipeline as the union of plan + STAGE rows', async () => {
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
        edges: [],
      },
    });
    renderAt();
    expect(await screen.findByText('stage-a')).toBeInTheDocument();
    // `stage-b` also appears in the header (currentStage) — scope to the row.
    expect(screen.getByRole('button', { name: /stage-b/ })).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument(); // plan-only stage-b
  });

  it('filters plan stages to the intent scope (SKIP stages never render)', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    compiled.mockResolvedValue({
      scopeGrid: { feature: { 'stage-a': 'EXECUTE', 'stage-b': 'SKIP' } },
      graph: {
        nodes: [
          { stageId: 'stage-a', phasePath: 'p', order: 0 },
          { stageId: 'stage-b', phasePath: 'p', order: 1 },
        ],
        edges: [],
      },
    });
    renderAt();
    expect(await screen.findByText('stage-a')).toBeInTheDocument();
    expect(screen.queryByText('stage-b')).not.toBeInTheDocument();
  });

  it('stage drill-down shows dependencies derived from compiled edges', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'stage-a', phasePath: 'p', order: 0 },
          { stageId: 'stage-b', phasePath: 'p', order: 1 },
        ],
        edges: [{ from: 'stage-a', to: 'stage-b', artifact: 'reqs', kind: 'data' }],
      },
    });
    renderAt();
    await screen.findByText('stage-b');
    await userEvent.click(screen.getByRole('button', { name: /stage-b/ }));
    expect(await screen.findByText('Depends on')).toBeInTheDocument();
    expect(screen.getByText('reqs')).toBeInTheDocument();
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

  it('renders a review-verdict gate with its options and answers through the gate endpoint', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING' }),
      gates: [
        {
          humanTaskId: 'h3',
          status: 'pending',
          kind: 'review-verdict',
          prompt: 'Ship it?',
          options: ['Accept', 'Reject'],
          questions: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    expect(await screen.findByText('Ship it?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'h3', {
      answer: 'Accept',
      status: 'answered',
    });
  });

  it('renders artifacts with provenance and a per-artifact DiscussButton', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'stage-a', state: 'SUCCEEDED', phase: 'p' }],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# hi',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Reqs')).toBeInTheDocument();
    // Provenance links the artifact back to the producing stage.
    expect(screen.getByText(/produced by/)).toBeInTheDocument();
    const buttons = screen.getAllByTestId('discuss');
    // intent-level + one per artifact.
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'artifact')).toBe(true);
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'intent')).toBe(true);
  });

  it('groups answered questions with artifacts in work products', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      events: [
        {
          eventId: 'human-answer-h1',
          type: 'v2.question.answered',
          stageInstanceId: 'si-a',
          actor: 'U',
          summary: 'U answered',
          timestamp: '2026-01-01T00:00:00Z',
          humanTaskId: 'h1',
          artifacts: [{ id: 'a1', title: 'Reqs' }],
        },
      ],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Which provider?","type":"single","options":[{"label":"Cognito"}]}]',
          answer: { answers: [{ selectedOptions: [0], freeText: '' }] },
          answeredByName: 'U',
          answeredAt: '2026-01-01T00:00:00Z',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# hi',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.getByText('Artifacts (1)')).toBeInTheDocument();
    expect(screen.getByText('Questions (1)')).toBeInTheDocument();
    expect(screen.getByText('Which provider?')).toBeInTheDocument();
    expect(screen.getByText('Q1: Cognito')).toBeInTheDocument();
    expect(screen.getByText('Influenced artifacts:')).toBeInTheDocument();
  });
});
