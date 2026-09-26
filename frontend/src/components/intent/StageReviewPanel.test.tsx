import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { StageReviewPanel } from './StageReviewPanel';
import type { IntentDetail, IntentGate } from '@/services/intents';

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

import type { GateAnswer } from '@/services/intents';

let onAnswer: Mock<(gate: IntentGate, input: GateAnswer) => Promise<void>>;

const renderPanel = (g: IntentGate) => {
  onAnswer = vi.fn<(gate: IntentGate, input: GateAnswer) => Promise<void>>(async () => {});
  render(
    <StageReviewPanel
      gate={g}
      detail={detail()}
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
});
