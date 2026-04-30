import { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCollaborativeStructuredAnswer } from '../hooks/useCollaborativeStructuredAnswer';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import type { Question, StructuredQuestion, StructuredAnswer } from '../services/questions';

interface Props {
  question: Question;
  sprintId: string;
  userName: string;
  onAnswer: (structuredAnswer: StructuredAnswer) => Promise<void>;
  onAutoSave?: (draftAnswer: StructuredAnswer) => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
}

export default function QuestionEditor({ question, sprintId, userName, onAnswer, onAutoSave, onFocus, onBlur }: Props) {
  const {
    selections,
    freeTexts,
    setSelection,
    setFreeText,
    synced,
    remoteUsers,
    setCursor,
    initFromDraft,
    toStructuredAnswer,
  } = useCollaborativeStructuredAnswer(
    sprintId, question.id, question.questions.length, userName, onAutoSave,
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (synced && question.draftAnswer) {
      initFromDraft(question.draftAnswer);
    }
  }, [synced]);

  const handleSubmit = async () => {
    if (submitting) return;
    const answer = toStructuredAnswer();
    const allAnswered = answer.answers.every(a =>
      a.selectedOptions.length > 0 || (a.freeText && a.freeText.trim().length > 0)
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

  const allAnswered = question.questions.every((_, i) => {
    const sel = selections.get(i) || [];
    const ft = freeTexts.get(i) || '';
    return sel.length > 0 || ft.trim().length > 0;
  });

  const remoteCount = remoteUsers.size;

  return (
    <div className="rounded-lg border border-agent-waiting/40 bg-agent-waiting/5 p-3">
      <p className="text-xs text-muted-foreground mb-1">{question.agent} agent</p>

      {remoteCount > 0 && (
        <div className="flex items-center gap-1 mb-3">
          {Array.from(remoteUsers.values()).map((u, i) => (
            <div
              key={i}
              className="w-5 h-5 rounded-full text-white text-[10px] flex items-center justify-center"
              style={{ backgroundColor: u.color }}
            >
              {u.name?.charAt(0)}
            </div>
          ))}
          <span className="text-xs text-primary">collaborating...</span>
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-2 py-1 mb-3">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {question.questions.map((q, qIdx) => (
          <StructuredQuestionBlock
            key={qIdx}
            question={q}
            questionIndex={qIdx}
            totalQuestions={question.questions.length}
            selectedOptions={selections.get(qIdx) || []}
            freeText={freeTexts.get(qIdx) || ''}
            onSelectionChange={(indices) => setSelection(qIdx, indices)}
            onFreeTextChange={(text, cursor) => setFreeText(qIdx, text, cursor)}
            onCursorChange={setCursor}
            remoteUsers={remoteUsers}
            disabled={submitting}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        ))}
      </div>

      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={!allAnswered || submitting}
        className="mt-4 gap-1.5 bg-agent-success hover:bg-agent-success/90 text-white"
      >
        {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
        {submitting ? 'Submitting...' : question.questions.length > 1 ? 'Submit All Answers' : 'Submit Answer'}
      </Button>
    </div>
  );
}

/** Renders a single structured question with options + free text */
function StructuredQuestionBlock({
  question,
  questionIndex,
  totalQuestions,
  selectedOptions,
  freeText,
  onSelectionChange,
  onFreeTextChange,
  onCursorChange,
  remoteUsers,
  disabled,
  onFocus,
  onBlur,
}: {
  question: StructuredQuestion;
  questionIndex: number;
  totalQuestions: number;
  selectedOptions: number[];
  freeText: string;
  onSelectionChange: (indices: number[]) => void;
  onFreeTextChange: (text: string, cursorPos?: number) => void;
  onCursorChange: (index: number, length?: number) => void;
  remoteUsers: Map<number, import('../hooks/useYjsDocument').AwarenessUser>;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const isSingle = question.type === 'single';
  const [otherOpen, setOtherOpen] = useState(freeText.length > 0);

  useEffect(() => {
    if (freeText.length > 0) setOtherOpen(true);
  }, [freeText]);

  const isOtherActive = otherOpen || freeText.length > 0;

  const handleOptionToggle = useCallback((optionIdx: number) => {
    if (disabled) return;
    if (isSingle) {
      onSelectionChange([optionIdx]);
      if (freeText) onFreeTextChange('');
      setOtherOpen(false);
    } else {
      const newSelection = selectedOptions.includes(optionIdx)
        ? selectedOptions.filter(i => i !== optionIdx)
        : [...selectedOptions, optionIdx];
      onSelectionChange(newSelection);
    }
  }, [disabled, isSingle, selectedOptions, freeText, onSelectionChange, onFreeTextChange]);

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

  return (
    <div className="border-l-2 border-primary/30 pl-3">
      <div className="text-sm text-foreground mb-2 prose prose-sm dark:prose-invert max-w-none">
        {totalQuestions > 1 && (
          <span className="font-semibold text-primary mr-1">Q{questionIndex + 1}.</span>
        )}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{question.text}</ReactMarkdown>
      </div>

      {question.type === 'multi' && (
        <p className="text-xs text-muted-foreground mb-1">Select all that apply</p>
      )}

      <div className="space-y-1.5 mb-2">
        {question.options.map((opt, optIdx) => {
          const isSelected = selectedOptions.includes(optIdx);
          const requiresFreeText = opt.label.toLowerCase().includes('request changes');
          return (
            <div key={optIdx}>
            <label
              className={cn(
                'flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors',
                isSelected
                  ? 'bg-primary/10 border-primary/30'
                  : 'bg-card border-border hover:border-foreground/20 hover:bg-accent/50',
                disabled && 'opacity-50 cursor-not-allowed',
              )}
              onClick={() => handleOptionToggle(optIdx)}
            >
              <span className="mt-0.5 flex-shrink-0">
                {isSingle ? (
                  <span
                    className={cn(
                      'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                      isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                    )}
                  >
                    {isSelected && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'w-4 h-4 rounded border-2 flex items-center justify-center',
                      isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                    )}
                  >
                    {isSelected && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                )}
              </span>
              <span className="text-sm">
                <span className="font-medium text-foreground">{opt.label}</span>
                {opt.description && (
                  <span className="text-muted-foreground ml-1">&mdash; {opt.description}</span>
                )}
              </span>
            </label>
            {isSelected && requiresFreeText && (
              <div className="mt-1.5 ml-6 mr-2">
                <CollaborativeTextarea
                  value={freeText}
                  onChange={(val, cursor) => onFreeTextChange(val, cursor)}
                  onCursorChange={onCursorChange}
                  remoteUsers={remoteUsers}
                  placeholder="Describe what needs to change..."
                  className="w-full px-2 py-1 border border-border rounded-md text-sm bg-background"
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

        {/* "Other" free text option - only show if no "Request changes" option exists */}
        {!question.options.some(opt => opt.label.toLowerCase().includes('request changes')) && (
        <div
          className={cn(
            'p-2 rounded-md border transition-colors',
            isOtherActive
              ? 'bg-primary/10 border-primary/30'
              : 'bg-card border-border',
          )}
        >
          <label
            className="flex items-start gap-2 cursor-pointer"
            onClick={handleOtherToggle}
          >
            <span className="mt-0.5 flex-shrink-0">
              {isSingle ? (
                <span
                  className={cn(
                    'w-4 h-4 rounded-full border-2 flex items-center justify-center',
                    isOtherActive && selectedOptions.length === 0
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/30',
                  )}
                >
                  {isOtherActive && selectedOptions.length === 0 && (
                    <span className="w-2 h-2 rounded-full bg-white" />
                  )}
                </span>
              ) : (
                <span
                  className={cn(
                    'w-4 h-4 rounded border-2 flex items-center justify-center',
                    isOtherActive ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                  )}
                >
                  {isOtherActive && (
                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
              )}
            </span>
            <span className="text-sm font-medium text-muted-foreground">Other (free text)</span>
          </label>
          {showTextarea && (
            <div className="mt-1.5 ml-6">
              <CollaborativeTextarea
                value={freeText}
                onChange={(val, cursor) => {
                  onFreeTextChange(val, cursor);
                  if (isSingle && val.length > 0 && selectedOptions.length > 0) {
                    onSelectionChange([]);
                  }
                }}
                onCursorChange={onCursorChange}
                remoteUsers={remoteUsers}
                placeholder="Type your answer..."
                className="w-full px-2 py-1 border border-border rounded-md text-sm bg-background"
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
