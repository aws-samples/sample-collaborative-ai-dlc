import { cn } from '@/lib/utils';
import { getNodeCfg } from './graphTypes';

export interface GraphFilterBarProps {
  presentTypes: Set<string>;
  typeCounts: Record<string, number>;
  typeFilters: Set<string>;
  onToggleTypeFilter: (type: string) => void;
  onClearAll: () => void;
}

export function GraphFilterBar({
  presentTypes,
  typeCounts,
  typeFilters,
  onToggleTypeFilter,
  onClearAll,
}: GraphFilterBarProps) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-1.5 border-b bg-muted/20 shrink-0 flex-wrap">
      <span className="text-[10px] uppercase font-medium text-muted-foreground mr-1">Type:</span>
      {[...presentTypes].map((type) => {
        const cfg = getNodeCfg(type);
        const active = typeFilters.has(type);
        const count = typeCounts[type] || 0;
        if (count === 0) return null;
        return (
          <button
            key={type}
            onClick={() => onToggleTypeFilter(type)}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all',
              active
                ? 'border-foreground/20 bg-foreground/8 text-foreground shadow-sm'
                : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-black/10"
              style={{ backgroundColor: cfg.color }}
            />
            {cfg.label}
            <span className="text-muted-foreground/50 tabular-nums">{count}</span>
          </button>
        );
      })}
      {typeFilters.size > 0 && (
        <button
          onClick={onClearAll}
          className="text-[10px] text-muted-foreground hover:text-foreground ml-2 underline underline-offset-2"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
