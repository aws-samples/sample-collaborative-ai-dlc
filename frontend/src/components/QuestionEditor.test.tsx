import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import QuestionEditor, { type QuestionReferences } from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';

const setSelection = vi.fn();

vi.mock('@/hooks/useCollaborativeStructuredAnswer', () => ({
  useCollaborativeStructuredAnswer: () => ({
    selections: new Map(),
    freeTexts: new Map(),
    setSelection,
    setFreeText: vi.fn(),
    getFreeText: () => new Y.Doc().getText('t'),
    addContributor: vi.fn(),
    synced: true,
    awareness: {},
    remoteUsers: new Map(),
    initFromDraft: vi.fn(),
    toStructuredAnswer: () => ({ answers: [] }),
  }),
}));
vi.mock('@/components/discussion', () => ({ DiscussButton: () => null }));
vi.mock('@/components/CollaborativeTextarea', () => ({ CollaborativeTextarea: () => null }));

const question: Question = {
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
        question={question}
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
        question={question}
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
    expect(setSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Use server sessions'));
    expect(setSelection).toHaveBeenCalledWith(0, [1]);
  });
});
