vi.mock('@/contexts/SpacePermissionsContext', () => ({
  useSpacePermissions: () => ({ readOnly: false, role: 'owner' }),
}));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { StageReviewPanel, orderReviewerRuns, reviewerRunVerdict } from './StageReviewPanel';
import type { GateAnswer, IntentDetail, IntentGate, IntentSensorRun } from '@/services/intents';

// The panel pulls the intent context, the graph and a Yjs-backed textarea. None
// of that is under test here — the learnings ritual is — so each is stubbed to
// the smallest shape the component reads.
const access = vi.hoisted(() => ({ edit: true, decide: true }));
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    gateAccess: () => ({ stage: { reason: 'unmapped' }, access }),
    stageNameOf: (id: string) => id,
    openItemPreview: () => {},
  }),
}));
vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: () => ({ itemsByArtifact: new Map(), getNeighbors: () => [] }),
}));
// A minimal in-memory stand-in for the Y.Text the feedback box binds to: enough
// of observe / toString / insert / delete for the component's own diff-apply path.
const fakeYDoc = () => {
  const observers = new Set<() => void>();
  let value = '';
  const text = {
    toString: () => value,
    observe: (fn: () => void) => observers.add(fn),
    unobserve: (fn: () => void) => observers.delete(fn),
    insert: (index: number, chunk: string) => {
      value = value.slice(0, index) + chunk + value.slice(index);
    },
    delete: (index: number, length: number) => {
      value = value.slice(0, index) + value.slice(index + length);
    },
  };
  return {
    getText: () => text,
    transact: (fn: () => void) => {
      fn();
      for (const observer of observers) observer();
    },
  };
};
// One doc per test, not per render: a fresh instance on every render would drop
// the observers the component registered and silently reset the text.
let sharedDoc = fakeYDoc();
vi.mock('@/hooks/useYjsDocument', () => ({
  useYjsDocument: () => ({
    doc: sharedDoc,
    synced: true,
    awareness: null,
    remoteUsers: new Map(),
  }),
}));
vi.mock('@/components/CollaborativeTextarea', () => ({
  CollaborativeTextarea: (props: Record<string, unknown>) => (
    <textarea
      id={props.id as string}
      disabled={props.disabled as boolean}
      value={props.value as string}
      onChange={(e) => (props.onChange as (v: string) => void)(e.target.value)}
    />
  ),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({ DiscussButton: () => null }));
vi.mock('@/components/intent/ArtifactViewer', () => ({ ArtifactViewer: () => null }));

const gate = (over: Partial<IntentGate> = {}): IntentGate =>
  ({
    humanTaskId: 'h1',
    stageInstanceId: 'si-1',
    kind: 'validation',
    status: 'pending',
    prompt: 'Review stage requirements-analysis.',
    options: ['approve', 'request-changes'],
    questions: null,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: null,
    ...over,
  }) as IntentGate;

const detail = (over: Partial<IntentDetail> = {}): IntentDetail =>
  ({
    stages: [{ stageInstanceId: 'si-1', stageId: 'requirements-analysis' }],
    artifacts: [],
    sensorRuns: [],
    ...over,
  }) as unknown as IntentDetail;

let onAnswer: Mock<(gate: IntentGate, input: GateAnswer) => Promise<void>>;

const renderPanel = (g: IntentGate, d: IntentDetail = detail()) => {
  onAnswer = vi.fn<(gate: IntentGate, input: GateAnswer) => Promise<void>>(async () => {});
  render(
    <StageReviewPanel
      gate={g}
      detail={d}
      projectId="p1"
      intentId="i1"
      userName="Ada"
      onAnswer={onAnswer}
      onBack={() => {}}
    />,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  sharedDoc = fakeYDoc();
  Object.assign(access, { edit: true, decide: true });
});

it('lets a Contributor write shared feedback while reserving submission for a Decision Maker', async () => {
  access.decide = false;
  renderPanel(gate());
  const feedback = screen.getByLabelText('Feedback for the agent');
  await userEvent.type(feedback, 'Please review this risk');
  expect(feedback).toHaveValue('Please review this risk');
  expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Request changes/i })).toBeDisabled();
  expect(onAnswer).not.toHaveBeenCalled();
});

