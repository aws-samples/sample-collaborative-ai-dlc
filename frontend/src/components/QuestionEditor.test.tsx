import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Question } from '@/services/questions';
import QuestionEditor, { type QuestionReferences } from './QuestionEditor';

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

const referenceQuestion: Question = {
  id: 'h1',
  agent: 'agent',
  sprintId: '',
  createdAt: '',
  questions: [
    {
      text: 'How should sessions be kept? FR2.4 and [[requirements]] apply.',
      type: 'single',
      options: [
        {
          label: 'Keep tokens (dec-session-tokens as written)',
          description: 'No change to FR2.4.',
        },
        { label: 'Use server sessions' },
      ],
    },
  ],
};

const items = [
  { id: 'fr-node', slug: 'fr2-4', label: 'Sessions survive restarts' },
  { id: 'dec-node', slug: 'dec-session-tokens', label: 'Use short-lived session tokens' },
];

describe('QuestionEditor references', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps question and option text unlinked without references', () => {
    render(
      <QuestionEditor
        question={referenceQuestion}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Keep tokens (dec-session-tokens as written)')).toBeInTheDocument();
  });

  it('links references in the question and its options to their previews', () => {
    const references: QuestionReferences = {
      artifacts: [{ id: 'requirements', title: 'Requirements' }],
      derivedItems: items,
      onOpenArtifact: vi.fn(),
      onOpenItem: vi.fn(),
    };
    render(
      <QuestionEditor
        question={referenceQuestion}
        references={references}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    const requirementLinks = screen.getAllByRole('link', { name: 'FR2.4' });
    expect(requirementLinks).toHaveLength(2);
    expect(requirementLinks[0]).toHaveAttribute('title', 'Sessions survive restarts');

    fireEvent.click(screen.getByRole('link', { name: 'Requirements' }));
    expect(references.onOpenArtifact).toHaveBeenCalledWith('requirements');

    fireEvent.click(screen.getByRole('link', { name: 'dec-session-tokens' }));
    expect(references.onOpenItem).toHaveBeenCalledWith('dec-node');
    expect(mocks.setSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Use server sessions'));
    expect(mocks.setSelection).toHaveBeenCalledWith(0, [1]);
  });

  it('links identifiers defined in the intent documents, in text and options', () => {
    const references: QuestionReferences = {
      artifacts: [
        {
          id: 'unit-of-work',
          title: 'Units of work',
          content: '| Unit ID | Directory |\n|---|---|\n| U2 | u2-reporting |',
        },
      ],
      derivedItems: [],
      onOpenArtifact: vi.fn(),
      onOpenItem: vi.fn(),
    };
    render(
      <QuestionEditor
        question={{
          ...question,
          questions: [
            {
              text: 'Should U2 own the export?',
              type: 'single',
              options: [{ label: 'Yes', description: 'U2 owns it' }, { label: 'No' }],
            },
          ],
        }}
        references={references}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    const links = screen.getAllByRole('link', { name: 'U2' });
    expect(links).toHaveLength(2);
    fireEvent.click(links[1]);
    expect(references.onOpenArtifact).toHaveBeenCalledWith('unit-of-work', 'ref-unit-of-work--u2');
    expect(mocks.setSelection).not.toHaveBeenCalled();
  });
});
