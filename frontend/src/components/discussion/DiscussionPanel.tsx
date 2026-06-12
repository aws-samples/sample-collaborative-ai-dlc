import { useParams } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDiscussion } from '@/hooks/useDiscussion';
import { generateColor } from '@/utils/colors';
import { DiscussionThread } from './DiscussionThread';
import { DiscussionInput } from './DiscussionInput';
import { useDiscussions } from './DiscussionProvider';

// DiscussionPanel (plan §9): NON-modal thread view hosted inside the right
// ActivityPanel — no overlay, the rest of the app stays fully interactive
// while a discussion is open. Header with anchor badge + title + presence
// dots + close, scrollable thread with load-older, input footer. Resolve
// controls, unread divider and the assist menu land in later PRs.

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

export function DiscussionPanel() {
  const ctx = useDiscussions();
  const { sprintId = '' } = useParams<{ sprintId: string }>();
  const { user } = useAuth();
  const currentUser = {
    id: user?.username || '',
    name: user?.displayName || user?.email || '',
  };

  const discussion = ctx?.activeDiscussion ?? null;

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
    open: !!ctx?.isOpen,
    user: currentUser,
  });

  if (!ctx) return null;
  const { loading, error, fallbackTitle, close } = ctx;

  const title = discussion?.entityTitle || fallbackTitle || 'Discussion';

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          {discussion && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {ENTITY_LABELS[discussion.entityType] || discussion.entityType}
            </Badge>
          )}
          <h2 className="text-sm font-semibold truncate flex-1">{title}</h2>
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
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={close}
            aria-label="Close discussion"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {discussion?.status === 'resolved'
            ? `Resolved${discussion.resolvedByName ? ` by ${discussion.resolvedByName}` : ''}`
            : 'Team discussion — messages are saved to the sprint graph.'}
        </p>
      </div>

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
            <div className="border-b bg-muted/50 px-3 py-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase">Resolution</p>
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
            <p className="px-3 py-1 text-[10px] text-muted-foreground border-t">
              Connecting live sync…
            </p>
          )}
          <DiscussionInput onSend={sendMessage} onTyping={setTyping} />
        </>
      )}
    </div>
  );
}
