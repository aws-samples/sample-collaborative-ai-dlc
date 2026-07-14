import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Network, ArrowRight, ArrowLeft } from 'lucide-react';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { nodeTypeBadge, shortNodeType, humanEdgeLabel } from '@/components/graph/nodeStyles';
import { focusWorkProduct } from '@/components/intent/workProductsFocus';

// The v2 "graph context" popover — v1's ArtifactGraphPopover pattern
// (Network icon + count badge → neighbors grouped by direction + edge label),
// upgraded with in-page navigation: clicking a neighbor focuses its card/row
// in the Work products panel (expand + scroll + flash). Navigation NEVER
// leaves the workbench; the full graph page stays reachable from the pipeline
// bar. Renders nothing when the node has no neighbors.

// Neighbor types that have an in-page anchor to jump to. Everything else
// (Intent hub, questions, project knowledge…) renders as a read-only row.
const NAVIGABLE_ITEM_TYPES = new Set([
  'Story',
  'Persona',
  'Requirement',
  'Component',
  'Decision',
  'StoryMapEntry',
  'Contract',
]);

const isNavigable = (n: GraphNeighbor): boolean =>
  n.type === 'Artifact' || NAVIGABLE_ITEM_TYPES.has(n.type);

interface IntentGraphPopoverProps {
  neighbors: GraphNeighbor[];
  className?: string;
}

export function IntentGraphPopover({ neighbors, className }: IntentGraphPopoverProps) {
  const [open, setOpen] = useState(false);

  if (neighbors.length === 0)
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-6 w-6 relative pointer-events-none', className)}
        aria-hidden
        tabIndex={-1}
      >
        <Network className="h-3 w-3" />
      </Button>
    );

  // Group by direction + edge label ("outgoing covers", "incoming has item"…).
  const grouped = new Map<string, GraphNeighbor[]>();
  for (const n of neighbors) {
    const key = `${n.direction}:${n.edgeLabel}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(n);
  }

  const navigate = (n: GraphNeighbor) => {
    setOpen(false);
    focusWorkProduct(
      n.type === 'Artifact' ? { kind: 'artifact', id: n.id } : { kind: 'item', id: n.id },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-6 w-6 relative', className)}
              aria-label={`${neighbors.length} connection${neighbors.length !== 1 ? 's' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <Network className="h-3 w-3" />
              <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-primary text-[8px] text-primary-foreground flex items-center justify-center">
                {neighbors.length}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Connections</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 p-0" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="px-3 py-2 border-b">
          <div className="flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">
              {neighbors.length} connection{neighbors.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-2 space-y-2">
          {Array.from(grouped.entries()).map(([key, items]) => {
            const direction = key.startsWith('outgoing') ? 'outgoing' : 'incoming';
            const edgeLabel = key.slice(key.indexOf(':') + 1);
            return (
              <div key={key}>
                <div className="flex items-center gap-1 mb-1">
                  {direction === 'outgoing' ? (
                    <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/60" />
                  ) : (
                    <ArrowLeft className="h-2.5 w-2.5 text-muted-foreground/60" />
                  )}
                  <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                    {humanEdgeLabel(edgeLabel)}
                  </span>
                </div>
                <div className="space-y-0.5 ml-4">
                  {items.map((neighbor) =>
                    isNavigable(neighbor) ? (
                      <button
                        key={`${neighbor.id}:${neighbor.edgeLabel}:${neighbor.direction}`}
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/60 transition-colors"
                        title={neighbor.label}
                        onClick={() => navigate(neighbor)}
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            'h-4 px-1 text-[8px] shrink-0',
                            nodeTypeBadge(neighbor.type),
                          )}
                        >
                          {shortNodeType(neighbor.type)}
                        </Badge>
                        <span className="text-[11px] text-foreground truncate">
                          {neighbor.label}
                        </span>
                      </button>
                    ) : (
                      <div
                        key={`${neighbor.id}:${neighbor.edgeLabel}:${neighbor.direction}`}
                        className="flex items-center gap-1.5 px-1 py-0.5"
                        title={neighbor.label}
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            'h-4 px-1 text-[8px] shrink-0',
                            nodeTypeBadge(neighbor.type),
                          )}
                        >
                          {shortNodeType(neighbor.type)}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground truncate">
                          {neighbor.label}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
