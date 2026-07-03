import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sprintGraphService, type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { useSprint } from '@/contexts/SprintContext';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Button } from '@/components/ui/button';
import { Sparkles, ArrowLeft } from 'lucide-react';

export default function SprintGraph() {
  const { sprintId, projectId } = useParams<{ projectId: string; sprintId: string }>();
  const { sprint } = useSprint();
  const navigate = useNavigate();

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sprintId) return;
    setLoading(true);
    sprintGraphService
      .get(sprintId)
      .then(({ nodes: n, edges: e }) => {
        setNodes(n);
        setEdges(e);
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
            onClick={() => navigate(`/project/${projectId}/sprint/${sprintId}`)}
          >
            <ArrowLeft className="h-3 w-3" />
            Go to Inception
          </Button>
        </>
      }
    />
  );
}
