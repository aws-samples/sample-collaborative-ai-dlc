import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Library } from 'lucide-react';
import type { Block } from '@/services/blocks';

interface BlockPaletteProps {
  stages: Block[];
  placedStageIds: Set<string>;
  readOnly: boolean;
  onAdd: (stageId: string) => void;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function BlockPalette({ stages, placedStageIds, readOnly, onAdd }: BlockPaletteProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const filtered = stages.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.description &&
        typeof s.description === 'string' &&
        s.description.toLowerCase().includes(q))
    );
  });

  return (
    <div className="w-full border rounded-lg flex flex-col">
      <div className="flex items-center gap-3 flex-wrap p-2.5 border-b">
        <p className="text-xs font-medium shrink-0">Building blocks</p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => navigate('/blocks/stage/new')}
        >
          <Plus className="h-3 w-3" />
          New stage
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => navigate('/blocks/stage')}
        >
          <Library className="h-3 w-3" />
          Block library
        </Button>
        <Input
          placeholder="Filter stages…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 text-xs w-48"
        />
      </div>
      <div className="grid grid-rows-2 grid-flow-col auto-cols-[14rem] gap-2 overflow-x-auto p-2">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">No stages match.</p>
        )}
        {filtered.map((stage) => {
          const placed = placedStageIds.has(stage.id);
          const draggable = !placed && !readOnly;
          const leadAgent =
            typeof stage.leadAgent === 'string' ? (stage.leadAgent as string) : null;
          const defaultGrouping = typeof stage.phase === 'string' ? stage.phase : null;

          return (
            <div
              key={stage.id}
              className={`group shrink-0 border rounded-md p-2 text-xs transition-colors ${
                placed
                  ? 'opacity-50 cursor-default'
                  : readOnly
                    ? 'cursor-default'
                    : 'cursor-grab hover:border-foreground/40 hover:bg-accent/30'
              }`}
              draggable={draggable}
              onDragStart={(e) => {
                if (!draggable) return;
                e.dataTransfer.setData('application/x-aidlc-stage', stage.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium truncate">{stage.name}</span>
                {stage.readOnly && (
                  <Badge variant="outline" className="h-4 px-1 text-[8px] shrink-0">
                    SYSTEM
                  </Badge>
                )}
                {placed && (
                  <Badge variant="secondary" className="h-4 px-1 text-[8px] shrink-0">
                    placed
                  </Badge>
                )}
                <span className="ml-auto flex items-center gap-0.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/blocks/stage/${stage.id}`);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  {draggable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAdd(stage.id);
                      }}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </span>
              </div>
              {(defaultGrouping || leadAgent) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                  {defaultGrouping && (
                    <span>
                      <span className="opacity-70">Recommended:</span>{' '}
                      <span className="font-medium text-foreground/80">
                        {titleCase(defaultGrouping)}
                      </span>
                    </span>
                  )}
                  {leadAgent && (
                    <span>
                      <span className="opacity-70">Agent:</span> {leadAgent}
                    </span>
                  )}
                </div>
              )}
              {stage.description && (
                <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                  {stage.description}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
