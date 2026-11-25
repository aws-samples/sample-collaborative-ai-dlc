import { fireEvent, render, screen } from '@/test/query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import QuestionEditor, { type QuestionReferences } from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';

const setSelection = vi.fn();
const initFromDraft = vi.fn();
const collaboration = { doc: new Y.Doc(), synced: true, documentReadOnly: false };
const access = vi.hoisted(() => ({ readOnly: false }));
vi.mock('@/contexts/SpacePermissionsContext', () => ({
  useSpacePermissions: () => access,
}));
const hookState = vi.hoisted(() => ({
  connection: 'synced' as 'connecting' | 'synced' | 'unavailable',
  retryNow: vi.fn(),
  selections: new Map<number, number[]>(),
  freeTexts: new Map<number, string>(),
}));

vi.mock('@/hooks/useCollaborativeStructuredAnswer', () => ({
  useCollaborativeStructuredAnswer: () => ({
    selections: hookState.selections,
    freeTexts: hookState.freeTexts,
    setSelection,
    setFreeText: vi.fn(),
    getFreeText: () => collaboration.doc.getText('t'),
    addContributor: vi.fn(),
    ...collaboration,
    synced: hookState.connection === 'synced',
    connection: hookState.connection,
    retryNow: hookState.retryNow,
    awareness: {},
    remoteUsers: new Map(),
    initFromDraft,
    toStructuredAnswer: () => ({ answers: [] }),
  }),
}));
vi.mock('@/components/discussion', () => ({ DiscussButton: () => null }));
vi.mock('@/components/CollaborativeTextarea', () => ({
  CollaborativeTextarea: ({
    'aria-label': ariaLabel,
    placeholder,
  }: {
    'aria-label'?: string;
    placeholder?: string;
  }) => <textarea readOnly aria-label={ariaLabel} placeholder={placeholder} />,
}));

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

describe('QuestionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.readOnly = false;
    collaboration.documentReadOnly = false;
    collaboration.synced = true;
  });

  it.each(['stage', 'document', 'space'] as const)(
    'restores the saved draft once when %s edit access arrives after sync',
    (permission) => {
      const draftAnswer = { answers: [{ selectedOptions: [1] }] };
      const props = {
        question: { ...question, draftAnswer },
        scope: { kind: 'intent' as const, id: 'i', projectId: 'p' },
        userName: 'u',
        onAnswer: vi.fn(),
      };
      collaboration.synced = false;
      collaboration.documentReadOnly = permission === 'document';
      access.readOnly = permission === 'space';
      const { rerender } = render(<QuestionEditor {...props} canEdit={permission !== 'stage'} />);
      collaboration.synced = true;
      rerender(<QuestionEditor {...props} canEdit={permission !== 'stage'} />);
      expect(initFromDraft).not.toHaveBeenCalled();

      collaboration.documentReadOnly = false;
      access.readOnly = false;
      rerender(<QuestionEditor {...props} canEdit />);
      expect(initFromDraft).toHaveBeenCalledExactlyOnceWith(draftAnswer);

      const updatedDraft = { answers: [{ selectedOptions: [0] }] };
      rerender(<QuestionEditor {...props} question={{ ...question, draftAnswer: updatedDraft }} />);
      expect(initFromDraft).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps questions readable while denying selection and submission for a Viewer', () => {
    access.readOnly = true;
    const onAnswer = vi.fn();
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByText('Use server sessions')).toBeVisible();
    fireEvent.click(screen.getByText('Use server sessions'));
    expect(setSelection).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

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
    expect(setSelection).not.toHaveBeenCalled();
  });
});

const multiQuestion: Question = {
  id: 'h5',
  agent: 'agent',
  sprintId: '',
  createdAt: '',
  questions: [
    { text: 'Where is history stored?', type: 'single', options: [{ label: 'A) Browser' }] },
    { text: 'Who is the user?', type: 'single', options: [{ label: 'A) Anonymous' }] },
    { text: 'What counts as viewed?', type: 'single', options: [{ label: 'A) PDP' }] },
  ],
};

