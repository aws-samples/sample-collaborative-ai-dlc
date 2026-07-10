import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil } from 'lucide-react';
import type { Block } from '@/services/blocks';

const ALL_PHASES = '__all__';

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
  const [phaseFilter, setPhaseFilter] = useState(ALL_PHASES);

  const phaseOptions = [
    ...new Set(
      stages
        .map((stage) => (typeof stage.phase === 'string' ? stage.phase : null))
        .filter((phase): phase is string => phase !== null),
    ),
  ].toSorted();

  const filteredStages = stages.filter((stage) => {
    if (phaseFilter !== ALL_PHASES) {
      const stagePhase = typeof stage.phase === 'string' ? stage.phase : null;
      if (stagePhase !== phaseFilter) return false;
    }
    if (!filter) return true;
    const query = filter.toLowerCase();
    return (
      stage.name.toLowerCase().includes(query) ||
      (typeof stage.description === 'string' && stage.description.toLowerCase().includes(query))
    );
  });

  return (
    <div className="w-full border rounded-lg flex flex-col bg-muted/40">
      <div className="border-b p-2.5 bg-muted/30">
        <p className="text-xs font-medium">Library stages</p>
        <div className="mt-2 flex items-center gap-2">
          <Select value={phaseFilter} onValueChange={setPhaseFilter}>
            <SelectTrigger className="h-7 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PHASES}>All phases</SelectItem>
              {phaseOptions.map((phase) => (
                <SelectItem key={phase} value={phase}>
                  {titleCase(phase)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Filter stages…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 min-w-0 flex-1 text-xs"
          />
        </div>
      </div>
      <div className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto p-2">
        {filteredStages.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">No stages match.</p>
        )}
        {filteredStages.map((stage) => {
          const placed = placedStageIds.has(stage.id);
          const draggable = !placed && !readOnly;
          const defaultGrouping = typeof stage.phase === 'string' ? stage.phase : null;

          return (
            <div
              key={stage.id}
              className={`group shrink-0 border rounded-md p-2 text-xs transition-colors bg-card shadow-sm ${
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
                    title="Open in Block Library"
                    aria-label={`Open ${stage.name} in Block Library`}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/blocks/stage/${stage.id}`);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    title="Add to workflow"
                    aria-label={`Add ${stage.name} to workflow`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd(stage.id);
                    }}
                    disabled={!draggable}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </span>
              </div>
              {defaultGrouping && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
                  <span>
                    <span className="opacity-70">Recommended:</span>{' '}
                    <span className="font-medium text-foreground/80">
                      {titleCase(defaultGrouping)}
                    </span>
                  </span>
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
