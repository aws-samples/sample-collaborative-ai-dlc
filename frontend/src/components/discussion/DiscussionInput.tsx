import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SendHorizontal, AtSign, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from '@/services/projects';
import { generateColor } from '@/utils/colors';
import { mentionedUserIds } from '@/lib/discussion';
import type { AssistCommand } from '@/services/discussions';

// DiscussionInput: auto-growing textarea, Enter = send,
// Shift+Enter = newline, typing awareness, and the @-mention combobox over
// project members. Mentions are validated server-side anyway
// (non-members stripped) — the combobox just makes them typeable.

interface Props {
  onSend: (content: string, mentions: string[]) => void;
  onAssist?: (command: AssistCommand, instructions?: string) => void;
  onTyping: (typing: boolean) => void;
  members: Member[];
  disabled?: boolean;
}

const memberLabel = (m: Member): string => m.email?.split('@')[0] || m.userId.slice(0, 8);
type MentionSuggestion = { kind: 'quorum' } | { kind: 'member'; member: Member };

const suggestionLabel = (s: MentionSuggestion): string =>
  s.kind === 'quorum' ? 'quorum' : memberLabel(s.member);

const suggestionKey = (s: MentionSuggestion): string =>
  s.kind === 'quorum' ? 'quorum' : s.member.userId;

const suggestionRole = (s: MentionSuggestion): string =>
  s.kind === 'quorum' ? 'AI' : s.member.role;

const slashCommand = (text: string): { command: AssistCommand; instructions: string } | null => {
  const match = /^\/(summarize|explain|brainstorm|ask)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { command: match[1].toLowerCase() as AssistCommand, instructions: match[2]?.trim() || '' };
};

const quorumMention = (text: string): string | null => {
  const match = /^@quorum(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return match[1]?.trim() || '';
};

export function DiscussionInput({ onSend, onAssist, onTyping, members, disabled }: Props) {
  const [value, setValue] = useState('');
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map()); // userId → label
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const quorum: MentionSuggestion[] =
      onAssist && 'quorum'.includes(q) ? [{ kind: 'quorum' }] : [];
    const memberSuggestions: MentionSuggestion[] = members
      .filter((m) => memberLabel(m).toLowerCase().includes(q) || m.userId.toLowerCase().includes(q))
      .map((member) => ({ kind: 'member', member }));
    return [...quorum, ...memberSuggestions].slice(0, 6);
  }, [mentionQuery, members, onAssist]);

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
    (suggestion: MentionSuggestion) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const upToCaret = value.slice(0, caret);
      const match = /(^|\s)@([\w.+-]*)$/.exec(upToCaret);
      if (!match) return;
      const label = suggestionLabel(suggestion);
      const start = upToCaret.length - match[2].length - 1; // position of '@'
      const next = `${value.slice(0, start)}@${label} ${value.slice(caret)}`;
      setValue(next);
      if (suggestion.kind === 'member') {
        setMentioned((prev) => new Map(prev).set(suggestion.member.userId, label));
      }
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
    const assist = slashCommand(trimmed);
    if (assist && onAssist) {
      onAssist(assist.command, assist.instructions);
      onTyping(false);
      setValue('');
      setMentioned(new Map());
      setMentionQuery(null);
      requestAnimationFrame(autoGrow);
      return;
    }
    const quorumAsk = onAssist ? quorumMention(trimmed) : null;
    if (quorumAsk !== null && onAssist) {
      onAssist('ask', quorumAsk);
      onTyping(false);
      setValue('');
      setMentioned(new Map());
      setMentionQuery(null);
      requestAnimationFrame(autoGrow);
      return;
    }
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
  }, [value, disabled, mentioned, onSend, onAssist, onTyping, autoGrow]);

  return (
    <div className="relative border-t">
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 w-64 rounded-md border bg-popover shadow-md z-10 py-1">
          <p className="px-2 py-0.5 text-[10px] text-muted-foreground flex items-center gap-1">
            <AtSign className="h-2.5 w-2.5" /> Mention a member
          </p>
          {suggestions.map((suggestion, i) => (
            <button
              key={suggestionKey(suggestion)}
              type="button"
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1 text-xs text-left hover:bg-muted',
                i === highlight && 'bg-muted',
              )}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(suggestion);
              }}
            >
              {suggestion.kind === 'quorum' ? (
                <span className="h-4 w-4 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="h-2.5 w-2.5 text-primary" />
                </span>
              ) : (
                <span
                  className="h-4 w-4 rounded-full flex items-center justify-center text-[9px] font-semibold text-white shrink-0"
                  style={{ backgroundColor: generateColor(suggestion.member.userId) }}
                >
                  {suggestionLabel(suggestion).slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="truncate">{suggestionLabel(suggestion)}</span>
              <span className="ml-auto text-[9px] text-muted-foreground">
                {suggestionRole(suggestion)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder="Write a message..."
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
