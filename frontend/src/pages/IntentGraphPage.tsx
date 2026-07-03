import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService } from '@/services/intents';
import { type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
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

export function clearIntentGraphCache() {
  graphCache.clear();
}

export default function IntentGraphPage() {
  const { projectId, intentId, loading: contextLoading, error: contextError } = useIntent();
  const navigate = useNavigate();

  const key = graphCacheKey(projectId, intentId);
  const cached = graphCache.get(key);

  const [nodes, setNodes] = useState<GraphNode[]>(cached?.nodes ?? []);
  const [edges, setEdges] = useState<GraphEdge[]>(cached?.edges ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !intentId) return;
    const k = graphCacheKey(projectId, intentId);
    const hit = graphCache.get(k);
    if (hit) {
      setNodes(hit.nodes);
      setEdges(hit.edges);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    intentsService
      .graph(projectId, intentId)
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
        graphCache.set(k, { nodes: n, edges: e });
        trimGraphCache();
      })
      .catch(() => setError('Failed to load knowledge graph'))
      .finally(() => setLoading(false));
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
    <div className="h-full overflow-hidden flex flex-col">
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 h-7"
          onClick={() => navigate(`/project/${projectId}/intent/${intentId}`)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to workbench
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          title="Knowledge graph"
          loading={loading}
          error={error}
        />
      </div>
    </div>
  );
}
