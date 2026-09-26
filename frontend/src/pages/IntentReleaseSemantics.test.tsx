import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

// Release-semantics surfaces on the intent page: the
// one-click Resume run recovery, and the validation gate's third
// `override-and-approve` option with its structured findings.
//
// The harness mirrors IntentView.test.tsx — heavy leaf components stubbed, a real
// IntentProvider over a mocked service — because the behaviour under test is the
// page's own wiring (which button appears, what payload it sends), not Yjs.

const yjsMock = vi.hoisted(() => ({ docs: new Map<string, unknown>() }));

vi.mock('@/components/QuestionEditor', () => ({
  default: ({ question }: { question: { id: string } }) => (
    <div data-testid="question-editor" data-gate={question.id} />
  ),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button data-testid="discuss" />,
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
  useAuth: () => ({ user: { displayName: 'Ada', email: 'ada@x' } }),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({ project: { name: 'P', userRole: 'owner' } }),
}));

const get = vi.fn();
const resume = vi.fn();
const answerGate = vi.fn();
const graph = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    resume: (...a: unknown[]) => resume(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: vi.fn(async () => ({ graph: { nodes: [], edges: [] } })),
    get: vi.fn(async () => ({})),
  },
}));

import IntentView from './IntentView';
import { ApiError } from '@/services/api';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

const renderAt = (initialEntry = '/space/p1/intent/i1') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
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
          path="/space/:projectId/intent/:intentId/review/:humanTaskId"
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
    status: 'WAITING',
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

const RESUME_REQUIRED = {
  humanTaskId: 'h1',
  callbackId: 'cb-h1',
  answeredAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  clearIntentCache();
  get.mockReset();
  resume.mockReset();
  answerGate.mockReset();
  graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
});

describe('Resume run', () => {
  it('offers the action when an answered gate still needs its callback completed', async () => {
    get.mockResolvedValue(baseDetail({ resumeRequired: RESUME_REQUIRED }));
    resume.mockResolvedValue({ resumed: true });
    renderAt();

    expect(
      await screen.findByText('Your answer was saved but the run did not continue'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Resume run/i }));
    expect(resume).toHaveBeenCalledWith('p1', 'i1');
    // The page reloads after the recovery so the banner clears itself.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('offers the action when the pending gate is answered but the marker is missing', async () => {
    get.mockResolvedValue({
      ...baseDetail({ pendingHumanTaskId: 'h1' }),
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          kind: 'question',
          status: 'answered',
          resumeAvailable: true,
          prompt: 'Choose a direction.',
          options: null,
          questions: null,
          answer: { choice: 'continue' },
          answeredBy: 'u1',
          answeredAt: '2026-01-01T00:00:00Z',
          createdAt: null,
        },
      ],
    });
    resume.mockResolvedValue({ resumed: true });
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /Resume run/i }));

    expect(resume).toHaveBeenCalledWith('p1', 'i1');
  });

  it('stays hidden when nothing needs resuming', async () => {
    get.mockResolvedValue(baseDetail());
    renderAt();
    await screen.findByText('My intent');
    expect(
      screen.queryByText('Your answer was saved but the run did not continue'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resume run/i })).not.toBeInTheDocument();
  });

  it('surfaces a failed resume instead of silently leaving the run parked', async () => {
    get.mockResolvedValue(baseDetail({ resumeRequired: RESUME_REQUIRED }));
    resume.mockRejectedValue(new Error('The durable callback could not be completed.'));
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /Resume run/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The durable callback could not be completed.',
    );
    // The action stays available: the failure was transient by contract.
    expect(screen.getByRole('button', { name: /Resume run/i })).toBeInTheDocument();
  });

  it('drops the resume affordance and points at rewind when the durable execution expired', async () => {
    // 409 is TERMINAL: the API already failed the run and cleared the marker, so
    // the reload must remove the button rather than leave a dead affordance.
    get
      .mockResolvedValueOnce(baseDetail({ resumeRequired: RESUME_REQUIRED }))
      .mockResolvedValue(baseDetail({ status: 'FAILED', resumeRequired: null }));
    resume.mockRejectedValue(
      new ApiError(409, 'Durable execution expired before this answer could resume the run', {
        code: 'durable_execution_expired',
      }),
    );
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /Resume run/i }));
    expect(await screen.findByText('This run can no longer be resumed')).toBeInTheDocument();
    expect(screen.getByText(/rewind to the stage you want to re-run/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resume run/i })).not.toBeInTheDocument();
  });

  it('keeps the resume affordance for a retryable 503', async () => {
    get.mockResolvedValue(baseDetail({ resumeRequired: RESUME_REQUIRED }));
    resume.mockRejectedValue(
      new ApiError(503, 'The durable callback could not be completed. Try again in a moment.', {
        code: 'durable_callback_resume_failed',
        retryable: true,
      }),
    );
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: /Resume run/i }));
    expect(await screen.findByText('Resume did not go through')).toBeInTheDocument();
    expect(screen.getByText(/try Resume again in a moment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume run/i })).toBeInTheDocument();
    // Distinct from the terminal case — no rewind instruction, no failure styling.
    expect(screen.queryByText('This run can no longer be resumed')).not.toBeInTheDocument();
  });
});

