import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntentGraphNode } from '@/services/intents';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { nodeTypeTextColor } from '@/components/graph/nodeStyles';

export function DerivedItemRow({
  item,
  getNeighbors,
  onPreview,
  showGraph = true,
}: {
  item: IntentGraphNode;
  getNeighbors: (id: string) => GraphNeighbor[];
  onPreview: () => void;
  showGraph?: boolean;
}) {
  return (
    <div
      id={`item-${item.id}`}
      role="button"
      tabIndex={0}
      className="group/item flex items-center gap-1.5 rounded-md px-2 py-1 scroll-mt-4 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onPreview}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPreview();
        }
      }}
    >
      <ChevronRight
        className={cn('h-3 w-3 shrink-0', nodeTypeTextColor(item.type))}
        strokeWidth={3}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
      {item.priority && (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] shrink-0">
          {item.priority}
        </Badge>
      )}
      {showGraph && <IntentGraphPopover neighbors={getNeighbors(item.id)} className="shrink-0" />}
      <DiscussButton
        entityType="item"
        entityId={item.id}
        entityTitle={item.label}
        className="shrink-0"
      />
    </div>
  );
}
