import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SendHorizontal, AtSign, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from '@/services/projects';
import type { AssistCommand } from '@/services/discussions';
import { generateColor } from '@/utils/colors';
import { mentionedUserIds } from '@/lib/discussion';

// DiscussionInput: auto-growing textarea, Enter = send,
// Shift+Enter = newline, typing awareness, the @-mention combobox over
// project members, and the assist (Sparkles) menu with canned commands +
// free-form instruction. Mentions are validated server-side anyway
// (non-members stripped) — the combobox just makes them typeable.

interface Props {
  onSend: (content: string, mentions: string[]) => void;
  onTyping: (typing: boolean) => void;
  members: Member[];
  onAssist?: (command: AssistCommand, instruction?: string) => void;
  /** suggest-answer is advice-only and only offered on question-anchored threads. */
  canSuggestAnswer?: boolean;
  assistRunning?: boolean;
  disabled?: boolean;
}

const memberLabel = (m: Member): string => m.email?.split('@')[0] || m.userId.slice(0, 8);

const CANNED_COMMANDS: Array<{ command: AssistCommand; label: string; questionOnly?: boolean }> = [
  { command: 'suggest-answer', label: 'Suggest an answer', questionOnly: true },
  { command: 'summarize', label: 'Summarize discussion' },
  { command: 'explain', label: 'Explain in detail' },
];

export function DiscussionInput({
  onSend,
  onTyping,
  members,
  onAssist,
  canSuggestAnswer,
  assistRunning,
  disabled,
}: Props) {
  const [value, setValue] = useState('');
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map()); // userId → label
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistInstruction, setAssistInstruction] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const runAssist = useCallback(
    (command: AssistCommand, instruction?: string) => {
      onAssist?.(command, instruction);
      setAssistOpen(false);
      setAssistInstruction('');
    },
    [onAssist],
  );

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return members
      .filter((m) => memberLabel(m).toLowerCase().includes(q) || m.userId.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, members]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Clamp between the CSS min-h-10 (40px) and max-h-40 (160px); without the
    // lower bound the initial rows={1} box clips even the placeholder text.
    el.style.height = `${Math.max(Math.min(el.scrollHeight, 160), 40)}px`;
  }, []);

  // Apply the clamped height once on mount — otherwise the rows={1} box renders
  // a hair too short until the first keystroke triggers autoGrow.
  useEffect(autoGrow, [autoGrow]);

  // Detect an active "@token" immediately before the caret.
  const updateMentionQuery = useCallback((text: string, caret: number) => {
    const upToCaret = text.slice(0, caret);
    const match = /(^|\s)@([\w.+-]*)$/.exec(upToCaret);
    setMentionQuery(match ? match[2] : null);
    setHighlight(0);
  }, []);

  const insertMention = useCallback(
    (m: Member) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const upToCaret = value.slice(0, caret);
      const match = /(^|\s)@([\w.+-]*)$/.exec(upToCaret);
      if (!match) return;
      const label = memberLabel(m);
      const start = upToCaret.length - match[2].length - 1; // position of '@'
      const next = `${value.slice(0, start)}@${label} ${value.slice(caret)}`;
      setValue(next);
      setMentioned((prev) => new Map(prev).set(m.userId, label));
      setMentionQuery(null);
      requestAnimationFrame(() => {
        el?.focus();
        const pos = start + label.length + 2;
        el?.setSelectionRange(pos, pos);
        autoGrow();
      });
    },
    [value, autoGrow],
  );

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    // Only count mentions whose @label text survived editing — matched on a
    // token boundary so a prefix label (john) isn't falsely counted from a
    // longer one (@johnny).
    const mentions = mentionedUserIds(trimmed, mentioned);
    onSend(trimmed, mentions);
    onTyping(false);
    setValue('');
    setMentioned(new Map());
    setMentionQuery(null);
    requestAnimationFrame(autoGrow);
  }, [value, disabled, mentioned, onSend, onTyping, autoGrow]);

  return (
    <div className="relative border-t">
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 w-64 rounded-md border bg-popover shadow-md z-10 py-1">
          <p className="px-2 py-0.5 text-[10px] text-muted-foreground flex items-center gap-1">
            <AtSign className="h-2.5 w-2.5" /> Mention a member
          </p>
          {suggestions.map((m, i) => (
            <button
              key={m.userId}
              type="button"
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1 text-xs text-left hover:bg-muted',
                i === highlight && 'bg-muted',
              )}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m);
              }}
            >
              <span
                className="h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-semibold text-white shrink-0"
                style={{ backgroundColor: generateColor(m.userId) }}
              >
                {memberLabel(m).slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate">{memberLabel(m)}</span>
              <span className="ml-auto text-[9px] text-muted-foreground">{m.role}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-3">
        {onAssist && (
          <Popover open={assistOpen} onOpenChange={setAssistOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                disabled={disabled || assistRunning}
                aria-label="Ask the assistant"
              >
                {assistRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin text-phase-inception" />
                ) : (
                  <Sparkles className="h-4 w-4 text-phase-inception" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-72 p-2 space-y-1">
              <p className="text-[10px] text-muted-foreground px-1">
                Agent assist — replies in this thread (may take up to a minute to start)
              </p>
              {CANNED_COMMANDS.filter((c) => !c.questionOnly || canSuggestAnswer).map((c) => (
                <button
                  key={c.command}
                  type="button"
                  className="w-full text-left rounded px-2 py-1.5 text-xs hover:bg-muted"
                  onClick={() => runAssist(c.command)}
                >
                  {c.label}
                </button>
              ))}
              <div className="pt-1 border-t space-y-1">
                <textarea
                  rows={2}
                  value={assistInstruction}
                  onChange={(e) => setAssistInstruction(e.target.value)}
                  placeholder="Ask the assistant…"
                  className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && assistInstruction.trim()) {
                      e.preventDefault();
                      runAssist('custom', assistInstruction.trim());
                    }
                  }}
                />
                <Button
                  size="sm"
                  className="w-full h-7 text-xs"
                  disabled={!assistInstruction.trim()}
                  onClick={() => runAssist('custom', assistInstruction.trim())}
                >
                  <Sparkles className="h-3 w-3 mr-1" />
                  Ask
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder="Write a message… @ to mention (Enter to send, Shift+Enter for newline)"
          className={cn(
            'flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm leading-5',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:opacity-50 min-h-10 max-h-40',
          )}
          onChange={(e) => {
            setValue(e.target.value);
            onTyping(e.target.value.length > 0);
            updateMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
            autoGrow();
          }}
          onKeyDown={(e) => {
            // `/` in an empty input opens the assist menu.
            if (e.key === '/' && value === '' && onAssist) {
              e.preventDefault();
              setAssistOpen(true);
              return;
            }
            if (suggestions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => (h + 1) % suggestions.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(suggestions[highlight]);
                return;
              }
              if (e.key === 'Escape') {
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onBlur={() => {
            onTyping(false);
            // Delay so a click on a suggestion lands first (mousedown).
            setTimeout(() => setMentionQuery(null), 100);
          }}
        />
        <Button
          size="icon"
          className="h-10 w-10 shrink-0"
          onClick={send}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
        >
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
