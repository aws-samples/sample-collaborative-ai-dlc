import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import QuestionEditor from './QuestionEditor';
import {
  nativeFormError,
  nativePendingInput,
  nativeQuestionForEditor,
} from '@/lib/nativePendingInput';
import { openedDocuments, resetCollaborationFakes } from '@/test/collaborationFakes';
import type { StructuredAnswer } from '@/services/questions';

vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/components/discussion', () => ({ DiscussButton: () => null }));

const input = nativePendingInput({
  schemaVersion: 2,
  kind: 'choice',
  source: 'rendered-question',
  stage: null,
  questions: [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `q${index + 1}`,
      prompt: `Question ${index + 1}?`,
      header: null,
      multiSelect: index === 1,
      options: [
        { label: `Small ${index + 1}`, description: null },
        { label: `Large ${index + 1}`, description: null },
      ],
    })),
    { id: 'q6', prompt: 'What constraints apply?', header: null, multiSelect: false, options: [] },
  ],
});
const scope = {
  kind: 'native' as const,
  id: 'intent',
  projectId: 'project',
  digest: 'd'.repeat(64),
  interactionId: 'a'.repeat(64),
  sequence: 1,
};
const question = nativeQuestionForEditor(input, scope.interactionId, '2026-10-15T07:00:00Z');
const props = {
  question,
  scope,
  userName: 'Alice',
  discussable: false,
  validateAnswer: (answer: StructuredAnswer) => nativeFormError(input, answer),
};
beforeEach(resetCollaborationFakes);
afterEach(cleanup);

it('requires every mixed question and submits the whole form once, retaining drafts on rejection', async () => {
  let reject!: (error: Error) => void;
  const onAnswer = vi.fn(
    (_answer: StructuredAnswer) =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  render(<QuestionEditor {...props} onAnswer={onAnswer} />);
  const form = screen.getByRole('form', { name: 'Workflow questions' });
  const submit = within(form).getByRole('button', { name: 'Submit All Answers' });
  expect(submit).toBeDisabled();
  fireEvent.submit(form);
  expect(onAnswer).not.toHaveBeenCalled();
  for (let i = 1; i <= 5; i++) fireEvent.click(within(form).getByText(`Small ${i}`));
  fireEvent.click(within(form).getByText('Large 2'));
  expect(submit).toBeDisabled();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Answer question 6' }), {
    target: { value: 'Must work offline.' },
  });
  expect(submit).toBeEnabled();
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer.mock.calls[0][0]).toMatchObject({
    answers: [
      { selectedOptions: [0] },
      { selectedOptions: [0, 1] },
      { selectedOptions: [0] },
      { selectedOptions: [0] },
      { selectedOptions: [0] },
      { selectedOptions: [], freeText: 'Must work offline.' },
    ],
  });
  await act(async () => reject(new Error('Unconfirmed; retry the same answer.')));
  expect(within(form).getByRole('textbox', { name: 'Answer question 6' })).toHaveValue(
    'Must work offline.',
  );
  expect(within(form).getByRole('button', { name: 'Submit All Answers' })).toBeEnabled();
});

it('shares drafts between members and across reload, while isolating the next interaction', () => {
  const onAnswer = vi.fn();
  const alice = render(<QuestionEditor {...props} onAnswer={onAnswer} />);
  const bob = render(<QuestionEditor {...props} userName="Bob" onAnswer={onAnswer} />);
  fireEvent.click(within(alice.container).getByText('Small 1'));
  fireEvent.change(within(bob.container).getByRole('textbox', { name: 'Answer question 6' }), {
    target: { value: 'Shared constraints' },
  });
  expect(within(alice.container).getByRole('textbox', { name: 'Answer question 6' })).toHaveValue(
    'Shared constraints',
  );
  alice.unmount();
  const reloaded = render(<QuestionEditor {...props} onAnswer={onAnswer} />);
  expect(
    within(reloaded.container).getByRole('textbox', { name: 'Answer question 6' }),
  ).toHaveValue('Shared constraints');
  expect(
    openedDocuments.every(
      ({ target }) =>
        target && 'executionBackend' in target && target.executionBackend === 'native',
    ),
  ).toBe(true);
  expect(
    openedDocuments.every(
      ({ target }) =>
        target && 'document' in target && target.document?.interactionId === scope.interactionId,
    ),
  ).toBe(true);
  const nextId = 'b'.repeat(64);
  reloaded.rerender(
    <QuestionEditor
      {...props}
      key={nextId}
      question={nativeQuestionForEditor(input, nextId, question.createdAt)}
      scope={{ ...scope, interactionId: nextId, sequence: 2 }}
      onAnswer={onAnswer}
    />,
  );
  expect(
    within(reloaded.container).getByRole('textbox', { name: 'Answer question 6' }),
  ).toHaveValue('');
  expect(within(bob.container).getByRole('textbox', { name: 'Answer question 6' })).toHaveValue(
    'Shared constraints',
  );
  expect(onAnswer).not.toHaveBeenCalled();
});
