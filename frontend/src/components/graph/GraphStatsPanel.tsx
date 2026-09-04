import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { BarChart3, X } from 'lucide-react';
import { type LayoutNode, getNodeCfg, EDGE_LABELS } from './graphTypes';

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  typeCount: number;
  maxDegree: number;
  avgDegree: string;
  hubNode: LayoutNode | null | undefined;
  hubDegree: number;
  edgeLabelCounts: Record<string, number>;
  density: string;
}

export interface GraphStatsPanelProps {
  graphStats: GraphStats;
  onClose: () => void;
}

export function GraphStatsPanel({ graphStats, onClose }: GraphStatsPanelProps) {
  return (
    <div className="absolute top-3 left-3 z-10 w-56">
      <Card className="bg-background/90 backdrop-blur-sm shadow-lg">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <BarChart3 className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Graph Statistics
            </span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
        <CardContent className="p-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <StatItem label="Nodes" value={String(graphStats.nodeCount)} />
            <StatItem label="Edges" value={String(graphStats.edgeCount)} />
            <StatItem label="Types" value={String(graphStats.typeCount)} />
            <StatItem label="Density" value={graphStats.density} />
            <StatItem label="Max Degree" value={String(graphStats.maxDegree)} />
            <StatItem label="Avg Degree" value={graphStats.avgDegree} />
          </div>
          {graphStats.hubNode && (
            <>
              <Separator />
              <div>
                <span className="text-[9px] uppercase font-medium text-muted-foreground tracking-wider">
                  Hub Node
                </span>
                <div className="flex items-center gap-1.5 mt-1">
                  <span
                    className="h-2.5 w-2.5 rounded shrink-0"
                    style={{
                      backgroundColor: getNodeCfg(graphStats.hubNode.type).color,
                    }}
                  />
                  <span className="text-[11px] font-medium truncate">
                    {graphStats.hubNode.label}
                  </span>
                  <Badge variant="secondary" className="h-4 px-1 text-[8px] ml-auto shrink-0">
                    {graphStats.hubDegree} links
                  </Badge>
                </div>
              </div>
            </>
          )}
          <Separator />
          <div>
            <span className="text-[9px] uppercase font-medium text-muted-foreground tracking-wider">
              Edge Types
            </span>
            <div className="mt-1 space-y-0.5">
              {Object.entries(graphStats.edgeLabelCounts)
                .toSorted((a, b) => b[1] - a[1])
                .map(([label, count]) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      {EDGE_LABELS[label] || label}
                    </span>
                    <span className="text-[10px] tabular-nums font-medium">{count}</span>
                  </div>
                ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 px-2 py-1.5">
      <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider">{label}</span>
      <p className="text-sm font-bold tabular-nums leading-none mt-0.5">{value}</p>
    </div>
  );
}
