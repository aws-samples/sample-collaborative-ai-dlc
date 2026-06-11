import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { groupMessages } from '@/lib/discussion';
import type { DiscussionMessage } from '@/services/discussions';
import type { PendingMessage } from '@/hooks/useDiscussion';
import { MessageBubble } from './MessageBubble';

// DiscussionThread (plan §9): grouped message blocks with load-older at the
// top and component-local pending/failed bubbles at the bottom. Auto-scrolls
// to the newest message when it is already near the bottom.

interface Props {
  messages: DiscussionMessage[];
  pending: PendingMessage[];
  currentUserId: string;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (id: string) => void;
  typingUsers: string[];
}

export function DiscussionThread({
  messages,
  pending,
  currentUserId,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  typingUsers,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    const last = messages[messages.length - 1]?.id || null;
    const changed = last !== lastMessageIdRef.current;
    lastMessageIdRef.current = last;
    if (!changed && pending.length === 0) return;
    const container = containerRef.current?.parentElement;
    if (!container) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      return;
    }
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
    if (nearBottom || pending.length > 0) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, pending]);

  const groups = groupMessages(messages);

  return (
    <div ref={containerRef} className="py-2">
      {hasMoreOlder && (
        <div className="flex justify-center py-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-muted-foreground"
            onClick={onLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Load older messages
          </Button>
        </div>
      )}

      {groups.length === 0 && pending.length === 0 && (
        <p className="text-center text-xs text-muted-foreground py-8">
          No messages yet — start the discussion.
        </p>
      )}

      {groups.map((group) => (
        <MessageBubble key={group.messages[0].id} group={group} currentUserId={currentUserId} />
      ))}

      {pending.map((p) => (
        <div key={p.id} className="flex gap-2 px-3 py-1.5 opacity-70">
          <div className="h-6 w-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm whitespace-pre-wrap break-words">{p.content}</div>
            {p.status === 'sending' ? (
              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> sending…
              </span>
            ) : (
              <button
                type="button"
                className="text-[10px] text-destructive inline-flex items-center gap-1 hover:underline"
                onClick={() => onRetry(p.id)}
              >
                <AlertCircle className="h-2.5 w-2.5" /> failed — retry
                <RotateCcw className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        </div>
      ))}

      {typingUsers.length > 0 && (
        <p className="px-3 pt-1 text-[10px] text-muted-foreground italic">
          {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing…
        </p>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
