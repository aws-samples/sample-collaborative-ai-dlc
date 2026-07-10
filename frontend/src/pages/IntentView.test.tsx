import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const yjsMock = vi.hoisted(() => ({ docs: new Map<string, unknown>() }));

// Heavy leaf components are stubbed to simple markers — these tests exercise
// IntentView's OWN rendering logic (DRAFT card, pipeline, gates, artifacts)
// through a real IntentProvider (mocked services), not Yjs/realtime.
vi.mock('@/components/QuestionEditor', () => ({
  default: ({ question }: { question: { id: string } }) => (
    <div data-testid="question-editor" data-gate={question.id} />
  ),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: ({
    entityType,
    entityId,
    entityTitle,
  }: {
    entityType: string;
    entityId?: string;
    entityTitle?: string;
  }) => (
    <button
      data-testid="discuss"
      data-entity={entityType}
      data-entity-id={entityId}
      data-entity-title={entityTitle}
    />
  ),
}));
vi.mock('@/hooks/useYjsDocument', async () => {
  const Y = await import('yjs');
  return {
    useYjsDocument: (documentId: string | null) => {
      if (!documentId) {
        return { doc: null, synced: false, remoteUsers: new Map(), setCursor: vi.fn() };
      }
      let doc = yjsMock.docs.get(documentId);
      if (!doc) {
        doc = new Y.Doc();
        yjsMock.docs.set(documentId, doc);
      }
      return { doc, synced: true, remoteUsers: new Map(), setCursor: vi.fn() };
    },
  };
});
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));

const get = vi.fn();
const start = vi.fn();
const answerGate = vi.fn();
const graph = vi.fn();
const compiled = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    start: (...a: unknown[]) => start(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
    // Knowledge graph feeding the popovers/derived-items section — empty
    // graph keeps those affordances out of these page-behavior tests.
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: vi.fn().mockResolvedValue({ phases: [] }),
  },
}));

import IntentView from './IntentView';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