const reviewDetail = (gateOver: Record<string, unknown>) => ({
  ...baseDetail({ pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
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
      ...gateOver,
    },
  ],
});

const openReview = async () => {
  renderAt();
  await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
  expect(await screen.findByText('Review: stage-a')).toBeInTheDocument();
};

describe('validation gate findings and override', () => {
  it('renders nothing new for a gate without findings', async () => {
    get.mockResolvedValue(reviewDetail({}));
    await openReview();
    expect(screen.queryByText('Findings for your decision')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking finding/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve stage/i })).toBeInTheDocument();
  });

  it('lists the findings with their remediation', async () => {
    get.mockResolvedValue(
      reviewDetail({
        findings: [
          {
            code: 'review_advisory_findings',
            severity: 'advisory',
            title: 'Advisory review (arch-reviewer): NOT-READY',
            detail: null,
            overridable: false,
            receiptKind: null,
            remediation: 'The advisory reviewer does not block.',
          },
        ],
      }),
    );
    await openReview();
    expect(screen.getByText('Findings for your decision')).toBeInTheDocument();
    expect(screen.getByText('Advisory review (arch-reviewer): NOT-READY')).toBeInTheDocument();
    expect(screen.getByText(/The advisory reviewer does not block/)).toBeInTheDocument();
    // Advisory findings never change the answer options.
    expect(screen.queryByRole('button', { name: /blocking finding/i })).not.toBeInTheDocument();
  });

  it('offers override-and-approve when the engine offers it, and records it as an approval', async () => {
    get.mockResolvedValue(
      reviewDetail({
        // A gate with an overridable block does NOT offer plain approve.
        options: ['request-changes', 'override-and-approve'],
        findings: [
          {
            code: 'sensor_gate_blocking',
            severity: 'blocking',
            title: 'Sensor claim-sources (gate) → FAIL on requirements.md',
            detail: { sensorId: 'claim-sources' },
            overridable: true,
            receiptKind: 'sensor-override',
            remediation: 'Override to accept the verdict on the record.',
          },
        ],
      }),
    );
    answerGate.mockResolvedValue({});
    await openReview();

    expect(
      screen.getByText('Sensor claim-sources (gate) → FAIL on requirements.md'),
    ).toBeInTheDocument();
    // Plain approve is gone; the override button NAMES what it accepts and the
    // click is confirmed explicitly before the answer is sent.
    expect(screen.queryByRole('button', { name: /Approve stage/i })).not.toBeInTheDocument();
    const overrideButton = screen.getByRole('button', {
      name: 'Accept 1 blocking finding(s) & approve',
    });
    // The override is refused until the human says why.
    expect(overrideButton).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText(/Why are you accepting the blocking finding/i),
      'Sourced in the linked ADR',
    );
    expect(screen.getByText('25/300')).toBeInTheDocument();

    // Declining the confirmation sends nothing.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(overrideButton);
    expect(answerGate).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await userEvent.click(overrideButton);
    expect(confirmSpy).toHaveBeenCalledWith(
      'Accept 1 blocking finding(s) and approve? Your name and the finding codes are recorded with this approval.',
    );
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: { decision: 'override-and-approve', reason: 'Sourced in the linked ADR' },
      status: 'approved',
    });
    confirmSpy.mockRestore();
  });

  it('withholds plain approve when the engine did not offer it', async () => {
    get.mockResolvedValue(
      reviewDetail({
        options: ['request-changes'],
        findings: [
          {
            code: 'required_artifact_missing',
            severity: 'blocking',
            title: 'Required output "requirements" was not produced',
            detail: { artifact: 'requirements' },
            overridable: false,
            receiptKind: null,
            remediation: 'Send the stage back so the agent creates requirements.',
          },
        ],
      }),
    );
    await openReview();
    expect(screen.queryByRole('button', { name: /Approve stage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking finding/i })).not.toBeInTheDocument();
    // Request changes remains, so the run is never stuck at this gate.
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument();
  });

  it('shows maintained dissent verbatim as a quote', async () => {
    get.mockResolvedValue(
      reviewDetail({
        findings: [
          {
            code: 'review_dissent_maintained',
            severity: 'advisory',
            title: 'Maintained dissent (aidlc-quality-agent)',
            detail: { agentRef: 'aidlc-quality-agent' },
            overridable: false,
            receiptKind: null,
            remediation: 'Decide whether the objection changes your approval.',
            quote: 'OBJECT: the retry budget ignores the 429 path',
          },
        ],
      }),
    );
    await openReview();
    const quote = screen.getByText('OBJECT: the retry budget ignores the 429 path');
    expect(quote.tagName).toBe('BLOCKQUOTE');
  });
});
