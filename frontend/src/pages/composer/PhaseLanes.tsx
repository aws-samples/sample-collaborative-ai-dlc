import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, X, Layers, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AUTONOMY_STYLES } from '@/lib/autonomy';
import { paletteColorForIndex } from '@/components/v2/scope-graph-utils';
import { AddPhaseDialog } from './AddPhaseDialog';
import type { PhaseNode, Placement, CompiledWorkflow, ScopeRef } from '@/services/workflows';
import type { Block } from '@/services/blocks';

interface PhaseLanesProps {
  phases: PhaseNode[];
  placements: Placement[];
  stagesById: Record<string, Block>;
  readOnly: boolean;
  compiled: CompiledWorkflow | null;
  scopeRefs: ScopeRef[];
  scopeLib: Block[];
  onDropStage: (stageId: string, phasePath: string | null) => void;
  onReorderPlacement: (
    stageId: string,
    targetPhasePath: string | null,
    targetIndex: number,
  ) => void;
  onRemovePlacement: (stageId: string) => void;
  onAddPhase: (phaseId: string, name: string, path: string) => void;
  onRemovePhase: (path: string) => void;
  onApplySkeleton: () => void;
  onToggleCell: (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => void;
  onAddScope: (scopeId: string) => void;
  onRemoveScope: (scopeId: string) => void;
  onOpenStage: (stageId: string) => void;
}

const DRAG_KEY = 'application/x-aidlc-stage';

const laneKey = (phasePath: string | null) => phasePath ?? '__unphased__';

export function PhaseLanes({
  phases,
  placements,
  stagesById,
  readOnly,
  compiled,
  scopeRefs,
  scopeLib,
  onDropStage,
  onReorderPlacement,
  onRemovePlacement,
  onAddPhase,
  onRemovePhase,
  onApplySkeleton,
  onToggleCell,
  onAddScope,
  onRemoveScope,
  onOpenStage,
}: PhaseLanesProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<string | null>(null);

  const sortedPhases = phases
    .filter((p) => p.phaseId !== 'initialization')
    .toSorted((a, b) => a.path.localeCompare(b.path));

  // Match the graph's colorByPath: sorted-index → paletteColorForIndex
  const phaseColorByPath: Record<string, string> = {};
  sortedPhases.forEach((p, i) => {
    phaseColorByPath[p.path] = paletteColorForIndex(i);
  });

  const topPaths = phases.filter((p) => !p.path.includes('.')).map((p) => p.path);

  const scopeIds = scopeRefs.map((r) => r.scopeId);
  const refScopeIdSet = new Set(scopeIds);
  const availableScopes = scopeLib.filter((s) => !refScopeIdSet.has(s.id));

  const placementsByPhase = (phasePath: string | null) =>
    placements
      .filter((p) => (phasePath === null ? !p.phasePath : p.phasePath === phasePath))
      .toSorted((a, b) => a.order - b.order);

  const placedStageIdSet = new Set(placements.map((p) => p.stageId));

  const handleDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverPath(key);
  };

