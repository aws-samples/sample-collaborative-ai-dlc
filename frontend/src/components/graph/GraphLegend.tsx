import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { getNodeCfg } from './graphTypes';

export interface GraphLegendProps {
  presentTypes: Set<string>;
  typeCounts: Record<string, number>;
  typeFilters: Set<string>;
  onToggleTypeFilter: (type: string) => void;
}

export function GraphLegend({
  presentTypes,
  typeCounts,
  typeFilters,
  onToggleTypeFilter,
}: GraphLegendProps) {
  return (
    <div className="absolute bottom-3 left-3 z-10">
      <Card className="bg-background/90 backdrop-blur-sm shadow-lg">
        <div className="px-2.5 py-1.5 border-b">
          <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
            Legend
          </span>
        </div>
        <CardContent className="p-2 space-y-1">
          {[...presentTypes].map((type) => {
            const cfg = getNodeCfg(type);
            const count = typeCounts[type] || 0;
            if (count === 0) return null;
            const Icon = cfg.icon;
            return (
              <button
                key={type}
                className={cn(
                  'flex items-center gap-2 w-full text-left rounded px-1 py-0.5 transition-colors hover:bg-muted/50',
                  typeFilters.has(type) && 'bg-muted',
                )}
                onClick={() => onToggleTypeFilter(type)}
              >
                <span
                  className="h-3 w-3 rounded shrink-0 shadow-sm ring-1 ring-black/5"
                  style={{
                    background: `linear-gradient(135deg, ${cfg.gradientFrom}, ${cfg.gradientTo})`,
                  }}
                />
                <Icon className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] text-foreground/80 flex-1">{cfg.label}</span>
                <span className="text-[10px] tabular-nums font-medium text-muted-foreground/60">
                  {count}
                </span>
              </button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
