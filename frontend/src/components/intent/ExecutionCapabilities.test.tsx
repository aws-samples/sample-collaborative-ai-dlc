import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Intent, IntentArtifact, IntentDetail, IntentGate } from '@/services/intents';
import type { IntentStageRow, useIntent } from '@/contexts/IntentContext';
import { ArtifactEditControls, ArtifactStaleBadge } from './ArtifactEditControls';
import { WaitingCard } from './WaitingCard';
import { HistorySection } from './HistorySection';
import { GateCard } from './GateCard';
import { StageDetail } from './StageDetail';
import { IntentStageList } from './IntentStageList';

const mocks = vi.hoisted(() => ({
  context: {} as ReturnType<typeof useIntent>,
  artifactImpact: vi.fn(),
  verifyArtifact: vi.fn(),
  startQuorumEdit: vi.fn(),
  questionSubmit: undefined as undefined | ((answer: unknown) => Promise<void>),
}));
vi.mock('@/contexts/IntentContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/IntentContext')>()),
  useIntent: () => mocks.context,
}));
vi.mock('@/services/intents', () => ({
  intentsService: {
    artifactImpact: mocks.artifactImpact,
    verifyArtifact: mocks.verifyArtifact,
    startQuorumEdit: mocks.startQuorumEdit,
  },
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <span>Discussion</span>,
}));
vi.mock('@/components/QuestionEditor', () => ({
  default: ({
    onAnswer,
    disabled,
  }: {
    onAnswer: (answer: unknown) => Promise<void>;
    disabled?: boolean;
  }) => {
    mocks.questionSubmit = onAnswer;
    return (
      <button
        disabled={disabled}
        onClick={() => onAnswer({ answers: [{ freeText: 'Keep the scope' }] })}
      >
        Submit shared answer
      </button>
    );
  },
}));

const artifact = {
  id: 'a1',
  title: 'Design',
  staleSince: '2026-01-01T00:00:00Z',
} as IntentArtifact;
const row = {
  stageInstanceId: 'si-design',
  stageId: 'design',
  planned: true,
  state: 'FAILED',
  phase: '01',
  order: 0,
  attempt: 1,
} as IntentStageRow;
const gate = {
  humanTaskId: 'h1',
  stageInstanceId: 'si-design',
  kind: 'question',
  status: 'answered',
  questions: '[{"text":"Which scope?"}]',
  answer: 'MVP',
} as IntentGate;

function setExecution(overrides: Partial<Intent> = {}) {
  mocks.context = {
    projectId: 'p1',
    intentId: 'i1',
    detail: {
      intent: { id: 'i1', status: 'WAITING', currentStage: 'design', ...overrides },
      artifacts: [],
      quorumEdits: [],
      metrics: [],
    } as unknown as IntentDetail,
    reload: vi.fn().mockResolvedValue(undefined),
    reviseGate: vi.fn().mockResolvedValue(undefined),
    rewindIntent: vi.fn().mockResolvedValue(undefined),
    stageNameOf: (id: string) => (id === 'si-design' ? 'Design' : id),
    phaseNameOf: () => 'Inception',
    stageRows: [row],
    stageEdges: [],
    gates: [],
    steering: [],
    artifactsByStage: new Map(),
    sensorsByStage: new Map(),
    outputBuffers: new Map(),
    setSelectedStageId: vi.fn(),
  } as unknown as ReturnType<typeof useIntent>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactImpact.mockResolvedValue({ consumingStages: [], downstream: [] });
  mocks.verifyArtifact.mockResolvedValue({});
  mocks.startQuorumEdit.mockResolvedValue({});
  setExecution();
});

