import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SendHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

// DiscussionInput (plan §9): auto-growing textarea, Enter = send,
// Shift+Enter = newline, typing awareness while composing. The mention
// combobox and the assist (Sparkles) menu land in later PRs.

interface Props {
  onSend: (content: string) => void;
  onTyping: (typing: boolean) => void;
  disabled?: boolean;
}

export function DiscussionInput({ onSend, onTyping, disabled }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    onTyping(false);
    setValue('');
    requestAnimationFrame(autoGrow);
  }, [value, disabled, onSend, onTyping, autoGrow]);

  return (
    <div className="flex items-end gap-2 border-t p-3">
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder="Write a message… (Enter to send, Shift+Enter for newline)"
        className={cn(
          'flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:opacity-50 max-h-40',
        )}
        onChange={(e) => {
          setValue(e.target.value);
          onTyping(e.target.value.length > 0);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onBlur={() => onTyping(false)}
      />
      <Button
        size="icon"
        className="h-9 w-9 shrink-0"
        onClick={send}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
