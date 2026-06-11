import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDiscussions } from './DiscussionProvider';
import type { OpenDiscussionArgs } from './DiscussionProvider';

// DiscussButton (plan §9): the entry-point affordance. Renders nothing when
// no DiscussionProvider is mounted (outside a sprint). The unread-aware badge
// lands in the chat-UI-features PR.

interface Props extends OpenDiscussionArgs {
  className?: string;
}

export function DiscussButton({ entityType, entityId, entityTitle, className }: Props) {
  const discussions = useDiscussions();
  if (!discussions) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6', className)}
          onClick={(e) => {
            e.stopPropagation();
            discussions.openDiscussion({ entityType, entityId, entityTitle });
          }}
          aria-label="Discuss"
        >
          <MessageSquare className="h-3 w-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Discuss</TooltipContent>
    </Tooltip>
  );
}
