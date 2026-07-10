import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, X, Layers, Plus, AlertTriangle, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AUTONOMY_STYLES } from '@/lib/autonomy';
import { paletteColorForIndex } from '@/components/v2/scope-graph-utils';
import type { PhaseNode, Placement, CompiledWorkflow } from '@/services/workflows';
import type { Block } from '@/services/blocks';
import { displayPhasePathForPlacement, visibleWorkflowPhases } from './phaseDisplay';

interface PhaseLanesProps {
  phases: PhaseNode[];
  placements: Placement[];
  stagesById: Record<string, Block>;
  readOnly: boolean;
  compiled: CompiledWorkflow | null;
  branchIssues?: Record<string, string[]>;
  onDropStage: (stageId: string, phasePath: string | null) => void;
  onReorderPlacement: (
    stageId: string,
    targetPhasePath: string | null,
    targetIndex: number,
  ) => void;
  onRemovePlacement: (stageId: string) => void;
  onAddPhase: () => void;
  editingPhasePath: string | null;
  onStartPhaseRename: (path: string) => void;
  onCancelPhaseRename: () => void;
  onRenamePhase: (path: string, name: string) => void;
  onRemovePhase: (path: string) => void;
  onApplySkeleton: () => void;
  onOpenStage: (stageId: string) => void;
}

const DRAG_KEY = 'application/x-aidlc-stage';

const laneKey = (phasePath: string | null) => phasePath ?? '__unphased__';

// A placement wired to EXECUTE in no scope can never run in any scope.
const isUnwired = (p: Placement) =>
  !Object.values(p.scopeMembership ?? {}).some((v) => v === 'EXECUTE');

