import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { useEffect, useId, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useCollaborativeStructuredAnswer,
  type CollabScope,
} from '../hooks/useCollaborativeStructuredAnswer';
import type { YjsConnection } from '../hooks/useYjsDocument';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import { CollaborationStatusAlert } from '@/components/collab/CollaborationStatusAlert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DiscussButton } from '@/components/discussion';
import {
  ArtifactMarkdown,
  PreviewReferenceText,
  type MarkdownArtifactLink,
  type MarkdownDerivedItemLink,
  type OpenArtifact,
} from '@/components/intent/ArtifactMarkdown';
import type {
  Question,
  StructuredQuestion,
  StructuredAnswer,
  QuestionOption,
} from '../services/questions';

/**
 * The artifacts and derived items a question may mention. When given, matching
 * references in the question and its options link to their previews.
 */
export interface QuestionReferences {
  artifacts: MarkdownArtifactLink[];
  derivedItems: MarkdownDerivedItemLink[];
  onOpenArtifact: OpenArtifact;
  onOpenItem: (itemId: string) => void;
}

interface Props {
  canEdit?: boolean;
  canSubmit?: boolean;
  question: Question;
  references?: QuestionReferences;
  scope: CollabScope;
  userName: string;
  onAnswer: (structuredAnswer: StructuredAnswer) => Promise<void>;
  onAutoSave?: (draftAnswer: StructuredAnswer) => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Rendered inside the card, between the questions and the submit bar. */
  extra?: React.ReactNode;
  /**
   * A parent that owns the live-collaboration state (one alert for several
   * editors) passes it here; otherwise the editor reads its own document.
   */
  connection?: YjsConnection;
  onRetry?: () => void;
  hideConnectionAlert?: boolean;
}