  const handleDragLeave = (e: React.DragEvent, key: string) => {
    if (dragOverPath === key) {
      const rect = e.currentTarget.getBoundingClientRect();
      const { clientX, clientY } = e;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setDragOverPath(null);
      }
    }
  };

  const handleDrop = (e: React.DragEvent, phasePath: string | null) => {
    e.preventDefault();
    setDragOverPath(null);
    const stageId = e.dataTransfer.getData(DRAG_KEY);
    if (!stageId) return;
    if (placedStageIdSet.has(stageId)) {
      // Already placed → reorder/move: append to end of target lane
      const laneLength = placementsByPhase(phasePath).length;
      onReorderPlacement(stageId, phasePath, laneLength);
    } else {
      // New stage from palette → add
      onDropStage(stageId, phasePath);
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {!readOnly && (
          <>
            <AddPhaseDialog existingTopPaths={topPaths} onAdd={onAddPhase} />
            {phases.length === 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onApplySkeleton}>
                <Layers className="h-3.5 w-3.5" />
                Start from skeleton
              </Button>
            )}
          </>
        )}
        {scopeIds.length > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[10px] text-muted-foreground mr-1">Scope:</span>
            {scopeIds.map((s) => (
              <span key={s} className="inline-flex items-center gap-0.5">
                <Button
                  variant={activeScope === s ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setActiveScope(activeScope === s ? null : s)}
                >
                  {s}
                </Button>
                {!readOnly && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeScope === s) setActiveScope(null);
                      onRemoveScope(s);
                    }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))}
            {!readOnly && availableScopes.length > 0 && (
              <DropdownAddScope scopes={availableScopes} onAdd={onAddScope} />
            )}
          </div>
        )}
        {scopeIds.length === 0 && !readOnly && availableScopes.length > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[10px] text-muted-foreground mr-1">Scope:</span>
            <DropdownAddScope scopes={availableScopes} onAdd={onAddScope} />
          </div>
        )}
      </div>

      <div className="flex flex-row gap-2 overflow-x-auto pb-2">
        {sortedPhases.map((phase) => {
          const depth = phase.path.split('.').length - 1;
          const key = laneKey(phase.path);
          const lanePlacements = placementsByPhase(phase.path);
          const isOver = dragOverPath === key;

          return (
            <div
              key={phase.path}
              className={`shrink-0 min-w-[256px] w-64 border rounded-lg flex flex-col transition-colors ${
                isOver ? 'border-primary bg-primary/5' : 'border-border'
              }`}
              style={
                isOver
                  ? undefined
                  : { borderColor: phaseColorByPath[phase.path], borderWidth: '2px' }
              }
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={(e) => handleDragLeave(e, key)}
              onDrop={(e) => handleDrop(e, phase.path)}
            >
              <div className="flex items-center gap-1.5 p-2 border-b">
                {depth > 0 && (
                  <span className="text-[9px] text-muted-foreground select-none">
                    {'└'.repeat(depth)}
                  </span>
                )}
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                  {phase.path}
                </span>
                <span className="text-xs font-medium truncate">{phase.name}</span>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 ml-auto shrink-0"
                    onClick={() => onRemovePhase(phase.path)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </div>
              <div className="flex-1 p-1.5 flex flex-col gap-1 min-h-[80px]">
                {lanePlacements.length === 0 && (
                  <span className="text-[10px] text-muted-foreground italic py-4 text-center">
                    Drop stages here
                  </span>
                )}
                {lanePlacements.map((p, idx) => (
                  <PlacementChip
                    key={p.stageId}
                    stageId={p.stageId}
                    label={stagesById[p.stageId]?.name ?? p.stageId}
                    readOnly={readOnly}
                    autonomyLevel={compiled?.autonomy.perStage[p.stageId]}
                    scopeState={
                      activeScope ? (p.scopeMembership[activeScope] ?? 'SKIP') : undefined
                    }
                    onToggleScope={
                      activeScope && !readOnly
                        ? (next) => onToggleCell(p.stageId, activeScope, next)
                        : undefined
                    }
                    onRemove={() => onRemovePlacement(p.stageId)}
                    onOpenStage={() => onOpenStage(p.stageId)}
                    index={idx}
                    lanePhasePath={phase.path}
                    placedStageIdSet={placedStageIdSet}
                    onReorder={onReorderPlacement}
                    onDropNewStage={onDropStage}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {(() => {
          const key = laneKey(null);
          const lanePlacements = placementsByPhase(null);
          const isOver = dragOverPath === key;
          return (
            <div
              className={`shrink-0 min-w-[256px] w-64 border border-dashed rounded-lg flex flex-col transition-colors ${
                isOver ? 'border-primary bg-primary/5' : 'border-border'
              }`}
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={(e) => handleDragLeave(e, key)}
              onDrop={(e) => handleDrop(e, null)}
            >
              <div className="flex items-center gap-1.5 p-2 border-b border-dashed">
                <span className="text-xs font-medium text-muted-foreground">Unphased</span>
              </div>
              <div className="flex-1 p-1.5 flex flex-col gap-1 min-h-[80px]">
                {lanePlacements.length === 0 && (
                  <span className="text-[10px] text-muted-foreground italic py-4 text-center">
                    Stages without a phase
                  </span>
                )}
                {lanePlacements.map((p, idx) => (
                  <PlacementChip
                    key={p.stageId}
                    stageId={p.stageId}
                    label={stagesById[p.stageId]?.name ?? p.stageId}
                    readOnly={readOnly}
                    autonomyLevel={compiled?.autonomy.perStage[p.stageId]}
                    scopeState={
                      activeScope ? (p.scopeMembership[activeScope] ?? 'SKIP') : undefined
                    }
                    onToggleScope={
                      activeScope && !readOnly
                        ? (next) => onToggleCell(p.stageId, activeScope, next)
                        : undefined
                    }
                    onRemove={() => onRemovePlacement(p.stageId)}
                    onOpenStage={() => onOpenStage(p.stageId)}
                    index={idx}
                    lanePhasePath={null}
                    placedStageIdSet={placedStageIdSet}
                    onReorder={onReorderPlacement}
                    onDropNewStage={onDropStage}
                  />
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function PlacementChip({
  stageId,
  label,
  readOnly,
  autonomyLevel,
  scopeState,
  onToggleScope,
  onRemove,
  onOpenStage,
  index,
  lanePhasePath,
  placedStageIdSet,
  onReorder,
  onDropNewStage,
}: {
  stageId: string;
  label: string;
  readOnly: boolean;
  autonomyLevel?: string;
  scopeState?: 'EXECUTE' | 'SKIP';
  onToggleScope?: (next: 'EXECUTE' | 'SKIP') => void;
  onRemove: () => void;
  onOpenStage: () => void;
  index: number;
  lanePhasePath: string | null;
  placedStageIdSet: Set<string>;
  onReorder: (stageId: string, targetPhasePath: string | null, targetIndex: number) => void;
  onDropNewStage: (stageId: string, phasePath: string | null) => void;
}) {
  const [dropEdge, setDropEdge] = useState<'top' | 'bottom' | null>(null);

  const autonomy =
    autonomyLevel && autonomyLevel in AUTONOMY_STYLES
      ? AUTONOMY_STYLES[autonomyLevel as keyof typeof AUTONOMY_STYLES]
      : null;

  const handleChipDragOver = (e: React.DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropEdge(e.clientY < midY ? 'top' : 'bottom');
  };

  const handleChipDragLeave = (e: React.DragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX, clientY } = e;
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      setDropEdge(null);
    }
  };

  const handleChipDrop = (e: React.DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setDropEdge(null);
    const draggedId = e.dataTransfer.getData(DRAG_KEY);
    if (!draggedId || draggedId === stageId) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertIndex = e.clientY < midY ? index : index + 1;

    if (placedStageIdSet.has(draggedId)) {
      onReorder(draggedId, lanePhasePath, insertIndex);
    } else {
      onDropNewStage(draggedId, lanePhasePath);
    }
  };

  return (
    <div className="relative">
      {dropEdge === 'top' && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary rounded-full -translate-y-0.5 z-10" />
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-md border bg-background hover:border-foreground/30 hover:bg-accent/50 transition-colors cursor-grab"
        draggable={!readOnly}
        title="Open stage"
        onClick={() => onOpenStage()}
        onDragStart={(e) => {
          if (readOnly) return;
          e.dataTransfer.setData(DRAG_KEY, stageId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={handleChipDragOver}
        onDragLeave={handleChipDragLeave}
        onDrop={handleChipDrop}
      >
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-xs font-medium truncate">{label}</span>
          {autonomy && (
            <span className="inline-flex items-center gap-1 shrink-0">
              <span className={cn('h-1.5 w-1.5 rounded-full', autonomy.dot)} />
              <span className="text-[10px] text-muted-foreground">{autonomy.chipLabel}</span>
            </span>
          )}
        </div>

        <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {onToggleScope && scopeState && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleScope(scopeState === 'EXECUTE' ? 'SKIP' : 'EXECUTE');
              }}
              className={cn(
                'h-6 w-12 rounded text-[10px] font-medium transition-colors',
                scopeState === 'EXECUTE'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {scopeState === 'EXECUTE' ? 'EXEC' : 'SKIP'}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="hover:text-destructive p-1 rounded hover:bg-destructive/10"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      {dropEdge === 'bottom' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full translate-y-0.5 z-10" />
      )}
    </div>
  );
}

function DropdownAddScope({
  scopes,
  onAdd,
}: {
  scopes: Block[];
  onAdd: (scopeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <span className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1 text-[10px]"
        onClick={() => setOpen(!open)}
      >
        <Plus className="h-3 w-3" />
        Add scope
      </Button>
      {open && (
        <div className="absolute z-10 top-full mt-1 right-0 bg-popover border rounded-md shadow-md p-1 min-w-[120px]">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent"
              onClick={() => {
                onAdd(s.id);
                setOpen(false);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
