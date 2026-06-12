import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDiscussions } from './DiscussionProvider';
import type { OpenDiscussionArgs } from './DiscussionProvider';

// DiscussButton: the entry-point affordance with a discussion-aware
// badge — count pill when unreadCount > 0, subtle dot when a thread exists
// with messages but nothing unread. Renders nothing when no
// DiscussionProvider is mounted (outside a sprint).

interface Props extends OpenDiscussionArgs {
  className?: string;
}

export function DiscussButton({ entityType, entityId, entityTitle, className }: Props) {
  const discussions = useDiscussions();
  if (!discussions) return null;

  const thread = discussions.discussionFor(entityType, entityId);
  const unread = thread?.unreadCount ?? 0;
  const ongoing = (thread?.messageCount ?? 0) > 0;

  const label =
    unread > 0 ? `Discuss (${unread} unread)` : ongoing ? 'Discuss (ongoing)' : 'Discuss';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6 relative', className)}
          onClick={(e) => {
            e.stopPropagation();
            discussions.openDiscussion({ entityType, entityId, entityTitle });
          }}
          aria-label={label}
        >
          <MessageSquare className={cn('h-3 w-3', (unread > 0 || ongoing) && 'text-primary')} />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[8px] font-semibold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : ongoing ? (
            <span className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-primary/60" />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {unread > 0 ? `Discuss — ${unread} unread` : ongoing ? 'Discuss — ongoing' : 'Discuss'}
      </TooltipContent>
    </Tooltip>
  );
}
