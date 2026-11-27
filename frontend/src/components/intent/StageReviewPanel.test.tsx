import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  StageReviewPanel,
  orderReviewerRuns,
  reviewerRunCrossUnitFindings,
  reviewerRunVerdict,
} from './StageReviewPanel';
import type { GateAnswer, IntentDetail, IntentGate, IntentSensorRun } from '@/services/intents';

// The panel pulls the intent context, the graph and a Yjs-backed textarea. None
// of that is under test here — the learnings ritual is — so each is stubbed to
// the smallest shape the component reads.
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ stageNameOf: (id: string) => id, openItemPreview: () => {} }),
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

const detail = (): IntentDetail =>
  ({
    stages: [{ stageInstanceId: 'si-1', stageId: 'requirements-analysis' }],
    artifacts: [],
    sensorRuns: [],
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

  it('sends the feedback with a loop-back, recorded as rejected', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel(
      gate({
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      }),
    );
    await userEvent.type(screen.getByLabelText(/Feedback for the agent/i), 'check the refund path');
    await userEvent.click(screen.getByRole('button', { name: 'Send back to code-generation' }));
    expect(confirm.mock.calls[0][0]).toContain('code-generation and this stage re-run');
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'rejected',
      answer: { decision: 'loop-back', feedback: 'check the refund path' },
    });
    confirm.mockRestore();
  });

  it('records grant-autonomy as an approval and asks for confirmation first', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel(gate({ options: ['approve', 'request-changes', 'grant-autonomy'] }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Approve and continue autonomously' }),
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain('without stopping');
    expect(String(confirm.mock.calls[0][0])).toContain(
      'This applies for the rest of the intent, rewinds included, until the intent is cancelled.',
    );
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), {
      status: 'approved',
      answer: { decision: 'grant-autonomy' },
    });
    confirm.mockRestore();
  });

  it('sends nothing when the autonomy confirmation is dismissed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel(gate({ options: ['approve', 'request-changes', 'grant-autonomy'] }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Approve and continue autonomously' }),
    );

    expect(onAnswer).not.toHaveBeenCalled();
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

describe('reviewerRunCrossUnitFindings', () => {
  it('returns the trimmed findings, or null when none were recorded', () => {
    expect(reviewerRunCrossUnitFindings(run({ detail: { crossUnitFindings: '  x  ' } }))).toBe('x');
    expect(reviewerRunCrossUnitFindings(run({ detail: { crossUnitFindings: '   ' } }))).toBeNull();
    expect(reviewerRunCrossUnitFindings(run({ detail: { verdict: 'READY' } }))).toBeNull();
    expect(reviewerRunCrossUnitFindings(run({ detail: null }))).toBeNull();
  });
});

describe('StageReviewPanel — findings for other units', () => {
  const withRuns = (sensorRuns: IntentSensorRun[]): IntentDetail =>
    ({ ...detail(), sensorRuns }) as unknown as IntentDetail;

  // The timeline event is cut at 4000 characters; the review is where the human
  // reads the whole report, so it must render past that bound.
  it('renders a report longer than 4000 characters in full, open by default on READY', () => {
    const tail = 'END-OF-CROSS-UNIT-REPORT';
    const report = `The billing unit owns the shared invoice schema. ${'x'.repeat(4500)} ${tail}`;
    expect(report.length).toBeGreaterThan(4000);
    renderPanel(
      gate(),
      withRuns([
        run({
          sensorRunId: 'sr-ready',
          result: 'PASS',
          detail: { verdict: 'READY', findings: 'Lane is fine.', crossUnitFindings: report },
        }),
      ]),
    );

    expect(screen.getByText('Findings for other units')).toBeInTheDocument();
    const section = screen.getByTestId('cross-unit-run-sr-ready');
    expect(section.textContent).toContain(tail);
    expect(section.textContent).toContain('x'.repeat(4500));
    expect(screen.getByText(/not counted towards the\s+verdict/)).toBeInTheDocument();
  });

  it('keeps the findings out of the verdict section and lists runs newest first', () => {
    renderPanel(
      gate(),
      withRuns([
        run({
          sensorRunId: 'old',
          timestamp: '2026-01-01T00:00:00Z',
          detail: { verdict: 'READY', findings: 'Round one.', crossUnitFindings: 'Older note.' },
        }),
        run({
          sensorRunId: 'new',
          timestamp: '2026-02-01T00:00:00Z',
          result: 'FAIL',
          detail: {
            verdict: 'NOT-READY',
            findings: 'Round two.',
            crossUnitFindings: 'Newer note.',
          },
        }),
      ]),
    );

    const ids = screen
      .getAllByTestId(/^cross-unit-run-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['cross-unit-run-new', 'cross-unit-run-old']);
    // NOT-READY opens the verdict section and its newest run: the author-facing
    // findings are there, the other units' findings are not.
    const verdictRun = screen.getByTestId('reviewer-run-new');
    expect(verdictRun.textContent).toContain('Round two.');
    expect(verdictRun.textContent).not.toContain('Newer note.');
  });

  it('shows no section when no run recorded findings for other units', () => {
    renderPanel(
      gate(),
      withRuns([
        run({ detail: { verdict: 'READY', findings: 'Lane is fine.', crossUnitFindings: '  ' } }),
      ]),
    );
    expect(screen.queryByText('Findings for other units')).toBeNull();
  });
});
