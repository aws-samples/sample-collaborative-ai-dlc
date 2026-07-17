import { type GraphEdge } from '@/services/sprintGraph';
import { Card, CardContent } from '@/components/ui/card';
import { Map as MapIcon } from 'lucide-react';
import { type LayoutNode, type ViewBox, getNodeCfg } from './graphTypes';

export interface GraphMinimapProps {
  nodes: LayoutNode[];
  filteredEdges: GraphEdge[];
  filteredNodeIds: Set<string>;
  nodeMap: Map<string, LayoutNode>;
  viewBox: ViewBox;
  selectedNode: string | null;
  worldBox: { x: number; y: number; width: number; height: number };
}

export function GraphMinimap({
  nodes,
  filteredEdges,
  filteredNodeIds,
  nodeMap,
  viewBox,
  selectedNode,
  worldBox,
}: GraphMinimapProps) {
  return (
    <div className="absolute bottom-3 right-3 z-10">
      <Card className="bg-background/90 backdrop-blur-sm shadow-lg overflow-hidden">
        <div className="px-2 py-1 border-b flex items-center gap-1.5">
          <MapIcon className="h-2.5 w-2.5 text-muted-foreground" />
          <span className="text-[9px] font-medium text-muted-foreground">Minimap</span>
        </div>
        <CardContent className="p-1.5">
          <svg
            width="160"
            height="100"
            viewBox={`${worldBox.x} ${worldBox.y} ${worldBox.width} ${worldBox.height}`}
            className="bg-muted/30 rounded"
          >
            {filteredEdges.map((edge, i) => {
              const s = nodeMap.get(edge.source);
              const t = nodeMap.get(edge.target);
              if (!s || !t) return null;
              return (
                <line
                  key={`me-${i}`}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke="currentColor"
                  className="text-muted-foreground/15"
                  strokeWidth={Math.max(worldBox.width / 200, 1)}
                />
              );
            })}
            {nodes
              .filter((n) => filteredNodeIds.has(n.id))
              .map((node) => {
                const cfg = getNodeCfg(node.type);
                const r = Math.max(worldBox.width / 100, 3);
                return (
                  <circle
                    key={`mn-${node.id}`}
                    cx={node.x}
                    cy={node.y}
                    r={r}
                    fill={cfg.color}
                    opacity={selectedNode === node.id ? 1 : 0.7}
                    stroke={selectedNode === node.id ? '#fff' : 'none'}
                    strokeWidth={r * 0.5}
                  />
                );
              })}
            <rect
              x={viewBox.x}
              y={viewBox.y}
              width={viewBox.width}
              height={viewBox.height}
              fill="none"
              stroke="currentColor"
              className="text-foreground/40"
              strokeWidth={Math.max(worldBox.width / 200, 1.5)}
              strokeDasharray="6 3"
            />
          </svg>
        </CardContent>
      </Card>
    </div>
  );
}
