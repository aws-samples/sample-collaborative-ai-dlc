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

// ── WP7: engine approval gates + the unit lane board ─────────────────────────

describe('IntentView — WP7 construction UI', () => {
  beforeEach(() => {
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
  });

  it('renders an engine approval gate with its options and submits { decision } answers', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-halt-s1-r0-run1' }),
      gates: [
        {
          humanTaskId: 'eg-halt-s1-r0-run1',
          stageInstanceId: null,
          unitSlug: 'billing',
          kind: 'approval',
          status: 'pending',
          prompt: 'Lane failure in section 1 (1 unit(s) failed). Choose:',
          options: ['retry', 'skip', 'abort'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    // Prompt + lane attribution + every option rendered.
    expect(await screen.findByText(/Lane failure in section 1/)).toBeInTheDocument();
    expect(screen.getByText('unit billing')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'retry' });
    expect(screen.getByRole('button', { name: 'skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'abort' })).toBeInTheDocument();
    // Clicking an option submits the { decision } shape the orchestrator parses.
    await userEvent.click(retry);
    expect(answerGate).toHaveBeenCalledWith(
      'p1',
      'i1',
      'eg-halt-s1-r0-run1',
      expect.objectContaining({ answer: { decision: 'retry' }, status: 'answered' }),
    );
  });

  it('maps approve/reject options to approved/rejected statuses', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-skeleton-s1-run1' }),
      gates: [
        {
          humanTaskId: 'eg-skeleton-s1-run1',
          stageInstanceId: null,
          unitSlug: null,
          kind: 'approval',
          status: 'pending',
          prompt: 'Walking skeleton "auth" completed.',
          options: ['approve', 'reject'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'reject' }));
    expect(answerGate).toHaveBeenCalledWith(
      'p1',
      'i1',
      'eg-skeleton-s1-run1',
      expect.objectContaining({ status: 'rejected' }),
    );
  });

  it('shows the Lanes view when units exist: waves, skeleton marker, states, stage strips', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING' }),
      stages: [
        {
          stageInstanceId: 'si-cg-auth',
          stageId: 'cg',
          state: 'SUCCEEDED',
          unitSlug: 'auth',
          phase: 'c',
        },
        {
          stageInstanceId: 'si-cg-billing',
          stageId: 'cg',
          state: 'RUNNING',
          unitSlug: 'billing',
          phase: 'c',
        },
      ],
      unitPlan: {
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'billing', dependsOn: ['auth'] },
        ],
        batches: [['auth'], ['billing']],
        unitCount: 2,
        skipMatrix: {},
        walkingSkeleton: 'auth',
        autonomyMode: 'autonomous',
        promotedAt: 'T',
      },
      units: [
        {
          slug: 'auth',
          dependsOn: [],
          state: 'MERGED',
          batchIndex: 0,
          branch: 'aidlc/i1--s1-unit-auth',
          startedAt: 'T',
          mergedAt: 'T2',
          failureReason: null,
          blockedOn: null,
          updatedAt: 'T2',
        },
        {
          slug: 'billing',
          dependsOn: ['auth'],
          state: 'RUNNING',
          batchIndex: 1,
          branch: 'aidlc/i1--s1-unit-billing',
          startedAt: 'T2',
          mergedAt: null,
          failureReason: null,
          blockedOn: null,
          updatedAt: 'T3',
        },
      ],
    });
    compiled.mockResolvedValue({
      scopeGrid: { feature: { cg: 'EXECUTE' } },
      graph: { nodes: [{ stageId: 'cg', phasePath: 'c', order: 0 }], edges: [] },
    });
    renderAt();
    // The Lanes toggle appears only when units exist.
    const lanesToggle = await screen.findByRole('radio', { name: /unit lanes view/i });
    await userEvent.click(lanesToggle);
    // Waves + lane rows + skeleton marker + merged counter + autonomy mode.
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
    expect(screen.getByText('Wave 2')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText('billing')).toBeInTheDocument();
    expect(screen.getByText('skeleton')).toBeInTheDocument();
    expect(screen.getByText(/1\/2 unit\(s\) merged/)).toBeInTheDocument();
    expect(screen.getByText(/autonomous mode/)).toBeInTheDocument();
    // Lane states + dependency chip + per-lane stage strip chips.
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('← auth')).toBeInTheDocument();
    expect(screen.getAllByTitle(/cg — /)).toHaveLength(2);
  });

  it('does NOT offer the Lanes view before units are promoted', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    renderAt();
    await screen.findByText('Stages');
    expect(screen.queryByRole('radio', { name: /unit lanes view/i })).not.toBeInTheDocument();
  });
});