describe('QuestionEditor progress and submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.connection = 'synced';
    hookState.selections = new Map();
    hookState.freeTexts = new Map();
  });

  it('shows how many questions are answered next to the submit button', () => {
    hookState.selections = new Map([[0, [0]]]);
    hookState.freeTexts = new Map([[2, 'dwell time']]);
    render(
      <QuestionEditor
        question={multiQuestion}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText('2 of 3 answered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit all answers' })).toBeDisabled();
  });

  it('enables submit once every question has an answer', () => {
    hookState.selections = new Map([
      [0, [0]],
      [1, [0]],
      [2, [0]],
    ]);
    render(
      <QuestionEditor
        question={multiQuestion}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByText('3 of 3 answered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit all answers' })).toBeEnabled();
  });

  it('renders the extra slot inside the card above the submit bar', () => {
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
        extra={<div data-testid="note-field" />}
      />,
    );

    const note = screen.getByTestId('note-field');
    const submit = screen.getByRole('button', { name: 'Submit answer' });
    expect(note.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.closest('[data-slot="question-editor"]')).toContainElement(submit);
  });

  it('paints the sticky submit bar opaque, flush with the page scroller, as the last child', () => {
    const { container } = render(
      <QuestionEditor
        question={multiQuestion}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    const editor = container.querySelector('[data-slot="question-editor"]')!;
    const bar = editor.querySelector('[data-slot="question-editor-submit-bar"]')!;
    expect(editor.lastElementChild).toBe(bar);
    expect(bar).toHaveClass('sticky', '-bottom-6', 'bg-card');
    expect(bar.className).not.toMatch(/bg-card\/|backdrop-blur/);
    for (const block of editor.querySelectorAll('[data-slot="structured-question"]')) {
      expect(block).toHaveClass('scroll-mb-24');
    }
    expect(editor.querySelectorAll('[data-slot="structured-question"]')).toHaveLength(3);
  });
});

describe('QuestionEditor when live collaboration is unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.connection = 'unavailable';
    hookState.selections = new Map();
    hookState.freeTexts = new Map();
  });

  it('explains why options are locked and offers a retry', () => {
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Live collaboration is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent("Answers can't be submitted");
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(hookState.retryNow).toHaveBeenCalledTimes(1);

    const option = screen.getByRole('radio', { name: /Use server sessions/ });
    expect(option).toBeDisabled();
    // One message: the alert. The submit bar does not repeat the lock reason.
    expect(screen.queryByText(/Options are locked/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
  });

  it('does not lock options while synced', () => {
    hookState.connection = 'synced';
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Use server sessions/ })).toBeEnabled();
  });

  it('lets a parent own the alert and still locks the options', () => {
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
        connection="unavailable"
        onRetry={vi.fn()}
        hideConnectionAlert
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Use server sessions/ })).toBeDisabled();
  });
});

describe('QuestionEditor option contrast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.connection = 'synced';
    hookState.selections = new Map([[0, [0]]]);
    hookState.freeTexts = new Map();
  });

  it('uses the on-tint secondary text token for the selected option rationale', () => {
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    const selectedRationale = screen.getByText(/No change to FR2\.4\./).closest('span');
    expect(selectedRationale?.className).toContain('text-muted-foreground-on-tint');
  });
});

describe('QuestionEditor free-text answer field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.connection = 'synced';
    hookState.selections = new Map();
    hookState.freeTexts = new Map();
  });

  it('names the "Other" answer field after its question instead of the placeholder', () => {
    hookState.freeTexts = new Map([[0, 'Use cookies']]);
    render(
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    const field = screen.getByRole('textbox', {
      name: 'Answer for: How should sessions be kept? FR2.4 and requirements apply.',
    });
    expect(field).toHaveAttribute('placeholder', 'Type your answer...');
  });

  it('names the answer field of an agent option that asks for free text', () => {
    hookState.selections = new Map([[0, [1]]]);
    render(
      <QuestionEditor
        question={{
          ...question,
          questions: [
            {
              text: '**Approve the design?**',
              type: 'single',
              options: [{ label: 'Approve' }, { label: 'Request changes' }],
            },
          ],
        }}
        scope={{ kind: 'intent', id: 'i', projectId: 'p' }}
        userName="u"
        onAnswer={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('textbox', { name: 'Answer for: Approve the design?' }),
    ).toHaveAttribute('placeholder', 'Describe what needs to change...');
  });
});
