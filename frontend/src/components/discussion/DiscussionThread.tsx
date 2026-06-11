import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { groupMessages } from '@/lib/discussion';
import type { DiscussionMessage } from '@/services/discussions';
import type { PendingMessage } from '@/hooks/useDiscussion';
import { MessageBubble } from './MessageBubble';

// DiscussionThread (plan §9): grouped message blocks with load-older at the
// top, the first-unread divider, and component-local pending/failed bubbles
// at the bottom. The bottom sentinel doubles as the visible-read trigger —
// the IntersectionObserver lets the sheet advance the read cursor only when
// the newest message is ACTUALLY on screen (opening the sheet off-screen
// must not clear unread state).

interface Props {
  messages: DiscussionMessage[];
  pending: PendingMessage[];
  currentUserId: string;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (id: string) => void;
  typingUsers: string[];
  /** Message index the first-unread divider sits before (null = no divider). */
  dividerIndex?: number | null;
  canRedact?: boolean;
  onRedact?: (messageId: string) => void;
  /** Fires while the bottom of the thread is visible in the viewport. */
  onBottomVisible?: () => void;
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
  dividerIndex = null,
  canRedact,
  onRedact,
  onBottomVisible,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const didInitialScrollRef = useRef(false);
  const onBottomVisibleRef = useRef(onBottomVisible);
  onBottomVisibleRef.current = onBottomVisible;

  // Initial position: the first-unread divider when present, else the bottom.
  useEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) return;
    didInitialScrollRef.current = true;
    if (dividerRef.current) {
      dividerRef.current.scrollIntoView({ block: 'center' });
    } else {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  // Follow new messages when already near the bottom (or own sends).
  useEffect(() => {
    const last = messages[messages.length - 1]?.id || null;
    const changed = last !== lastMessageIdRef.current;
    lastMessageIdRef.current = last;
    if (!didInitialScrollRef.current) return;
    if (!changed && pending.length === 0) return;
    const container = containerRef.current?.parentElement;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
    if (nearBottom || pending.length > 0) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, pending]);

  // Visible-read trigger (plan §9): IntersectionObserver on the bottom
  // sentinel AND document.visibilityState — both checked by the sheet.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || !onBottomVisibleRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onBottomVisibleRef.current?.();
      },
      { threshold: 0.9 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages.length]);

  const read = dividerIndex !== null ? messages.slice(0, dividerIndex) : messages;
  const unread = dividerIndex !== null ? messages.slice(dividerIndex) : [];

  const renderGroups = (msgs: DiscussionMessage[]) =>
    groupMessages(msgs).map((group) => (
      <MessageBubble
        key={group.messages[0].id}
        group={group}
        currentUserId={currentUserId}
        canRedact={canRedact}
        onRedact={onRedact}
      />
    ));

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

      {messages.length === 0 && pending.length === 0 && (
        <p className="text-center text-xs text-muted-foreground py-8">
          No messages yet — start the discussion.
        </p>
      )}

      {renderGroups(read)}

      {unread.length > 0 && (
        <div ref={dividerRef} className="flex items-center gap-2 px-3 py-1.5">
          <div className="h-px flex-1 bg-destructive/40" />
          <span className="text-[10px] font-medium text-destructive/80 uppercase">New</span>
          <div className="h-px flex-1 bg-destructive/40" />
        </div>
      )}

      {renderGroups(unread)}

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

      <div ref={bottomRef} className="h-px" />
    </div>
  );
}
