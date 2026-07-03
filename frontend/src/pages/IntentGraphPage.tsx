import { useState, useEffect } from 'react';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService } from '@/services/intents';
import { type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Skeleton } from '@/components/ui/skeleton';

export default function IntentGraphPage() {
  const { projectId, intentId, loading: contextLoading, error: contextError } = useIntent();

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !intentId) return;
    setLoading(true);
    setError(null);
    intentsService
      .graph(projectId, intentId)
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
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
    <div className="h-full overflow-hidden">
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        title="Knowledge graph"
        loading={loading}
        error={error}
      />
    </div>
  );
}
