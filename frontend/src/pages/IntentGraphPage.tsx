import { useState, useMemo } from 'react';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Layers, Box } from 'lucide-react';

export default function IntentGraphPage() {
  const { projectId, intentId, loading: contextLoading, error: contextError } = useIntent();

  // Shared SWR graph cache — the same fetch the workbench popovers and the
  // derived-items section use (see useIntentGraph).
  const { nodes, edges, loading, error } = useIntentGraph(projectId, intentId);
  // Layer toggle: 'artifacts' hides the derived projection (typed items +
  // unit DAG, nodes tagged graphLayer='derived'); 'all' shows everything.
  const [layer, setLayer] = useState<'artifacts' | 'all'>('artifacts');

  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (layer === 'all') return { visibleNodes: nodes, visibleEdges: edges };
    const kept = nodes.filter((n) => n.graphLayer !== 'derived');
    const keptIds = new Set(kept.map((n) => n.id));
    return {
      visibleNodes: kept,
      visibleEdges: edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
    };
  }, [layer, nodes, edges]);

  if (contextLoading && !nodes.length) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (contextError) {
    return <div className="text-sm text-destructive">{contextError}</div>;
  }

  return (
    <div className="h-full min-w-0 overflow-hidden">
      <GraphCanvas
        nodes={visibleNodes}
        edges={visibleEdges}
        title="Knowledge graph"
        loading={loading}
        error={error}
        headerLeading={
          <div
            role="group"
            aria-label="Graph layer"
            className="flex items-center rounded-md border bg-muted/30 p-0.5 shrink-0"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setLayer('artifacts')}
                  aria-label="Artifacts layer"
                  aria-pressed={layer === 'artifacts'}
                  className={cn(
                    'flex items-center gap-1 rounded-sm px-1.5 sm:px-2 py-1 text-[10px] font-medium transition-all',
                    layer === 'artifacts'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Layers className="h-3 w-3" />
                  <span className="hidden sm:inline">Artifacts</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Artifacts only</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setLayer('all')}
                  aria-label="Items and Units layer"
                  aria-pressed={layer === 'all'}
                  className={cn(
                    'flex items-center gap-1 rounded-sm px-1.5 sm:px-2 py-1 text-[10px] font-medium transition-all',
                    layer === 'all'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Box className="h-3 w-3" />
                  <span className="hidden sm:inline">+ Items &amp; Units</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Include derived items &amp; units</TooltipContent>
            </Tooltip>
          </div>
        }
      />
    </div>
  );
}
