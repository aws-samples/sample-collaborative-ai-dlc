import { Button } from '@/components/ui/button';
import { AtSign, X } from 'lucide-react';

// MentionToasts (plan §9, D7): lightweight in-app notification stack for
// discussion.mention events — online users only; offline/email delivery is a
// named v2 item. No toast library exists in the codebase, so this is a small
// self-contained fixed-position stack.

export interface MentionToast {
  id: string;
  discussionId: string;
  byName: string;
  excerpt: string;
}

interface Props {
  toasts: MentionToast[];
  onOpen: (discussionId: string) => void;
  onDismiss: (id: string) => void;
}

export function MentionToasts({ toasts, onOpen, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border bg-background shadow-lg p-3 flex gap-2 items-start animate-in slide-in-from-bottom-2"
        >
          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <AtSign className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">{t.byName} mentioned you</p>
            {t.excerpt && (
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{t.excerpt}</p>
            )}
            <Button
              variant="link"
              size="sm"
              className="h-5 px-0 text-xs"
              onClick={() => {
                onOpen(t.discussionId);
                onDismiss(t.id);
              }}
            >
              Jump to thread
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
