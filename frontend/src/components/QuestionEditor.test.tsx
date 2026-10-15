import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Question } from '@/services/questions';
import QuestionEditor from './QuestionEditor';

const mocks = vi.hoisted(() => ({
  setSelection: vi.fn(),
  setFreeText: vi.fn(),
  toStructuredAnswer: vi.fn(),
  synced: true,
}));
vi.mock('@/hooks/useCollaborativeStructuredAnswer', () => ({
  useCollaborativeStructuredAnswer: () => ({
    selections: new Map([[0, [0]]]),
    freeTexts: new Map(),
    setSelection: mocks.setSelection,
    setFreeText: mocks.setFreeText,
    getFreeText: () => null,
    addContributor: vi.fn(),
    synced: mocks.synced,
    awareness: null,
    remoteUsers: new Map(),
    initFromDraft: vi.fn(),
    toStructuredAnswer: mocks.toStructuredAnswer,
  }),
}));
vi.mock('@/components/discussion', () => ({ DiscussButton: () => null }));
vi.mock('@/components/CollaborativeTextarea', () => ({
  CollaborativeTextarea: () => null,
}));

const question: Question = {
  id: 'q1',
  agent: 'agent',
  sprintId: '',
  createdAt: '',
  questions: [
    { text: 'Which scope?', type: 'single', options: [{ label: 'Small' }, { label: 'Large' }] },
  ],
};
const answer = { answers: [{ selectedOptions: [0] }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.toStructuredAnswer.mockReturnValue(answer);
  mocks.synced = true;
});

describe('QuestionEditor response availability', () => {
  it('waits for shared document synchronization even with a populated local draft', () => {
    mocks.synced = false;
    const onAnswer = vi.fn();
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i1', projectId: 'p1' }}
        userName="U"
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByRole('button', { name: 'Submit Answer' })).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('disables choices and submission when a previously open editor becomes unavailable', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const props = {
      question,
      scope: { kind: 'intent' as const, id: 'i1', projectId: 'p1' },
      userName: 'U',
      onAnswer,
    };
    const { rerender } = render(<QuestionEditor {...props} />);
    expect(screen.getByRole('button', { name: 'Submit Answer' })).toBeEnabled();
    rerender(<QuestionEditor {...props} disabled />);
    const submit = screen.getByRole('button', { name: 'Submit Answer' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByText('Large'));
    await userEvent.click(submit);
    expect(mocks.setSelection).not.toHaveBeenCalled();
    expect(mocks.toStructuredAnswer).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('preserves choice editing and submission when no restriction is supplied', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i1', projectId: 'p1' }}
        userName="U"
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByText('Large'));
    expect(mocks.setSelection).toHaveBeenCalledWith(0, [1]);
    await userEvent.click(screen.getByRole('button', { name: 'Submit Answer' }));
    expect(onAnswer).toHaveBeenCalledWith(answer);
  });
});