describe('execution capability controls', () => {
  it.each(['native', 'future-backend'])(
    'blocks artifact mutation services for %s',
    async (executionBackend) => {
      setExecution({ executionBackend });
      const onStartEdit = vi.fn();
      render(
        <>
          <ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />
          <ArtifactStaleBadge artifact={artifact} />
        </>,
      );
      for (const name of ['Edit document', 'Edit with Quorum', 'Mark verified']) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        await userEvent.click(button);
      }
      expect(mocks.artifactImpact).not.toHaveBeenCalled();
      expect(mocks.verifyArtifact).not.toHaveBeenCalled();
      expect(mocks.startQuorumEdit).not.toHaveBeenCalled();
      expect(onStartEdit).not.toHaveBeenCalled();
    },
  );

  it('preserves legacy edits and verification', async () => {
    const onStartEdit = vi.fn();
    render(
      <>
        <ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />
        <ArtifactStaleBadge artifact={artifact} />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark verified' }));
    expect(mocks.verifyArtifact).toHaveBeenCalledWith('p1', 'i1', 'a1');
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit anyway' }));
    expect(onStartEdit).toHaveBeenCalledOnce();
  });

  it('honors independent platform restrictions and an already-open edit dialog', async () => {
    const onStartEdit = vi.fn();
    const { rerender } = render(
      <ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    await screen.findByRole('button', { name: 'Edit anyway' });
    mocks.context.detail!.intent.executionCapabilities = { artifactEdit: false, quorumEdit: false };
    // The DTO is replaced on reload, just as in the provider.
    mocks.context = { ...mocks.context, detail: { ...mocks.context.detail! } };
    rerender(<ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />);
    expect(screen.getByRole('button', { name: 'Edit anyway' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Edit anyway' }));
    expect(onStartEdit).not.toHaveBeenCalled();
  });

  it.each(['native', 'future-backend'])(
    'disables waiting-stage restart for %s',
    async (executionBackend) => {
      setExecution({ executionBackend });
      render(
        <WaitingCard
          intent={mocks.context.detail!.intent}
          gates={[]}
          stageRows={mocks.context.stageRows}
          stageNameOf={mocks.context.stageNameOf}
          rewindIntent={mocks.context.rewindIntent}
        />,
      );
      for (const name of ['Restart stage', 'Restart with guidance']) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
        await userEvent.click(screen.getByRole('button', { name }));
      }
      expect(mocks.context.rewindIntent).not.toHaveBeenCalled();
    },
  );

  it('blocks both mouse and keyboard retries in a native stage list', () => {
    setExecution({ executionBackend: 'native', status: 'FAILED' });
    render(<IntentStageList />);
    const retry = screen.getByRole('button', { name: 'Retry stage design' });
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(retry);
    fireEvent.keyDown(retry, { key: 'Enter' });
    fireEvent.keyDown(retry, { key: ' ' });
    expect(mocks.context.rewindIntent).not.toHaveBeenCalled();
  });

  it('disables native stage-detail retries while preserving stage viewing', async () => {
    setExecution({ executionBackend: 'native', status: 'FAILED' });
    render(<StageDetail row={row} />);
    for (const name of ['Retry stage', 'Restart from this stage']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name }));
    }
    expect(mocks.context.rewindIntent).not.toHaveBeenCalled();
  });

  it.each([undefined, 'native'])(
    'keeps answer history visible and restricts revisions for %s',
    async (executionBackend) => {
      setExecution({ executionBackend });
      render(
        <HistorySection
          questionGates={[gate]}
          steering={[]}
          influencedArtifactsByQuestion={new Map()}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /Past questions/ }));
      await userEvent.click(screen.getByRole('button', { name: /Which scope/ }));
      expect(screen.getByText('MVP')).toBeInTheDocument();
      const revise = screen.getByRole('button', { name: 'Revise answer' });
      if (executionBackend) {
        expect(revise).toBeDisabled();
        await userEvent.click(revise);
        expect(mocks.context.reviseGate).not.toHaveBeenCalled();
      } else {
        await userEvent.click(revise);
        await userEvent.type(
          screen.getByPlaceholderText('What should the agent do differently?'),
          'Use v2',
        );
        await userEvent.click(screen.getByRole('button', { name: 'Send correction' }));
        await waitFor(() => expect(mocks.context.reviseGate).toHaveBeenCalledWith(gate, 'Use v2'));
      }
    },
  );

  it.each([undefined, 'platform', 'native', 'future-backend'])(
    'guards approval choices without interpreting their labels for %s',
    async (executionBackend) => {
      setExecution({ executionBackend });
      const onAnswer = vi.fn().mockResolvedValue(undefined);
      const options = ['approve', 'request-changes', 'retry', 'skip', 'autonomous', 'gated'];
      const approval = {
        ...gate,
        kind: 'approval',
        status: 'pending',
        questions: null,
        options,
      } as IntentGate;
      render(
        <MemoryRouter>
          <GateCard gate={approval} projectId="p1" intentId="i1" userName="U" onAnswer={onAnswer} />
        </MemoryRouter>,
      );
      if (executionBackend === 'native' || executionBackend === 'future-backend') {
        for (const name of options) {
          const button = screen.getByRole('button', { name });
          expect(button).toBeDisabled();
          await userEvent.click(button);
        }
        expect(screen.getByRole('textbox')).toBeDisabled();
        expect(onAnswer).not.toHaveBeenCalled();
        return;
      }
      for (const name of ['retry', 'skip', 'autonomous', 'gated']) {
        expect(screen.getByRole('button', { name })).toBeEnabled();
        await userEvent.click(screen.getByRole('button', { name }));
        expect(onAnswer).toHaveBeenLastCalledWith(approval, {
          status: 'answered',
          answer: { decision: name },
        });
      }
      expect(screen.getByRole('button', { name: 'request-changes' })).toBeEnabled();
      await userEvent.click(screen.getByRole('button', { name: 'approve' }));
      expect(onAnswer).toHaveBeenCalledWith(approval, {
        status: 'approved',
        answer: { decision: 'approve' },
      });
    },
  );

  it('disables native review choices and application retries', async () => {
    setExecution({ executionBackend: 'native', status: 'FAILED' });
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const reviewGate = {
      ...gate,
      kind: 'review-verdict',
      status: 'pending',
      questions: null,
      options: ['retry', 'skip'],
    } as IntentGate;
    render(
      <MemoryRouter>
        <GateCard gate={reviewGate} projectId="p1" intentId="i1" userName="U" onAnswer={onAnswer} />
        <StageDetail row={row} />
      </MemoryRouter>,
    );
    const appRetry = screen.getByRole('button', { name: 'Retry stage' });
    expect(appRetry).toBeDisabled();
    await userEvent.click(appRetry);
    expect(mocks.context.rewindIntent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'retry' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText('Native approvals are not available yet')).toBeInTheDocument();
  });

  it('blocks native question answers in both the editor and its submission handler', async () => {
    setExecution({ executionBackend: 'native' });
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <GateCard gate={gate} projectId="p1" intentId="i1" userName="U" onAnswer={onAnswer} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox')).toBeDisabled();
    const submit = screen.getByRole('button', { name: 'Submit shared answer' });
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    await expect(mocks.questionSubmit?.({ answers: [{ freeText: 'Bypass' }] })).rejects.toThrow(
      'Answering native questions is not available yet',
    );
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText('Answering native questions is not available yet')).toBeInTheDocument();
  });

  it.each(['approval', 'review-verdict'] as const)(
    'disables fallback %s actions when native options are missing',
    async (kind) => {
      setExecution({ executionBackend: 'native' });
      const onAnswer = vi.fn().mockResolvedValue(undefined);
      render(
        <MemoryRouter>
          <GateCard
            gate={{ ...gate, kind, questions: null, options: null }}
            projectId="p1"
            intentId="i1"
            userName="U"
            onAnswer={onAnswer}
          />
        </MemoryRouter>,
      );
      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
      expect(onAnswer).not.toHaveBeenCalled();
    },
  );
});
