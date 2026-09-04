import { useMemo, useState } from 'react';
import { useIntent, stageRowKey, type IntentStageRow } from '@/contexts/IntentContext';
import { groupByPhase, derivePhaseState } from '@/lib/intentPhases';
import { phaseColorAt } from '@/components/observability/phaseConfig';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { Check, ChevronRight } from 'lucide-react';

export function IntentPhaseDiagram() {
  const {
    stageRows,
    initializationPhasePaths,
    compiled,
    workflowPhases,
    currentPhasePath,
    phaseNameOf,
    selectedStageId,
    setSelectedStageId,
  } = useIntent();

  const planReady = !!compiled && !!workflowPhases;

  const phases = useMemo(
    () =>
      planReady
        ? groupByPhase(stageRows).filter((g) => !initializationPhasePaths.has(g.phase))
        : [],
    [planReady, stageRows, initializationPhasePaths],
  );

  const [expandedManual, setExpandedManual] = useState<Record<string, boolean>>({});

  if (!planReady) {
    return (
      <div className="space-y-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (phases.length === 0) {
    return <p className="text-sm text-muted-foreground">No phases resolved yet.</p>;
  }

  return (
    <div className="space-y-2">
      {phases.map((group, idx) => {
        const state = derivePhaseState(group, currentPhasePath);
        const isActive = state === 'active';
        const palette = phaseColorAt(idx);
        const pct = group.total > 0 ? Math.round((group.done / group.total) * 100) : 0;
        const isExpanded = expandedManual[group.phase] ?? isActive;

        return (
          <div
            key={group.phase}
            className={cn(
              'rounded-lg border-2 overflow-hidden transition-all',
              palette.blockBorder,
              palette.blockBg,
              isActive && 'ring-2 ring-offset-1 ring-offset-background ring-agent-running/50',
              !isActive && !isExpanded && 'opacity-70',
            )}
          >
            {isActive ? (
              <div
                className={cn(
                  'flex w-full items-center gap-2 px-3 text-left transition-colors',
                  'py-1.5',
                )}
              >
                <span className="relative flex h-3 w-3 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent-running opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-agent-running" />
                </span>
                <span
                  className={cn(
                    'font-bold tracking-wider uppercase',
                    palette.headerText,
                    'text-sm',
                  )}
                >
                  {phaseNameOf(group.phase)}
                </span>
                <span className={cn('ml-auto font-medium text-muted-foreground', 'text-[11px]')}>
                  {group.done}/{group.total}
                </span>
                <Progress value={pct} className={cn('w-14 h-1.5', '[&>div]:bg-agent-running')} />
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpandedManual((prev) => ({ ...prev, [group.phase]: !isExpanded }));
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 text-left transition-colors',
                  'py-1.5 hover:bg-muted/20 cursor-pointer',
                )}
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200',
                    isExpanded && 'rotate-90',
                  )}
                />
                {state === 'done' && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-agent-success/20">
                    <Check className="h-2.5 w-2.5 text-agent-success" />
                  </span>
                )}
                {state === 'pending' && (
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                )}
                <span
                  className={cn(
                    'font-bold tracking-wider uppercase',
                    palette.headerText,
                    'text-[10px]',
                  )}
                >
                  {phaseNameOf(group.phase)}
                </span>
                <span className={cn('ml-auto font-medium text-muted-foreground', 'text-[10px]')}>
                  {group.done}/{group.total}
                </span>
                <Progress
                  value={pct}
                  className={cn('w-14 h-1', state === 'done' && '[&>div]:bg-agent-success')}
                />
              </button>
            )}

            {isExpanded && (
              <div className={cn(isActive ? 'p-2.5' : 'px-2 py-1.5')}>
                {(() => {
                  // Group by unit IN PLACE, preserving plan order. A fan-out
                  // section is a contiguous run of unit rows; collapse it into
                  // per-unit sub-rows so once-per-workflow stages before it
                  // (design) and after it (build & test) keep their position.
                  type Segment =
                    | { kind: 'flat'; rows: IntentStageRow[] }
                    | { kind: 'units'; order: string[]; byUnit: Map<string, IntentStageRow[]> };
                  const segments: Segment[] = [];
                  for (const row of group.rows) {
                    if (!row.unitSlug) {
                      const last = segments[segments.length - 1];
                      if (last?.kind === 'flat') last.rows.push(row);
                      else segments.push({ kind: 'flat', rows: [row] });
                      continue;
                    }
                    let last = segments[segments.length - 1];
                    if (last?.kind !== 'units') {
                      last = { kind: 'units', order: [], byUnit: new Map() };
                      segments.push(last);
                    }
                    if (!last.byUnit.has(row.unitSlug)) {
                      last.byUnit.set(row.unitSlug, []);
                      last.order.push(row.unitSlug);
                    }
                    last.byUnit.get(row.unitSlug)!.push(row);
                  }

                  const chipRow = (rows: IntentStageRow[], hideUnitSlug: boolean) => (
                    <div className="flex flex-wrap items-center gap-1">
                      {rows.map((row, rowIdx) => (
                        <div
                          key={`${row.stageId}-${row.stageInstanceId ?? rowIdx}`}
                          className="flex items-center gap-1"
                        >
                          {rowIdx > 0 && isActive && (
                            <span className="text-muted-foreground/30 text-[11px]">&rarr;</span>
                          )}
                          <StageChip
                            row={row}
                            isActive={isActive}
                            palette={palette}
                            selected={selectedStageId === stageRowKey(row)}
                            onToggle={() =>
                              setSelectedStageId(
                                selectedStageId === stageRowKey(row) ? null : stageRowKey(row),
                              )
                            }
                            hideUnitSlug={hideUnitSlug}
                          />
                        </div>
                      ))}
                    </div>
                  );

                  return (
                    <div className="space-y-2">
                      {segments.map((seg, si) =>
                        seg.kind === 'flat' ? (
                          <div key={si}>{chipRow(seg.rows, false)}</div>
                        ) : (
                          <div key={si} className="space-y-1.5">
                            {seg.order.map((slug) => (
                              <div key={slug} className="space-y-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                                  <span className="font-mono text-[10px] font-medium lowercase text-muted-foreground">
                                    {slug}
                                  </span>
                                  <span className="h-px flex-1 bg-border" />
                                </div>
                                {chipRow(seg.byUnit.get(slug)!, true)}
                              </div>
                            ))}
                          </div>
                        ),
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StageChip({
  row,
  isActive,
  palette,
  selected,
  onToggle,
  hideUnitSlug,
}: {
  row: IntentStageRow;
  isActive: boolean;
  palette: ReturnType<typeof phaseColorAt>;
  selected: boolean;
  onToggle: () => void;
  hideUnitSlug: boolean;
}) {
  const chipState = row.state;
  const isDone = chipState === 'SUCCEEDED';
  const isSkipped = chipState === 'SKIPPED';
  const isRunning = chipState === 'RUNNING';
  const isWaiting = chipState === 'WAITING_FOR_HUMAN';
  const isFailed = chipState === 'FAILED';

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'relative flex flex-col items-center justify-center rounded-md border-2 text-center transition-all',
        isActive ? 'px-2.5 py-1.5 min-w-[104px]' : 'px-1.5 py-1 min-w-[82px]',
        isDone && 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-400 dark:border-emerald-600',
        isSkipped && 'opacity-30 grayscale border-dashed border-muted-foreground/40',
        isRunning &&
          'ring-2 ring-agent-running ring-offset-1 ring-offset-background border-agent-running/50 bg-agent-running/5',
        isWaiting &&
          'ring-2 ring-amber-400 ring-offset-1 ring-offset-background border-amber-400/50 bg-amber-50 dark:bg-amber-950/30',
        isFailed && 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/30',
        !isDone &&
          !isSkipped &&
          !isRunning &&
          !isWaiting &&
          !isFailed &&
          'opacity-40 border-muted-foreground/30',
        !isDone &&
          !isSkipped &&
          !isRunning &&
          !isWaiting &&
          !isFailed &&
          palette.conditionalBg.split(' ')[0],
        selected && 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background',
      )}
    >
      <span
        className={cn(
          'font-semibold leading-tight',
          isActive ? 'text-xs' : 'text-[11px]',
          isDone
            ? 'text-emerald-800 dark:text-emerald-200'
            : isSkipped
              ? 'line-through text-muted-foreground'
              : isFailed
                ? 'text-agent-error'
                : 'text-foreground/80',
        )}
      >
        {row.stageId}
      </span>
      {row.unitSlug && !hideUnitSlug && (
        <span
          className={cn(
            'mt-0.5 max-w-[96px] truncate font-mono lowercase',
            isActive ? 'text-[10px]' : 'text-[9px]',
            isDone
              ? 'text-emerald-700 dark:text-emerald-300'
              : isFailed
                ? 'text-agent-error'
                : 'text-muted-foreground',
          )}
          title={row.unitSlug}
        >
          {row.unitSlug}
        </span>
      )}
      <span
        className={cn(
          'font-bold uppercase tracking-wider mt-0.5',
          isActive ? 'text-[10px]' : 'text-[9px]',
          isDone && 'text-emerald-600 dark:text-emerald-400',
          isSkipped && 'text-muted-foreground/50',
          isRunning && 'text-agent-running',
          isWaiting && 'text-amber-600 dark:text-amber-400',
          isFailed && 'text-agent-error',
          !isDone &&
            !isSkipped &&
            !isRunning &&
            !isWaiting &&
            !isFailed &&
            'text-muted-foreground/50',
        )}
      >
        {isDone
          ? '\u2713 Done'
          : isSkipped
            ? '\u2014 Skipped'
            : isRunning
              ? 'Running'
              : isWaiting
                ? 'Waiting'
                : isFailed
                  ? 'Failed'
                  : 'Pending'}
      </span>
      {(isRunning || isWaiting) && (
        <span
          className={cn(
            'absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full animate-ping',
            isRunning ? 'bg-agent-running' : 'bg-amber-400',
          )}
        />
      )}
    </button>
  );
}