export function PhaseLanes({
  phases,
  placements,
  stagesById,
  readOnly,
  compiled,
  branchIssues = {},
  onDropStage,
  onReorderPlacement,
  onRemovePlacement,
  onAddPhase,
  editingPhasePath,
  onStartPhaseRename,
  onCancelPhaseRename,
  onRenamePhase,
  onRemovePhase,
  onApplySkeleton,
  onOpenStage,
}: PhaseLanesProps) {
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const visiblePhases = visibleWorkflowPhases(phases);

  const sortedPhases = visiblePhases;

  // Match the graph's colorByPath: sorted-index → paletteColorForIndex
  const phaseColorByPath: Record<string, string> = {};
  sortedPhases.forEach((p, i) => {
    phaseColorByPath[p.path] = paletteColorForIndex(i);
  });

  const visiblePlacements = placements.filter(
    (placement) => stagesById[placement.stageId]?.phase !== 'initialization',
  );

  const placementsByPhase = (phasePath: string | null) =>
    visiblePlacements
      .filter((p) => {
        const displayPath = displayPhasePathForPlacement(p, phases, stagesById);
        return phasePath === null ? !displayPath : displayPath === phasePath;
      })
      .toSorted((a, b) => a.order - b.order);

  const placedStageIdSet = new Set(visiblePlacements.map((p) => p.stageId));

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
      <div className="flex flex-row gap-2 overflow-x-auto pb-2">
        {sortedPhases.map((phase, visibleIndex) => {
          const depth = phase.path.split('.').length - 1;
          const key = laneKey(phase.path);
          const lanePlacements = placementsByPhase(phase.path);
          const isOver = dragOverPath === key;

          return (
            <div
              key={phase.path}
              data-phase-id={phase.phaseId}
              data-phase-path={phase.path}
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
              <div
                className="flex items-center gap-1.5 p-2 border-b rounded-t-lg"
                style={{ backgroundColor: `${phaseColorByPath[phase.path]}18` }}
              >
                {depth > 0 && (
                  <span className="text-[9px] text-muted-foreground select-none">
                    {'└'.repeat(depth)}
                  </span>
                )}
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                  {String(visibleIndex + 1).padStart(2, '0')}
                </span>
                <EditablePhaseName
                  phasePath={phase.path}
                  name={phase.name}
                  readOnly={readOnly}
                  editing={editingPhasePath === phase.path}
                  onStartEdit={onStartPhaseRename}
                  onCancelEdit={onCancelPhaseRename}
                  onCommitEdit={onRenamePhase}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 ml-auto shrink-0"
                  onClick={() => onRemovePhase(phase.path)}
                  disabled={readOnly}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
              <div
                className="flex-1 p-1.5 flex flex-col gap-1 min-h-[80px] rounded-b-lg"
                style={{ backgroundColor: `${phaseColorByPath[phase.path]}08` }}
              >
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
                    unwired={isUnwired(p)}
                    forEach={
                      typeof stagesById[p.stageId]?.forEach === 'string'
                        ? (stagesById[p.stageId]?.forEach as string)
                        : null
                    }
                    execution={
                      typeof stagesById[p.stageId]?.execution === 'string'
                        ? (stagesById[p.stageId]?.execution as string)
                        : null
                    }
                    branchIssues={branchIssues[p.stageId] ?? []}
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
                isOver ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'
              }`}
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={(e) => handleDragLeave(e, key)}
              onDrop={(e) => handleDrop(e, null)}
            >
              <div className="flex items-center gap-1.5 p-2 border-b border-dashed bg-muted/40 rounded-t-lg">
                <span className="text-xs font-medium text-muted-foreground">Unphased</span>
                <span className="ml-auto flex items-center gap-1">
                  {visiblePhases.length === 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={onApplySkeleton}
                      disabled={readOnly}
                    >
                      <Layers className="h-3 w-3" />
                      Skeleton
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => void onAddPhase()}
                    disabled={readOnly}
                  >
                    <Plus className="h-3 w-3" />
                    Add phase
                  </Button>
                </span>
              </div>
              <div className="flex-1 p-1.5 flex flex-col gap-1 min-h-[80px] bg-muted/15 rounded-b-lg">
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
                    unwired={isUnwired(p)}
                    forEach={
                      typeof stagesById[p.stageId]?.forEach === 'string'
                        ? (stagesById[p.stageId]?.forEach as string)
                        : null
                    }
                    execution={
                      typeof stagesById[p.stageId]?.execution === 'string'
                        ? (stagesById[p.stageId]?.execution as string)
                        : null
                    }
                    branchIssues={branchIssues[p.stageId] ?? []}
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

function EditablePhaseName({
  phasePath,
  name,
  readOnly,
  editing,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
}: {
  phasePath: string;
  name: string;
  readOnly: boolean;
  editing: boolean;
  onStartEdit: (path: string) => void;
  onCancelEdit: () => void;
  onCommitEdit: (path: string, name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape unmounts the input, which fires a browser blur whose closure still
  // holds the pre-cancel draft — this ref stops that blur from committing it.
  const cancelledRef = useRef(false);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [editing]);

  if (editing && !readOnly) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 min-w-0 text-xs font-medium"
        onBlur={() => {
          if (cancelledRef.current) {
            cancelledRef.current = false;
            return;
          }
          onCommitEdit(phasePath, draft.trim() || name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelledRef.current = true;
            setDraft(name);
            onCancelEdit();
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="min-w-0 truncate text-left text-xs font-medium"
      onClick={() => onStartEdit(phasePath)}
      disabled={readOnly}
    >
      {name}
    </button>
  );
}

function PlacementChip({
  stageId,
  label,
  readOnly,
  autonomyLevel,
  unwired,
  forEach,
  execution,
  branchIssues = [],
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
  unwired?: boolean;
  forEach?: string | null;
  execution?: string | null;
  branchIssues?: string[];
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
        role="button"
        tabIndex={0}
        title="Open stage"
        onClick={() => onOpenStage()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenStage();
          }
        }}
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
          {unwired && (
            <span
              className="inline-flex items-center gap-1 shrink-0"
              title="Not wired to EXECUTE in any scope — this stage will never run. Enable it in the scope matrix below."
            >
              <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />
              <span className="text-[10px] text-amber-600 dark:text-amber-500">
                No scope — never runs
              </span>
            </span>
          )}
          {forEach === 'unit-of-work' && (
            <span
              className="inline-flex items-center gap-1 shrink-0"
              title={
                branchIssues.length > 0 ? branchIssues.join('\n') : 'Runs once per unit of work'
              }
            >
              <GitBranch className="h-2.5 w-2.5 text-primary" />
              <span className="text-[10px] text-primary">
                Unit branch{execution ? ` · ${execution}` : ''}
              </span>
            </span>
          )}
          {forEach && forEach !== 'unit-of-work' && (
            <span className="inline-flex items-center gap-1 shrink-0">
              <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />
              <span className="text-[10px] text-amber-600 dark:text-amber-500">
                Unsupported branch: {forEach}
              </span>
            </span>
          )}
          {branchIssues.map((issue) => (
            <span key={issue} className="inline-flex items-center gap-1 shrink-0">
              <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />
              <span className="text-[10px] text-amber-600 dark:text-amber-500">{issue}</span>
            </span>
          ))}
        </div>

        <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="hover:text-destructive p-1 rounded hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            disabled={readOnly}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {dropEdge === 'bottom' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full translate-y-0.5 z-10" />
      )}
    </div>
  );
}