export default function QuestionEditor({
  question,
  references,
  scope,
  userName,
  onAnswer,
  onAutoSave,
  canEdit = true,
  canSubmit = true,
  onFocus,
  onBlur,
  extra,
  connection: connectionProp,
  onRetry,
  hideConnectionAlert = false,
}: Props) {
  const { readOnly } = useSpacePermissions();
  const {
    doc,
    selections,
    freeTexts,
    setSelection,
    setFreeText,
    getFreeText,
    addContributor,
    synced,
    connection: ownConnection,
    retryNow,
    awareness,
    remoteUsers,
    documentReadOnly,
    initFromDraft,
    toStructuredAnswer,
  } = useCollaborativeStructuredAnswer(
    scope,
    question.id,
    question.questions.length,
    userName,
    readOnly || !canEdit ? undefined : onAutoSave,
  );
  const connection = connectionProp ?? ownConnection;
  const retry = onRetry ?? retryNow;
  // Selections live in the shared Yjs document: nothing can be chosen or
  // submitted before its first sync. The alert above explains the lock.
  const locked = !synced;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupName = useId();

  const seededDoc = useRef<typeof doc | null>(null);
  useEffect(() => {
    if (!synced || !canEdit || readOnly || documentReadOnly) return;
    if (!question.draftAnswer || seededDoc.current === doc) return;
    initFromDraft(question.draftAnswer);
    seededDoc.current = doc;
  }, [synced, canEdit, readOnly, documentReadOnly, question.draftAnswer, doc, initFromDraft]);

  const handleSubmit = async () => {
    if (documentReadOnly || readOnly || !canSubmit || submitting) return;
    const answer = toStructuredAnswer();
    const allAnswered = answer.answers.every(
      (a) => a.selectedOptions.length > 0 || (a.freeText && a.freeText.trim().length > 0),
    );
    if (!allAnswered) return;

    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit answer');
      setSubmitting(false);
    }
  };

  const total = question.questions.length;
  const answeredCount = question.questions.filter((_, i) => {
    const sel = selections.get(i) || [];
    const ft = freeTexts.get(i) || '';
    return sel.length > 0 || ft.trim().length > 0;
  }).length;
  const allAnswered = answeredCount === total;

  const remoteCount = remoteUsers.size;
  const blocked = documentReadOnly || readOnly || submitting || locked;

  return (
    <div
      data-slot="question-editor"
      className="rounded-lg border border-agent-waiting/40 bg-agent-waiting/5 p-3"
    >
      {!hideConnectionAlert && (
        <CollaborationStatusAlert
          connection={connection}
          onRetry={retry}
          context="answers"
          className="mb-3"
        />
      )}

      {remoteCount > 0 && (
        <div className="mb-3 flex items-center gap-1">
          {Array.from(remoteUsers.values()).map((u, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full text-2xs font-medium text-white"
              style={{ backgroundColor: u.color }}
            >
              {u.name?.charAt(0)}
            </span>
          ))}
          <span className="text-xs text-primary">
            {remoteCount === 1 ? '1 person is' : `${remoteCount} people are`} answering with you
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <div className="space-y-3">
        {question.questions.map((q, qIdx) => (
          <StructuredQuestionBlock
            key={qIdx}
            question={q}
            references={references}
            questionIndex={qIdx}
            totalQuestions={total}
            groupName={`${groupName}-${qIdx}`}
            selectedOptions={selections.get(qIdx) || []}
            freeText={freeTexts.get(qIdx) || ''}
            freeTextDoc={getFreeText(qIdx)}
            awareness={awareness}
            onSelectionChange={(indices) => setSelection(qIdx, indices)}
            onFreeTextChange={(text, cursor) => setFreeText(qIdx, text, cursor)}
            disabled={blocked || !canEdit}
            onFocus={() => {
              addContributor();
              onFocus?.();
            }}
            onBlur={onBlur}
            trailing={
              qIdx === 0 ? (
                <DiscussButton
                  entityType="question"
                  entityId={question.id}
                  entityTitle={question.questions[0]?.text || `${question.agent} agent question`}
                />
              ) : undefined
            }
          />
        ))}
      </div>

      {extra && <div className="mt-3">{extra}</div>}

      {/* `-bottom-6` matches the page scroller's `pb-6` (AppShell): sticky
          offsets are measured from the scroller's content box, so `bottom-0`
          would float the bar 24 px above the edge with text showing below it. */}
      <div
        data-slot="question-editor-submit-bar"
        className="sticky -bottom-6 z-10 -mx-3 -mb-3 mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-b-lg border-t border-agent-waiting/30 bg-card px-3 py-2"
      >
        {total > 1 ? (
          <span role="status" className="text-xs tabular-nums text-muted-foreground">
            {answeredCount} of {total} answered
          </span>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!allAnswered || blocked || !canSubmit}
          loading={submitting}
        >
          {submitting ? 'Submitting…' : total > 1 ? 'Submit all answers' : 'Submit answer'}
        </Button>
      </div>
    </div>
  );
}

function QuestionMarkdown({
  content,
  references,
}: {
  content: string;
  references?: QuestionReferences;
}) {
  if (!references) return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
  return <ArtifactMarkdown content={content} {...references} preserveReferenceText />;
}

function QuestionOptionText({
  text,
  references,
}: {
  text: string;
  references?: QuestionReferences;
}) {
  if (!references) return <>{text}</>;
  // Links sit inside the option's clickable row, so a link click must not select it.
  return (
    <PreviewReferenceText
      text={text}
      {...references}
      preserveReferenceText
      stopLinkPropagation
      linkClassName="text-primary underline underline-offset-2 hover:text-primary/80"
    />
  );
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLeadingBlock(text: string): [string, string | null] {
  const idx = text.indexOf('\n\n');
  if (idx === -1) return [text, null];
  return [text.slice(0, idx), text.slice(idx + 2).trim() || null];
}

/**
 * An agent-provided option that should behave like our free-text "Other":
 * selecting it reveals an inline textarea, and it suppresses our own injected
 * "Other (free text)" block so the two don't double up. Covers explicit
 * review actions ("request changes") and catch-all options the agent writes
 * itself ("Other", "Other (please describe)", "please specify", ...).
 */
function requiresFreeTextOption(opt: QuestionOption): boolean {
  const l = `${opt.label} ${opt.description ?? ''}`.toLowerCase();
  return (
    l.includes('request changes') ||
    /(^|[^a-z])other([^a-z]|$)/.test(l) ||
    l.includes('please describe') ||
    l.includes('please specify')
  );
}

function OptionIndicator({ single, checked }: { single: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-4 w-4 items-center justify-center border-2',
        single ? 'rounded-full' : 'rounded',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/40',
      )}
    >
      {checked &&
        (single ? (
          <span className="h-2 w-2 rounded-full bg-white" />
        ) : (
          <svg
            className="h-2.5 w-2.5 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ))}
    </span>
  );
}

const optionRowClass = (selected: boolean, disabled?: boolean) =>
  cn(
    'flex cursor-pointer items-start gap-2 rounded-md border p-2 transition-colors',
    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1',
    selected
      ? 'border-primary/30 bg-primary/10'
      : 'border-border bg-card hover:border-foreground/20 hover:bg-accent/50',
    disabled && 'cursor-not-allowed opacity-50',
  );

/** Renders a single structured question with options + free text */
function StructuredQuestionBlock({
  question,
  references,
  questionIndex,
  totalQuestions,
  groupName,
  selectedOptions,
  freeText,
  freeTextDoc,
  awareness,
  onSelectionChange,
  onFreeTextChange,
  disabled,
  onFocus,
  onBlur,
  trailing,
}: {
  question: StructuredQuestion;
  references?: QuestionReferences;
  questionIndex: number;
  totalQuestions: number;
  groupName: string;
  selectedOptions: number[];
  freeText: string;
  freeTextDoc: import('yjs').Text;
  awareness: import('y-protocols/awareness').Awareness;
  onSelectionChange: (indices: number[]) => void;
  onFreeTextChange: (text: string, cursorPos?: number) => void;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Extra control (discuss button) rendered on the title row, right-aligned. */
  trailing?: React.ReactNode;
}) {
  const isSingle = question.type === 'single';
  const [otherOpen, setOtherOpen] = useState(freeText.length > 0);
  const itemized = totalQuestions > 1;
  // Title row = the markdown's leading block; the rest renders full-width so
  // body paragraphs stay left-aligned with the option rows below.
  const [titleMd, bodyMd] = splitLeadingBlock(question.text);
  const answerLabel = `Answer for: ${plainText(titleMd)}`;

  useEffect(() => {
    if (freeText.length > 0) setOtherOpen(true);
  }, [freeText]);

  const isOtherActive = otherOpen || freeText.length > 0;

  const handleOptionToggle = useCallback(
    (optionIdx: number) => {
      if (disabled) return;
      if (isSingle) {
        onSelectionChange([optionIdx]);
        if (freeText) onFreeTextChange('');
        setOtherOpen(false);
      } else {
        const newSelection = selectedOptions.includes(optionIdx)
          ? selectedOptions.filter((i) => i !== optionIdx)
          : [...selectedOptions, optionIdx];
        onSelectionChange(newSelection);
      }
    },
    [disabled, isSingle, selectedOptions, freeText, onSelectionChange, onFreeTextChange],
  );

  const handleOtherToggle = useCallback(() => {
    if (disabled) return;
    if (isSingle) {
      onSelectionChange([]);
      setOtherOpen(true);
    } else {
      if (otherOpen) {
        onFreeTextChange('');
        setOtherOpen(false);
      } else {
        setOtherOpen(true);
      }
    }
  }, [disabled, isSingle, otherOpen, onSelectionChange, onFreeTextChange]);

  const showTextarea = isOtherActive || (isSingle && selectedOptions.length === 0);
  const otherChecked = isSingle ? isOtherActive && selectedOptions.length === 0 : isOtherActive;
  const inputType = isSingle ? 'radio' : 'checkbox';

  return (
    <div
      data-slot="structured-question"
      className={cn('scroll-mb-24', itemized && 'rounded-md border bg-background/60 p-3')}
    >
      <div className="mb-2 space-y-2">
        <div className="flex items-center gap-2">
          {itemized && (
            <span className="inline-flex h-5 shrink-0 items-center rounded bg-primary/10 px-1.5 text-2xs font-semibold text-primary">
              Q{questionIndex + 1}
              <span className="ml-1 font-normal text-muted-foreground-on-tint">
                / {totalQuestions}
              </span>
            </span>
          )}
          <div className="prose prose-sm min-w-0 flex-1 max-w-none text-sm text-foreground dark:prose-invert">
            <QuestionMarkdown content={titleMd} references={references} />
          </div>
          {trailing && <div className="shrink-0">{trailing}</div>}
        </div>
        {bodyMd && (
          <div className="prose prose-sm max-w-none text-sm text-foreground dark:prose-invert">
            <QuestionMarkdown content={bodyMd} references={references} />
          </div>
        )}
      </div>

      {question.type === 'multi' && (
        <p className="mb-1 text-xs text-muted-foreground">Select all that apply</p>
      )}

      <div className="mb-2 space-y-1.5">
        {question.options.map((opt, optIdx) => {
          const isSelected = selectedOptions.includes(optIdx);
          const requiresFreeText = requiresFreeTextOption(opt);
          return (
            <div key={optIdx}>
              <label className={optionRowClass(isSelected, disabled)}>
                <input
                  type={inputType}
                  name={groupName}
                  className="sr-only"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => handleOptionToggle(optIdx)}
                />
                <span className="mt-0.5 flex-shrink-0">
                  <OptionIndicator single={isSingle} checked={isSelected} />
                </span>
                <span className="text-sm">
                  <span className="font-medium text-foreground">
                    <QuestionOptionText text={opt.label} references={references} />
                  </span>
                  {opt.description && (
                    <span
                      className={cn(
                        'ml-1',
                        isSelected ? 'text-muted-foreground-on-tint' : 'text-muted-foreground',
                      )}
                    >
                      &mdash; <QuestionOptionText text={opt.description} references={references} />
                    </span>
                  )}
                </span>
              </label>
              {isSelected && requiresFreeText && (
                <div className="mt-1.5 ml-6 mr-2">
                  <CollaborativeTextarea
                    yText={freeTextDoc}
                    awareness={awareness}
                    value={freeText}
                    aria-label={answerLabel}
                    placeholder={
                      opt.label.toLowerCase().includes('request changes')
                        ? 'Describe what needs to change...'
                        : 'Type your answer...'
                    }
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    rows={2}
                    disabled={disabled}
                    onFocus={onFocus}
                    onBlur={onBlur}
                  />
                </div>
              )}
            </div>
          );
        })}

        {/* App-injected "Other (free text)" — only when the agent hasn't
            supplied its own free-text-style option (handled inline above). */}
        {!question.options.some((opt) => requiresFreeTextOption(opt)) && (
          <div
            className={cn(
              'rounded-md border p-2 transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1',
              isOtherActive ? 'border-primary/30 bg-primary/10' : 'border-border bg-card',
            )}
          >
            <label
              className={cn(
                'flex cursor-pointer items-start gap-2',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type={inputType}
                name={groupName}
                className="sr-only"
                checked={otherChecked}
                disabled={disabled}
                onChange={handleOtherToggle}
              />
              <span className="mt-0.5 flex-shrink-0">
                <OptionIndicator single={isSingle} checked={otherChecked} />
              </span>
              <span
                className={cn(
                  'text-sm font-medium',
                  isOtherActive ? 'text-muted-foreground-on-tint' : 'text-muted-foreground',
                )}
              >
                Other (free text)
              </span>
            </label>
            {showTextarea && (
              <div className="mt-1.5 ml-6">
                <CollaborativeTextarea
                  yText={freeTextDoc}
                  awareness={awareness}
                  value={freeText}
                  aria-label={answerLabel}
                  placeholder="Type your answer..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                  rows={2}
                  disabled={disabled}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
