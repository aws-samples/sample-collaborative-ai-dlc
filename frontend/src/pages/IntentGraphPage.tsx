import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ArrowLeft } from 'lucide-react';

export default function IntentGraphPage() {
  const { projectId, intentId, loading: contextLoading, error: contextError } = useIntent();
  const navigate = useNavigate();

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
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (contextError) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 text-sm text-destructive">
        {contextError}
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <GraphCanvas
        nodes={visibleNodes}
        edges={visibleEdges}
        title="Knowledge graph"
        loading={loading}
        error={error}
        headerLeading={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => navigate(`/space/${projectId}/intent/${intentId}`)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Workbench
            </Button>
            <ToggleGroup
              type="single"
              aria-label="Graph layer"
              value={layer}
              onValueChange={(v) => {
                if (v === 'artifacts' || v === 'all') setLayer(v);
              }}
              className="gap-0.5 shrink-0"
            >
              <ToggleGroupItem value="artifacts" className="h-6 px-2 text-[11px]">
                Artifacts
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="h-6 px-2 text-[11px]">
                + Items & Units
              </ToggleGroupItem>
            </ToggleGroup>
          </>
        }
      />
    </div>
  );
}
