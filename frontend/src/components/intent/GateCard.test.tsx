import { fireEvent, render, screen } from '@/test/query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentGate } from '@/services/intents';

const access = vi.hoisted(() => ({ edit: true, decide: true }));
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    gateAccess: () => ({ stage: { reason: 'unmapped' }, access }),
    stageNameOf: (id: string) => id,
    detail: { artifacts: [] },
    openArtifactPreview: vi.fn(),
    openItemPreview: vi.fn(),
  }),
}));
vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: () => ({ derivedItems: [] }),
}));
vi.mock('@/components/QuestionEditor', () => ({
  default: ({
    extra,
    onAnswer,
    canEdit,
    canSubmit,
  }: {
    extra?: React.ReactNode;
    onAnswer: (a: { answers: unknown[] }) => Promise<void>;
    canEdit?: boolean;
    canSubmit?: boolean;
  }) => (
    <div data-testid="question-editor" data-can-edit={canEdit} data-can-submit={canSubmit}>
      {extra}
      <button type="button" onClick={() => onAnswer({ answers: [] })}>
        Submit answer
      </button>
    </div>
  ),
}));

import { GateCard } from './GateCard';

const gate = (over: Partial<IntentGate> = {}): IntentGate =>
  ({
    humanTaskId: 'h1',
    stageInstanceId: 'si-1',
    status: 'pending',
    kind: 'question',
    prompt: null,
    options: null,
    questions: JSON.stringify([{ text: 'Where?', type: 'single', options: [{ label: 'A' }] }]),
    createdAt: '2026-08-05T17:41:00Z',
    ...over,
  }) as IntentGate;

const renderCard = (g: IntentGate, onAnswer = vi.fn().mockResolvedValue(undefined)) => {
  render(
    <MemoryRouter>
      <GateCard gate={g} projectId="p1" intentId="i1" userName="Ada" onAnswer={onAnswer} />
    </MemoryRouter>,
  );
  return onAnswer;
};

describe('GateCard — note to the agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(access, { edit: true, decide: true });
  });

  it('keeps the note inside the editor card and sends it with the answer', async () => {
    const onAnswer = renderCard(gate());

    const editor = screen.getByTestId('question-editor');
    const toggle = screen.getByRole('button', { name: /Add a note to the agent/ });
    expect(editor).toContainElement(toggle);
    expect(document.querySelector('details')).toBeNull();

    fireEvent.click(toggle);
    const note = await screen.findByRole('textbox', { name: /note to the agent/i });
    fireEvent.change(note, { target: { value: '  Use the event bus  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ humanTaskId: 'h1' }),
      expect.objectContaining({ steering: 'Use the event bus' }),
    );
  });

  it('sends no steering when the note is empty', () => {
    const onAnswer = renderCard(gate());
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(onAnswer.mock.calls[0][1]).not.toHaveProperty('steering');
  });

  it('keeps the stage permissions: a contributor edits but cannot submit or steer', async () => {
    Object.assign(access, { edit: true, decide: false });
    renderCard(gate());

    expect(screen.getByText('You can edit answers.')).toBeVisible();
    const editor = screen.getByTestId('question-editor');
    expect(editor).toHaveAttribute('data-can-edit', 'true');
    expect(editor).toHaveAttribute('data-can-submit', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Add a note to the agent/ }));
    expect(await screen.findByRole('textbox', { name: /note to the agent/i })).toBeDisabled();
  });
});
