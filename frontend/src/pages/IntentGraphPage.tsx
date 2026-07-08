import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService } from '@/services/intents';
import { type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ArrowLeft } from 'lucide-react';

const GRAPH_CACHE_MAX = 20;

interface GraphCacheEntry {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const graphCache = new Map<string, GraphCacheEntry>();

function graphCacheKey(projectId: string, intentId: string): string {
  return `${projectId}#${intentId}`;
}

function trimGraphCache() {
  while (graphCache.size > GRAPH_CACHE_MAX) {
    const oldest = graphCache.keys().next().value!;
    graphCache.delete(oldest);
  }
}

export default function IntentGraphPage() {
  const { projectId, intentId, loading: contextLoading, error: contextError } = useIntent();
  const navigate = useNavigate();

  const key = graphCacheKey(projectId, intentId);

  const [nodes, setNodes] = useState<GraphNode[]>(() => graphCache.get(key)?.nodes ?? []);
  const [edges, setEdges] = useState<GraphEdge[]>(() => graphCache.get(key)?.edges ?? []);
  const [loading, setLoading] = useState(() => !graphCache.get(key));
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!projectId || !intentId) return;
    let cancelled = false;
    const k = graphCacheKey(projectId, intentId);
    const hit = graphCache.get(k);
    if (hit) {
      if (!cancelled) {
        setNodes(hit.nodes);
        setEdges(hit.edges);
        setLoading(false);
      }
    } else {
      if (!cancelled) setLoading(true);
    }
    if (!cancelled) setError(null);
    intentsService
      .graph(projectId, intentId)
      .then(({ nodes: n, edges: e }) => {
        graphCache.set(k, { nodes: n, edges: e });
        trimGraphCache();
        if (cancelled) return;
        setNodes(n);
        setEdges(e);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Failed to load knowledge graph');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId]);

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
              onClick={() => navigate(`/project/${projectId}/intent/${intentId}`)}
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