describe('StageReviewPanel — review summary and approve label (W1)', () => {
  it('stat tiles read in sentence case and say "Not reviewed yet" instead of "None"', () => {
    renderPanel(
      gate({ nextStageId: 'requirements-analysis' }),
      detail({
        artifacts: [
          {
            id: 'a1',
            artifactType: 'requirements',
            title: 'Requirements',
            content: '# Requirements',
            createdByStageInstanceId: 'si-1',
            createdByExecutionId: 'exec-1',
            createdAt: null,
          },
        ] as unknown as IntentDetail['artifacts'],
      }),
    );
    for (const label of ['Artifacts', 'Identified items', 'Reviewer verdict', 'Status']) {
      const tile = screen.getAllByText(label).find((el) => el.classList.contains('text-2xs'));
      expect(tile).toBeDefined();
      expect(tile).not.toHaveClass('uppercase');
      expect(tile).not.toHaveClass('tracking-wide');
    }
    expect(screen.getByText('Not reviewed yet')).toBeInTheDocument();
    expect(screen.queryByText('None')).toBeNull();
    // The section below the tiles does not repeat their count (D6).
    const section = screen.getByRole('button', { name: 'Artifacts' });
    expect(section).toHaveTextContent(/^Artifacts$/);
  });

  it('names the next stage in display form on the approve button, never a slug', () => {
    renderPanel(gate({ nextStageId: 'requirements-analysis' }));
    expect(
      screen.getByRole('button', { name: 'Approve — continue to Requirements Analysis' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/requirements-analysis$/)).toBeNull();
  });
});

describe('StageReviewPanel — learnings ritual', () => {
  it('offers no learnings field unless the engine flagged the gate', () => {
    renderPanel(gate());
    expect(screen.queryByLabelText(/Anything to add for next time/i)).toBeNull();
    renderPanel(gate({ learningsRitual: false }));
    expect(screen.queryByLabelText(/Anything to add for next time/i)).toBeNull();
  });

  it('carries the text on the approve answer when the ritual is on', async () => {
    renderPanel(gate({ learningsRitual: true }));
    const field = screen.getByLabelText(/Anything to add for next time/i);
    await userEvent.type(field, 'NEVER store plaintext secrets');
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));

    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ humanTaskId: 'h1' }), {
      status: 'approved',
      answer: { decision: 'approve', learnings: 'NEVER store plaintext secrets' },
    });
  });

  // An empty field is a valid answer — "nothing to add" — so it must not block
  // approval and must not send an empty string the backend would have to filter.
  it('approves with no learnings key when the field is left empty', async () => {
    renderPanel(gate({ learningsRitual: true }));
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'approved',
      answer: { decision: 'approve' },
    });
  });

  it('caps the learning at 4000 characters and shows the count', async () => {
    renderPanel(gate({ learningsRitual: true }));
    const field = screen.getByLabelText(/Anything to add for next time/i);
    expect(field).toHaveAttribute('maxLength', '4000');
    await userEvent.type(field, 'abc');
    expect(screen.getByTestId('review-learnings-count')).toHaveTextContent('3/4000');
  });

  it('never attaches learnings to a request-changes answer', async () => {
    renderPanel(gate({ learningsRitual: true }));
    await userEvent.type(screen.getByLabelText(/Anything to add for next time/i), 'later');
    await userEvent.type(screen.getByLabelText(/Feedback for the agent/i), 'fix the headings');
    await userEvent.click(screen.getByRole('button', { name: /Request changes/i }));
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'rejected',
      answer: { decision: 'request-changes', feedback: 'fix the headings' },
    });
  });

  // The reason is the agent's own words. Before it was exposed the panel showed a
  // generic sentence instead, whatever the agent had actually found.
  it("shows the agent's reason when the option is offered", () => {
    renderPanel(
      gate({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
        loopBackReason: 'the payment integration tests fail',
        loopBackStatus: 'offered',
        loopBackNote: 'Choose loop-back to send this work back to code-generation.',
      }),
    );
    expect(screen.getByText(/the payment integration tests fail/)).toBeInTheDocument();
  });

  // The withheld cases are the ones a reviewer was shown NOTHING about: the cap
  // being spent, and every per-unit build-and-test cell. The engine's note is the
  // only explanation that survives, because the recommendation is cleared off the
  // stage row as soon as the gate opens.
  it.each([
    ['at-cap' as const, 'This intent has already used all 3 loop-backs.'],
    ['unavailable' as const, 'Loop-back is not offered here: it goes back only to a stage.'],
  ])('explains a recommendation the engine withheld (%s)', (loopBackStatus, loopBackNote) => {
    renderPanel(
      gate({
        options: ['approve', 'request-changes'],
        loopBackReason: 'the payment integration tests fail',
        loopBackStatus,
        loopBackNote,
      }),
    );
    expect(screen.getByText(/the payment integration tests fail/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(loopBackNote.slice(0, 30)))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send back to/i })).not.toBeInTheDocument();
  });

  it('says nothing about a loop-back on a gate with no recommendation', () => {
    renderPanel(gate({ options: ['approve', 'request-changes'] }));
    expect(screen.queryByText(/recommends revising the generated code/)).not.toBeInTheDocument();
  });

  // Audit X7: every consequential decision confirms through the design-system
  // AlertDialog (consequence sentence, Cancel focused), never window.confirm.
  it('sends the feedback with a loop-back, recorded as rejected, once confirmed in the dialog', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderPanel(
      gate({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await userEvent.type(screen.getByLabelText(/Feedback for the agent/i), 'check the refund path');
    await userEvent.click(screen.getByRole('button', { name: 'Send back to code-generation' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Send this work back to code-generation?',
    });
    expect(dialog).toHaveTextContent('code-generation and this stage re-run from scratch');
    expect(dialog).toHaveTextContent('earlier plan approvals and reviews will be invalidated');
    expect(onAnswer).not.toHaveBeenCalled();
    // Irreversible: Cancel takes focus, the action is the destructive one.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const action = screen.getByRole('button', { name: 'Send back and re-run' });
    expect(action).toHaveClass('bg-destructive');

    await userEvent.click(action);
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'rejected',
      answer: { decision: 'loop-back', feedback: 'check the refund path' },
    });
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('sends nothing when the loop-back dialog is cancelled', async () => {
    renderPanel(
      gate({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send back to code-generation' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('records grant-autonomy as an approval after the dialog states the consequence', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderPanel(gate({ options: ['approve', 'request-changes', 'grant-autonomy'] }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Approve and continue autonomously' }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('without stopping');
    expect(dialog).toHaveTextContent(
      'This applies for the rest of the intent, rewinds included, until the intent is cancelled.',
    );
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Approve and run autonomously' }));
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'approved',
      answer: { decision: 'grant-autonomy' },
    });
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('sends nothing when the autonomy dialog is dismissed', async () => {
    renderPanel(gate({ options: ['approve', 'request-changes', 'grant-autonomy'] }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Approve and continue autonomously' }),
    );
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('names the blocking findings waived in the override dialog and records the reason', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderPanel(
      gate({
        options: ['approve', 'request-changes', 'override-and-approve'],
        findings: [
          { code: 'F1', title: 'Unsourced claim', severity: 'blocking', overridable: true },
          { code: 'F2', title: 'Missing NFR', severity: 'blocking', overridable: true },
        ],
      }),
    );
    const trigger = screen.getByRole('button', { name: /Accept 2 blocking finding/ });
    expect(trigger).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText(/Why are you accepting the blocking finding/i),
      'Sourced in ADR-7',
    );
    await userEvent.click(trigger);

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Accept 2 blocking findings and approve?',
    });
    expect(dialog).toHaveTextContent('Your name and the finding codes are recorded');
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Accept findings and approve' }));
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'approved',
      answer: { decision: 'override-and-approve', reason: 'Sourced in ADR-7' },
    });
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('offers no autonomy button when the gate does not list the option', () => {
    renderPanel(gate({ options: ['approve', 'request-changes'] }));
    expect(
      screen.queryByRole('button', { name: 'Approve and continue autonomously' }),
    ).not.toBeInTheDocument();
  });
});

const run = (over: Partial<IntentSensorRun> = {}): IntentSensorRun =>
  ({
    sensorRunId: 'sr-1',
    stageInstanceId: 'si-1',
    sensorId: 'reviewer:architecture',
    result: 'PASS',
    severity: 'info',
    held: false,
    detail: null,
    timestamp: '2026-01-01T00:00:00Z',
    ...over,
  }) as IntentSensorRun;

describe('orderReviewerRuns', () => {
  it('orders parseable timestamps most-recent-first (FR1.1/FR1.2)', () => {
    const older = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const newer = run({ sensorRunId: 'b', timestamp: '2026-03-01T00:00:00Z' });
    expect(orderReviewerRuns([older, newer]).map((r) => r.sensorRunId)).toEqual(['b', 'a']);
  });

  it('sinks a run with a missing timestamp to the bottom (R-01)', () => {
    const parseable = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const missing = run({ sensorRunId: 'b', timestamp: undefined as unknown as string });
    expect(orderReviewerRuns([missing, parseable]).map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('sinks an unparseable timestamp to the bottom without throwing (R-01)', () => {
    const parseable = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const bad = run({ sensorRunId: 'b', timestamp: 'not-a-date' });
    let ordered: IntentSensorRun[] = [];
    expect(() => {
      ordered = orderReviewerRuns([bad, parseable]);
    }).not.toThrow();
    expect(ordered.map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('preserves input order for equal timestamps (stable)', () => {
    const first = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const second = run({ sensorRunId: 'b', timestamp: '2026-01-01T00:00:00Z' });
    expect(orderReviewerRuns([first, second]).map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [
      run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' }),
      run({ sensorRunId: 'b', timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const before = input.map((r) => r.sensorRunId);
    orderReviewerRuns(input);
    expect(input.map((r) => r.sensorRunId)).toEqual(before);
  });

  it('REGRESSION: raw API order (oldest first) is reordered so newest is index 0 (NFR4)', () => {
    // Reproduces the defect: the old flat map rendered runs in API order, so an
    // older iteration appeared/opened first. Ordering must surface the newest.
    const rawApiOrder = [
      run({ sensorRunId: 'iter-1', timestamp: '2026-01-01T00:00:00Z' }),
      run({ sensorRunId: 'iter-2', timestamp: '2026-02-01T00:00:00Z' }),
      run({ sensorRunId: 'iter-3', timestamp: '2026-03-01T00:00:00Z' }),
    ];
    expect(orderReviewerRuns(rawApiOrder).map((r) => r.sensorRunId)).toEqual([
      'iter-3',
      'iter-2',
      'iter-1',
    ]);
  });
});

describe('reviewerRunVerdict', () => {
  it('returns detail.verdict when present', () => {
    expect(reviewerRunVerdict(run({ detail: { verdict: 'READY' }, result: 'PASS' }))).toBe('READY');
  });

  it('falls back to result when detail.verdict is absent', () => {
    expect(reviewerRunVerdict(run({ detail: null, result: 'FAIL' }))).toBe('FAIL');
  });
});
