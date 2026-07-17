import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sprintGraphService, type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { useSprint } from '@/contexts/SprintContext';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Button } from '@/components/ui/button';
import { Sparkles, ArrowLeft } from 'lucide-react';

interface GraphCacheEntry {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fetchedAt: number;
}

const graphCache = new Map<string, GraphCacheEntry>();

/** @internal Test-only — reset module cache between test runs. */
export function clearGraphCacheForTests() {
  graphCache.clear();
}

export default function SprintGraph() {
  const { sprintId, projectId } = useParams<{ projectId: string; sprintId: string }>();
  const { sprint } = useSprint();
  const navigate = useNavigate();

  const cached = sprintId ? graphCache.get(sprintId) : null;
  const [nodes, setNodes] = useState<GraphNode[]>(cached?.nodes ?? []);
  const [edges, setEdges] = useState<GraphEdge[]>(cached?.edges ?? []);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (!sprintId) return;
    sprintGraphService
      .get(sprintId)
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
        graphCache.set(sprintId, { nodes: n, edges: e, fetchedAt: Date.now() });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sprintId]);

  if (!sprintId) return null;

  return (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      title={`${sprint?.name || 'Sprint'} Graph`}
      loading={loading}
      emptyState={
        <>
          <div className="h-20 w-20 rounded-2xl bg-muted/50 flex items-center justify-center">
            <Sparkles className="h-10 w-10 text-muted-foreground/40" />
          </div>
          <div className="text-center max-w-xs">
            <p className="text-sm font-semibold">No artifacts yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run the inception agent to generate requirements, user stories, and tasks. They'll
              appear here as an interactive knowledge graph.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 gap-1.5"
            onClick={() => navigate(`/space/${projectId}/sprint/${sprintId}`)}
          >
            <ArrowLeft className="h-3 w-3" />
            Go to Inception
          </Button>
        </>
      }
    />
  );
}
