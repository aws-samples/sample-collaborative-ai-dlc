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
const workflowGet = vi.fn();
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
    get: (...a: unknown[]) => workflowGet(...a),
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
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  it('DRAFT redirects to the collaborative compose page (one canonical draft UI)', async () => {
    get.mockResolvedValue(baseDetail());
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
          <Route
            path="/project/:projectId/intent/:intentId/compose"
            element={<div data-testid="compose-page" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
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
    expect(await screen.findByText('Review: stage-a')).toBeInTheDocument();
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

  // The review gate is where results are judged, so it is also where the plan
  // may be reshaped: checked recompose targets ride the approve answer as
  // { recompose: { skip: [...] } } — applied in place, no relaunch.
  it('reshapes upcoming stages from the review gate via the approve answer', async () => {
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
          recomposeTargets: ['nfr-design', 'performance-validation'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [],
      artifacts: [],
    });
    graph.mockResolvedValue({ nodes: [], edges: [] });
    answerGate.mockResolvedValue({});
    renderAt('/project/p1/intent/i1/review/eg-validation-si-a-0-run1');
    expect(await screen.findByText('Review: stage-a')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('review-reshape-toggle'));
    await userEvent.click(screen.getByTestId('review-reshape-nfr-design').querySelector('input')!);
    const approve = screen.getByRole('button', { name: /Approve & drop 1 stage/ });
    await userEvent.click(approve);
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: { decision: 'approve', recompose: { skip: ['nfr-design'] } },
      status: 'approved',
    });
  });

  // Upstream 2.2.6: the approve action names the COMPUTED next stage verbatim
  // ("Complete workflow" when the gate is the final stage). Legacy gates
  // without the field keep the generic label (previous test).
  it('names the computed next stage on the approve button when the gate carries it', async () => {
    const validationDetail = (nextStageId: string | null) => ({
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
          nextStageId,
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [],
      artifacts: [],
    });
    graph.mockResolvedValue({ nodes: [], edges: [] });
    answerGate.mockResolvedValue({});

    get.mockResolvedValue(validationDetail('stage-b'));
    const { unmount } = renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(
      await screen.findByRole('button', { name: 'Approve — continue to stage-b' }),
    ).toBeInTheDocument();
    unmount();

    // Final stage: null = approving completes the workflow.
    get.mockResolvedValue(validationDetail(null));
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(
      await screen.findByRole('button', { name: 'Approve — complete workflow' }),
    ).toBeInTheDocument();
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

    const feedback = await screen.findByLabelText('Feedback for the agent');
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
    // Documents section is closed on SUCCEEDED intents — expand it.
    expect(await screen.findByText('Document')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Document'));
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
    expect(await screen.findByText('Generated artifacts')).toBeInTheDocument();
    expect(screen.getByText('Document')).toBeInTheDocument();
    expect(screen.getByText('Questions')).toBeInTheDocument();
    // Questions section is closed by default — expand it.
    await userEvent.click(screen.getByText('Questions'));
    expect(screen.getByText('Which provider?')).toBeInTheDocument();
    expect(screen.getByText('Q1: Cognito')).toBeInTheDocument();
    expect(screen.getByText('Influenced artifacts:')).toBeInTheDocument();
  });

  it('groups documents by phase (latest first) then stage order then date desc', async () => {
    // Compiled plan: two phases (01 Inception, 02 Construction), two stages
    // each, with canonical plan `order`. Grouping/ordering must follow the plan
    // vocabulary (phasePath + stage order), NOT raw dates — an earlier stage
    // whose document was produced LATER must still sort below a later stage.
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'intent-capture', phasePath: '01', order: 1 },
          { stageId: 'requirements-analysis', phasePath: '01', order: 2 },
          { stageId: 'domain-entities', phasePath: '02', order: 3 },
          { stageId: 'code-gen', phasePath: '02', order: 4 },
        ],
        edges: [],
      },
    });
    workflowGet.mockResolvedValue({
      phases: [
        {
          phaseId: 'inception',
          name: 'Inception',
          kind: 'phase',
          path: '01',
          parentPath: null,
          order: 1,
        },
        {
          phaseId: 'construction',
          name: 'Construction',
          kind: 'phase',
          path: '02',
          parentPath: null,
          order: 2,
        },
      ],
    });

    const doc = (id: string, title: string, si: string, createdAt: string) => ({
      id,
      artifactType: 'requirements',
      title,
      content: `# ${title}\n\n${'Long-form body. '.repeat(40)}`,
      createdByStageInstanceId: si,
      createdByExecutionId: 'i1',
      createdAt,
    });

    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [
        {
          stageInstanceId: 'si-ic',
          stageId: 'intent-capture',
          state: 'SUCCEEDED',
          phase: 'inception',
        },
        {
          stageInstanceId: 'si-ra',
          stageId: 'requirements-analysis',
          state: 'SUCCEEDED',
          phase: 'inception',
        },
        {
          stageInstanceId: 'si-de',
          stageId: 'domain-entities',
          state: 'SUCCEEDED',
          phase: 'construction',
        },
        {
          stageInstanceId: 'si-cg',
          stageId: 'code-gen',
          state: 'SUCCEEDED',
          phase: 'construction',
        },
      ],
      artifacts: [
        // Intentionally shuffled input order + dates that fight the plan order.
        doc('d-ic', 'Intent Capture Doc', 'si-ic', '2026-01-01T10:00:00Z'),
        // code-gen (order 4) produced EARLIER than domain-entities (order 3):
        // plan order must still put code-gen above domain-entities.
        doc('d-cg', 'Code Gen Doc', 'si-cg', '2026-01-02T08:00:00Z'),
        doc('d-de', 'Domain Entities Doc', 'si-de', '2026-01-02T20:00:00Z'),
        // Two requirements-analysis docs: newest must appear first (date desc
        // WITHIN a stage).
        doc('d-ra-old', 'Requirements Doc Old', 'si-ra', '2026-01-01T11:00:00Z'),
        doc('d-ra-new', 'Requirements Doc New', 'si-ra', '2026-01-01T18:00:00Z'),
      ],
    });

    renderAt();
    // Documents section is closed on SUCCEEDED intents — expand it.
    expect(await screen.findByText('Documents')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Documents'));
    expect(await screen.findByText('Construction')).toBeInTheDocument();

    // Collect phase headers + document titles in DOM order and assert the full
    // top-to-bottom sequence.
    const labels = [
      'Construction',
      'Inception',
      'Code Gen Doc',
      'Domain Entities Doc',
      'Intent Capture Doc',
      'Requirements Doc Old',
      'Requirements Doc New',
    ];
    const positions = labels.map((t) => ({ t, el: screen.getByText(t) }));
    const domOrder = positions
      .toSorted((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      .map((p) => p.t);

    expect(domOrder).toEqual([
      'Construction', //            latest phase first
      'Code Gen Doc', //            stage order 4 (before order 3 despite earlier date)
      'Domain Entities Doc', //     stage order 3
      'Inception', //               earlier phase second
      'Requirements Doc New', //    stage order 2, newest of its stage first
      'Requirements Doc Old', //    stage order 2, older second
      'Intent Capture Doc', //      stage order 1 last
    ]);
  });

  it('strips the intent-name suffix from document titles (dash and parenthetical forms)', async () => {
    const doc = (id: string, title: string) => ({
      id,
      artifactType: 'requirements',
      title,
      content: `# ${title}\n\n${'Long-form body. '.repeat(40)}`,
      createdByStageInstanceId: 'si-a',
      createdByExecutionId: 'i1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED', title: 'Plant Identifier MVP' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'build-and-test', state: 'SUCCEEDED', phase: 'c' },
      ],
      artifacts: [
        doc('d1', 'Build and Test Results — Plant Identifier MVP'),
        doc('d2', 'Code Summary — Infrastructure (Plant Identifier MVP)'),
        doc('d3', 'Plant Identifier MVP'),
      ],
    });
    renderAt();
    // Documents section is closed on SUCCEEDED intents — expand it.
    expect(await screen.findByText('Generated artifacts')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Documents'));
    expect(await screen.findByText('Build and Test Results')).toBeInTheDocument();
    // Only the trailing parenthetical stripped; the meaningful "— Infrastructure" stays.
    expect(screen.getByText('Code Summary — Infrastructure')).toBeInTheDocument();
    // A title that IS just the intent name is left untouched (not blanked): it
    // appears both as the page heading and as the d3 row — so > 1 occurrence.
    expect(screen.getAllByText('Plant Identifier MVP').length).toBeGreaterThan(1);
    // The redundant full form no longer appears in a row.
    expect(
      screen.queryByText('Build and Test Results — Plant Identifier MVP'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Code Summary — Infrastructure (Plant Identifier MVP)'),
    ).not.toBeInTheDocument();
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
    expect(await screen.findByText('Generated artifacts')).toBeInTheDocument();
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

  it('maps approve/request-changes options to approved/rejected statuses and carries feedback', async () => {
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
    renderAt();
    // Gates offering request-changes render the free-text feedback field; the
    // feedback rides the answer so the engine can revise the increment and
    // re-ask instead of failing the run.
    const feedback = await screen.findByPlaceholderText(/What should change/);
    await userEvent.type(feedback, 'wire real auth');
    await userEvent.click(screen.getByRole('button', { name: 'request-changes' }));
    expect(answerGate).toHaveBeenCalledWith(
      'p1',
      'i1',
      'eg-skeleton-s1-run1',
      expect.objectContaining({
        answer: { decision: 'request-changes', feedback: 'wire real auth' },
        status: 'rejected',
      }),
    );
  });
});