const renderAt = (initialEntry = '/project/p1/intent/i1') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/project/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <IntentView />
            </IntentProvider>
          }
        />
        <Route
          path="/project/:projectId/intent/:intentId/review/:humanTaskId"
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
    gitProvider: 'github',
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
    clearIntentCache();
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    yjsMock.docs.clear();
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

  it('shows resume progress after a gate is answered but before the stage is running again', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1' }),
      stages: [
        {
          stageInstanceId: 'si-a',
          stageId: 'requirements-analysis',
          state: 'WAITING_FOR_HUMAN',
          phase: 'inception',
        },
      ],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Scope?"}]',
          answer: { freeText: 'MVP' },
        },
      ],
      events: [
        {
          eventId: 'ev-resuming',
          type: 'v2.stage.resuming',
          stageInstanceId: 'si-a',
          actor: 'agentcore',
          summary: 'Resuming agent session...',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Resuming')).toBeInTheDocument();
    expect(screen.getByText('Resuming agent session...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your input')).not.toBeInTheDocument();
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

  it('opens a validation gate review page and approves the stage', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [
        {
          sensorRunId: 'sr-1',
          stageInstanceId: 'si-a',
          sensorId: 'reviewer:qa',
          result: 'PASS',
          detail: { verdict: 'READY', findings: 'Looks complete' },
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# hi',
          summaryGist: 'Captures login requirements and MFA acceptance criteria.',
          summaryClaims: ['Users must authenticate with MFA.', 'Lockout rules are defined.'],
          enrichmentModel: 'claude-sonnet',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    graph.mockResolvedValue({
      nodes: [
        {
          id: 'req-1',
          type: 'Requirement',
          label: 'MFA is required for sign in',
          graphLayer: 'derived',
          artifactId: 'a1',
          slug: 'REQ-1',
        },
      ],
      edges: [],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(await screen.findByText('Review stage stage-a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve stage/i })).toBeInTheDocument();
    const reviewDiscuss = screen
      .getAllByTestId('discuss')
      .find((b) => b.getAttribute('data-entity') === 'review');
    expect(reviewDiscuss).toBeInTheDocument();
    expect(reviewDiscuss).toHaveAttribute('data-entity-id', 'eg-validation-si-a-0-run1');
    expect(reviewDiscuss).toHaveAttribute('data-entity-title', 'Review stage-a');
    const glance = screen.getByRole('button', { name: /At a glance/i });
    expect(glance).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(glance);
    expect(
      screen.getByText('Captures login requirements and MFA acceptance criteria.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Users must authenticate with MFA.')).toBeInTheDocument();
    expect(await screen.findByText(/REQ-1:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LLM reviewer findings/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: /LLM reviewer findings/i }));
    expect(screen.getByText('Looks complete')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Approve stage' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: { decision: 'approve' },
      status: 'approved',
    });
  });

  it('submits the collaborative review feedback value when requesting changes', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt('/project/p1/intent/i1/review/eg-validation-si-a-0-run1');

    const feedback = await screen.findByLabelText('Request changes feedback');
    await userEvent.type(feedback, 'Please tighten the acceptance criteria');
    await userEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: {
        decision: 'request-changes',
        feedback: 'Please tighten the acceptance criteria',
      },
      status: 'rejected',
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
          content: `# Requirements\n\n${'Long-form requirements body. '.repeat(40)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Reqs')).toBeInTheDocument();
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
          content: `# Requirements\n\n${'Long-form requirements body. '.repeat(40)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.getByText('Document')).toBeInTheDocument();
    expect(screen.getByText('Questions')).toBeInTheDocument();
    expect(screen.getByText('Which provider?')).toBeInTheDocument();
    expect(screen.getByText('Q1: Cognito')).toBeInTheDocument();
    expect(screen.getByText('Influenced artifacts:')).toBeInTheDocument();
  });

  it('renders a PR entry (number, link, source → target) once the PR is recorded', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      pullRequests: [
        {
          id: 'pr:i1:owner/repo',
          repository: 'owner/repo',
          prUrl: 'https://github.com/owner/repo/pull/9',
          prNumber: '9',
          branch: 'aidlc/i1',
          baseBranch: 'main',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByText('PR #9')).toBeInTheDocument();
    // Source branch is a link; the base (target) is shown only for a PR.
    const branchLink = screen.getByRole('link', { name: 'aidlc/i1' });
    expect(branchLink).toHaveAttribute('href', 'https://github.com/owner/repo/tree/aidlc/i1');
    expect(screen.getByText('main')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open pr/i });
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/9');
  });

  it('shows the branch (name + link, no base) once code is pushed, before any PR', async () => {
    // A v2.git.pushed event means the branch has real code on the remote. A
    // bare branch shows only its name + link — no "→ base" (that is PR-only).
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING' }),
      events: [{ eventId: 'e1', type: 'v2.git.pushed', summary: 'owner/repo@abc12345' }],
      pullRequests: [],
    });
    renderAt();
    expect(await screen.findByText('Code')).toBeInTheDocument();
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    const branchLink = screen.getByRole('link', { name: 'aidlc/i1' });
    expect(branchLink).toHaveAttribute('href', 'https://github.com/owner/repo/tree/aidlc/i1');
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open pr/i })).not.toBeInTheDocument();
    // No base branch on a bare branch entry.
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('hides the Code section until code has actually been pushed', async () => {
    // Mid-run, branch created locally but nothing pushed yet (no v2.git.pushed,
    // no PR): the Code section must not appear.
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING' }),
      events: [],
      pullRequests: [],
    });
    renderAt();
    // The workbench renders; the Code section does not.
    await screen.findByText('My intent');
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
  });

  it('shows only the repos that pushed code (multi-repo, per-repo gating)', async () => {
    const base = baseDetail({ status: 'RUNNING' });
    get.mockResolvedValue({
      ...base,
      intent: { ...base.intent, repos: ['owner/api', 'owner/web'] },
      // Only owner/api pushed; owner/web has no code yet.
      events: [{ eventId: 'e1', type: 'v2.git.pushed', summary: 'owner/api@abc12345' }],
      pullRequests: [],
    });
    renderAt();
    expect(await screen.findByText('Code')).toBeInTheDocument();
    expect(screen.getByText('owner/api')).toBeInTheDocument();
    expect(screen.queryByText('owner/web')).not.toBeInTheDocument();
  });
});

// ── WP7: engine approval gates + the unit lane board ─────────────────────────

describe('IntentView — WP7 construction UI', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
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
});
