import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDiscussion } from '@/hooks/useDiscussion';
import type { Discussion } from '@/services/discussions';
import { generateColor } from '@/utils/colors';
import { DiscussionThread } from './DiscussionThread';
import { DiscussionInput } from './DiscussionInput';

// DiscussionSheet (plan §9): right-side sheet (~480px) — header with anchor
// badge + title + presence dots, scrollable thread with load-older, input
// footer. Resolve controls, unread divider and the assist menu land in later
// PRs.

const ENTITY_LABELS: Record<string, string> = {
  sprint: 'Sprint',
  inception: 'Inception',
  question: 'Question',
  requirement: 'Requirement',
  userstory: 'User Story',
  task: 'Task',
  review: 'Review',
  generalinfo: 'General Info',
};

interface Props {
  open: boolean;
  loading: boolean;
  error: string | null;
  discussion: Discussion | null;
  fallbackTitle: string;
  sprintId: string;
  onClose: () => void;
}

export function DiscussionSheet({
  open,
  loading,
  error,
  discussion,
  fallbackTitle,
  sprintId,
  onClose,
}: Props) {
  const { user } = useAuth();
  const currentUser = {
    id: user?.username || '',
    name: user?.displayName || user?.email || '',
  };

  const {
    messages,
    pending,
    synced,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    sendMessage,
    retryMessage,
    setTyping,
    typingUsers,
    remoteUsers,
  } = useDiscussion({
    sprintId,
    discussionId: discussion?.id || null,
    open,
    user: currentUser,
  });

  const title = discussion?.entityTitle || fallbackTitle || 'Discussion';

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] p-0 flex flex-col gap-0">
        <SheetHeader className="border-b px-4 py-3 space-y-1 text-left">
          <div className="flex items-center gap-2 pr-6">
            {discussion && (
              <Badge variant="outline" className="text-[10px] shrink-0">
                {ENTITY_LABELS[discussion.entityType] || discussion.entityType}
              </Badge>
            )}
            <SheetTitle className="text-sm truncate flex-1">{title}</SheetTitle>
            {/* Presence dots — who else has this thread open. */}
            <div className="flex -space-x-1 shrink-0">
              {[...remoteUsers.values()].slice(0, 5).map((u, i) => (
                <div
                  key={`${u.name}-${i}`}
                  className="h-4 w-4 rounded-full ring-1 ring-background"
                  style={{ backgroundColor: u.color || generateColor(u.name) }}
                  title={u.name}
                />
              ))}
            </div>
          </div>
          <SheetDescription className="text-xs">
            {discussion?.status === 'resolved'
              ? `Resolved${discussion.resolvedByName ? ` by ${discussion.resolvedByName}` : ''}`
              : 'Team discussion — messages are saved to the sprint graph.'}
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {error && !loading && (
          <div className="flex-1 flex items-center justify-center px-6">
            <p className="text-xs text-destructive text-center">{error}</p>
          </div>
        )}

        {discussion && !loading && !error && (
          <>
            {discussion.status === 'resolved' && discussion.resolutionSummary && (
              <div className="border-b bg-muted/50 px-4 py-2">
                <p className="text-[10px] font-medium text-muted-foreground uppercase">
                  Resolution
                </p>
                <p className="text-xs">{discussion.resolutionSummary}</p>
              </div>
            )}
            <ScrollArea className="flex-1 min-h-0">
              <DiscussionThread
                messages={messages}
                pending={pending}
                currentUserId={currentUser.id}
                hasMoreOlder={hasMoreOlder}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
                onRetry={retryMessage}
                typingUsers={typingUsers}
              />
            </ScrollArea>
            {!synced && (
              <p className="px-4 py-1 text-[10px] text-muted-foreground border-t">
                Connecting live sync…
              </p>
            )}
            <DiscussionInput onSend={sendMessage} onTyping={setTyping} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
