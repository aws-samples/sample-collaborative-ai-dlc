import { useMemo } from 'react';
import { useIntent } from '@/contexts/IntentContext';
import { groupByPhase, derivePhaseState } from '@/lib/intentPhases';
import { PHASE_CONFIGS } from '@/components/observability/phaseConfig';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

function phaseColorAt(index: number) {
  const cfg = PHASE_CONFIGS[index % PHASE_CONFIGS.length];
  return {
    headerBg: cfg.headerBg,
    headerText: cfg.headerText,
    blockBg: cfg.blockBg,
    blockBorder: cfg.blockBorder,
    mandatoryBg: cfg.mandatoryBg,
    conditionalBg: cfg.conditionalBg,
  };
}

export function IntentPhaseDiagram() {
  const { stageRows, initializationPhasePaths, detail, compiled, workflowPhases } = useIntent();
  const currentPhase = detail?.intent.currentPhase ?? null;

  // The plan (compiled) and the phase names (workflow) land after the intent
  // DTO — rendering before both arrive flashes a partial phase list.
  const planReady = !!compiled && !!workflowPhases;

  const phases = useMemo(
    () =>
      planReady
        ? groupByPhase(stageRows).filter((g) => !initializationPhasePaths.has(g.phase))
        : [],
    [planReady, stageRows, initializationPhasePaths],
  );

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
        const state = derivePhaseState(group, currentPhase);
        const isActive = state === 'active';
        const palette = phaseColorAt(idx);
        const pct = group.total > 0 ? Math.round((group.done / group.total) * 100) : 0;

        return (
          <div
            key={group.phase}
            className={cn(
              'rounded-lg border-2 overflow-hidden transition-all',
              palette.blockBorder,
              palette.blockBg,
              isActive && 'ring-2 ring-offset-1 ring-offset-background ring-agent-running/50',
              !isActive && 'opacity-75',
            )}
          >
            {/* Header row — v1 PhaseBlock style */}
            <div className={cn('flex items-center gap-2 px-3', isActive ? 'py-1.5' : 'py-1')}>
              {state === 'done' && (
                <span className="h-2 w-2 rounded-full bg-agent-success shrink-0" />
              )}
              {state === 'active' && (
                <span className="h-2.5 w-2.5 rounded-full bg-agent-running animate-pulse shrink-0" />
              )}
              {state === 'pending' && (
                <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
              )}
              <span
                className={cn(
                  'font-bold tracking-wider uppercase',
                  palette.headerText,
                  isActive ? 'text-xs' : 'text-[10px]',
                )}
              >
                {group.phase}
              </span>
              <span
                className={cn(
                  'ml-auto font-medium text-muted-foreground',
                  isActive ? 'text-[10px]' : 'text-[9px]',
                )}
              >
                {group.done}/{group.total}
              </span>
              <Progress
                value={pct}
                className={cn(
                  'w-14',
                  isActive ? 'h-1.5' : 'h-1',
                  state === 'done' && '[&>div]:bg-agent-success',
                  state === 'active' && '[&>div]:bg-agent-running',
                )}
              />
            </div>

            {/* Stage chips — flex-wrap kanban */}
            <div
              className={cn(
                'flex flex-wrap items-center gap-1',
                isActive ? 'p-2.5' : 'px-2 py-1.5',
              )}
            >
              {group.rows.map((row, rowIdx) => {
                const chipState = row.state;
                const isDone = chipState === 'SUCCEEDED';
                const isSkipped = chipState === 'SKIPPED';
                const isRunning = chipState === 'RUNNING';
                const isWaiting = chipState === 'WAITING_FOR_HUMAN';
                const isFailed = chipState === 'FAILED';

                return (
                  <div
                    key={`${row.stageId}-${row.stageInstanceId ?? rowIdx}`}
                    className="flex items-center gap-1"
                  >
                    {rowIdx > 0 && isActive && (
                      <span className="text-muted-foreground/30 text-[10px]">→</span>
                    )}
                    <div
                      className={cn(
                        'relative flex flex-col items-center justify-center rounded-md border-2 text-center transition-all',
                        isActive ? 'px-2.5 py-1.5 min-w-[90px]' : 'px-1.5 py-1 min-w-[70px]',
                        isDone &&
                          'bg-green-100 dark:bg-green-900/50 border-green-500 dark:border-green-500',
                        isSkipped &&
                          'opacity-30 grayscale border-dashed border-muted-foreground/40',
                        isRunning &&
                          'ring-2 ring-agent-running ring-offset-1 ring-offset-background border-agent-running/40',
                        isWaiting &&
                          'ring-2 ring-amber-400 ring-offset-1 ring-offset-background border-amber-400/40',
                        isFailed && 'border-agent-error/60 bg-red-50 dark:bg-red-900/20',
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
                      )}
                    >
                      <span
                        className={cn(
                          'font-semibold leading-tight',
                          isActive ? 'text-[11px]' : 'text-[10px]',
                          isDone
                            ? 'text-green-800 dark:text-green-200'
                            : isSkipped
                              ? 'line-through text-muted-foreground'
                              : isFailed
                                ? 'text-agent-error'
                                : 'text-foreground/80',
                        )}
                      >
                        {row.stageId}
                      </span>
                      <span
                        className={cn(
                          'font-bold uppercase tracking-wider mt-0.5',
                          isActive ? 'text-[9px]' : 'text-[8px]',
                          isDone && 'text-green-600 dark:text-green-400',
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
                          ? '✓ Done'
                          : isSkipped
                            ? '— Skipped'
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
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
