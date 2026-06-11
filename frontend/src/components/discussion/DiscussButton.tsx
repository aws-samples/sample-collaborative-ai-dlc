import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDiscussions } from './DiscussionProvider';
import type { OpenDiscussionArgs } from './DiscussionProvider';

// DiscussButton (plan §9): the entry-point affordance with an unread-aware
// badge (dot + count when unreadCount > 0). Renders nothing when no
// DiscussionProvider is mounted (outside a sprint).

interface Props extends OpenDiscussionArgs {
  className?: string;
}

export function DiscussButton({ entityType, entityId, entityTitle, className }: Props) {
  const discussions = useDiscussions();
  if (!discussions) return null;

  const unread = discussions.unreadFor(entityType, entityId);

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
          aria-label={unread > 0 ? `Discuss (${unread} unread)` : 'Discuss'}
        >
          <MessageSquare className={cn('h-3 w-3', unread > 0 && 'text-primary')} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[8px] font-semibold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{unread > 0 ? `Discuss — ${unread} unread` : 'Discuss'}</TooltipContent>
    </Tooltip>
  );
}
