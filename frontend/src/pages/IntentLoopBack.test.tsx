import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

// The Build-and-Test loop-back option on the stage review gate (issue #482
// The third button appears only when the engine offers the
// option AND named a target, it is labelled with that target, and it records as a
// loop-back decision with the rollback-safe rejected status.
//
// The harness mirrors IntentReleaseSemantics.test.tsx — heavy leaf components
// stubbed, a real IntentProvider over a mocked service — because the behaviour
// under test is the page's own wiring, not Yjs.

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
const answerGate = vi.fn();
const graph = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    resume: vi.fn(),
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
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

const GATE_ID = 'eg-validation-si-bt-0-run1';

const renderAt = () =>
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

const reviewDetail = (gateOver: Record<string, unknown>) => ({
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
    scope: 'express',
    currentPhase: null,
    currentStage: null,
    pendingHumanTaskId: GATE_ID,
    cliModels: null,
    environment: null,
    parkReleaseSeconds: 300,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  },
  stages: [
    {
      stageInstanceId: 'si-bt',
      stageId: 'build-and-test',
      state: 'WAITING_FOR_HUMAN',
      phase: 'construction',
    },
  ],
  events: [],
  gates: [
    {
      humanTaskId: GATE_ID,
      stageInstanceId: 'si-bt',
      unitSlug: null,
      kind: 'validation',
      status: 'pending',
      prompt: 'Review stage build-and-test.',
      options: ['approve', 'request-changes'],
      questions: null,
      answer: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: null,
      ...gateOver,
    },
  ],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

const openReview = async () => {
  renderAt();
  await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
  expect(await screen.findByText('Review: build-and-test')).toBeInTheDocument();
};

beforeEach(() => {
  clearIntentCache();
  get.mockReset();
  answerGate.mockReset().mockResolvedValue({});
  graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
});

describe('the loop-back option on a stage review gate', () => {
  it('renders nothing new for a gate that does not offer it', async () => {
    get.mockResolvedValue(reviewDetail({}));
    await openReview();
    expect(screen.queryByRole('button', { name: /Send back to/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/recommends revising the generated code/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve stage/i })).toBeInTheDocument();
  });

  it('offers a button naming the target the engine computed, and explains the cost', async () => {
    get.mockResolvedValue(
      reviewDetail({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await openReview();

    expect(
      screen.getByRole('button', { name: 'Send back to code-generation' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/recommends revising the generated code/i)).toBeInTheDocument();
    expect(
      screen.getByText(/earlier plan approvals and\s+reviews stop counting/i),
    ).toBeInTheDocument();
    // The loop-back is an ADDITION: approving and requesting changes stay available.
    expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request changes/i })).toBeInTheDocument();
  });

  it('records the loop-back with rejected status and its decision payload', async () => {
    get.mockResolvedValue(
      reviewDetail({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await openReview();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Send back to code-generation' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', GATE_ID, {
      answer: { decision: 'loop-back' },
      status: 'rejected',
    });
    confirmSpy.mockRestore();
  });

  it('confirms the target, fallback re-run scope, and lost approvals', async () => {
    get.mockResolvedValue(
      reviewDetail({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await openReview();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: 'Send back to code-generation' }));
    const [message] = confirmSpy.mock.calls[0];
    expect(message).toContain('Send this work back to code-generation?');
    expect(message).toContain('Every stage from code-generation onwards re-runs from scratch.');
    expect(message).toContain('approvals and reviews will be invalidated');
    // Declining sends nothing.
    expect(answerGate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('withholds the button when the engine offered the option but named no target', async () => {
    get.mockResolvedValue(reviewDetail({ options: ['approve', 'request-changes', 'loop-back'] }));
    await openReview();
    expect(screen.queryByRole('button', { name: /Send back to/i })).not.toBeInTheDocument();
  });

  it('withholds the button at the cap, where the engine names a target but no option', async () => {
    get.mockResolvedValue(
      reviewDetail({ options: ['approve', 'request-changes'], loopBackTarget: 'code-generation' }),
    );
    await openReview();
    expect(screen.queryByRole('button', { name: /Send back to/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/i })).toBeInTheDocument();
  });
});
