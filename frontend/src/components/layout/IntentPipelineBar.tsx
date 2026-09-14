import { useMemo, useState } from 'react';
import { Check, Circle, LoaderCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useIntent } from '@/contexts/IntentContext';
import { ScopeBadge } from '@/components/intent/ScopeBadge';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import type { IntentSection } from '@/lib/intentSectionPreference';
import type { IntentStage } from '@/services/intents';

export function detectSection(pathname: string): IntentSection {
  if (pathname.endsWith('/graph')) return 'graph';
  if (pathname.endsWith('/observability') || pathname.endsWith('/audit')) return 'overview';
  return 'work';
}

type StepState = 'done' | 'running' | 'failed' | 'pending';

function stepState(rows: IntentStage[]): StepState {
  if (rows.length === 0) return 'pending';
  if (rows.some((row) => row.state === 'RUNNING' || row.state === 'WAITING_FOR_HUMAN')) {
    return 'running';
  }
  if (rows.some((row) => row.state === 'FAILED')) return 'failed';
  if (rows.every((row) => row.state === 'SUCCEEDED' || row.state === 'SKIPPED')) return 'done';
  return 'pending';
}

export function IntentPhaseBreadcrumb({
  onOpenScopeDefinition,
}: {
  onOpenScopeDefinition?: () => void;
}) {
  const {
    detail,
    compiled,
    phaseNameOf,
    initializationPhasePaths,
    workflowPhases,
    currentPhasePath,
  } = useIntent();
  const [openPhase, setOpenPhase] = useState<string | null>(null);

  const phases = useMemo(() => {
    if (!detail || !compiled || !workflowPhases) return [];
    const intent = detail.intent;
    const rowsByStage = new Map<string, IntentStage[]>();
    for (const row of detail.stages) {
      if (!row.stageId) continue;
      const rows = rowsByStage.get(row.stageId) ?? [];
      rows.push(row);
      rowsByStage.set(row.stageId, rows);
    }

    const selection = getIntentStageSelection(intent, compiled, initializationPhasePaths);
    const selected = selection.selected.toSorted((a, b) => a.order - b.order);
    const allByPhase = new Map<string, number>();
    for (const node of selection.available) {
      const phase = node.phasePath ?? '(ungrouped)';
      allByPhase.set(phase, (allByPhase.get(phase) ?? 0) + 1);
    }

    const groups = new Map<
      string,
      {
        phase: string;
        steps: { stageId: string; state: StepState }[];
        excluded: number;
      }
    >();
    for (const node of selected) {
      const phase = node.phasePath ?? '(ungrouped)';
      const group = groups.get(phase) ?? { phase, steps: [], excluded: 0 };
      group.steps.push({
        stageId: node.stageId,
        state: stepState(rowsByStage.get(node.stageId) ?? []),
      });
      groups.set(phase, group);
    }
    for (const group of groups.values()) {
      group.excluded = Math.max(
        0,
        (allByPhase.get(group.phase) ?? group.steps.length) - group.steps.length,
      );
    }
    return [...groups.values()];
  }, [compiled, detail, initializationPhasePaths, workflowPhases]);

  const intent = detail?.intent;
  if (intent && (!compiled || !workflowPhases)) {
    return (
      <div
        className="space-y-2"
        data-testid="intent-phase-breadcrumb-placeholder"
        aria-hidden="true"
      >
        {intent.scope && <Skeleton className="h-4 w-24 rounded-full" />}
        <Skeleton className="h-12 w-full rounded-none" />
      </div>
    );
  }
  if (!intent || phases.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="intent-phase-breadcrumb">
      {intent.scope && (
        <div className="flex items-center">
          <ScopeBadge scope={intent.scope} className="px-2 py-0 text-[10px]" />
        </div>
      )}
      <div
        className="flex w-full overflow-x-auto pr-4"
        data-testid="intent-phase-breadcrumb-scroll"
      >
        {phases.map((group, index) => {
          const done = group.steps.filter((step) => step.state === 'done').length;
          const running = group.steps.filter((step) => step.state === 'running').length;
          const failed = group.steps.filter((step) => step.state === 'failed').length;
          const pending = group.steps.filter((step) => step.state === 'pending').length;
          const active =
            group.steps.length > 0 &&
            (group.phase === currentPhasePath || running > 0 || failed > 0);
          const complete = done === group.steps.length && group.steps.length > 0;
          const open = openPhase === group.phase;

          return (
            <Popover
              key={group.phase}
              open={open}
              onOpenChange={(next) => setOpenPhase(next ? group.phase : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'group relative flex min-h-12 min-w-48 flex-1 items-center gap-2.5 px-8 py-2 text-left transition-[filter] focus-visible:outline-none',
                    index > 0 && '-ml-4',
                    complete && 'bg-agent-success/10 text-agent-success',
                    failed > 0 && !complete && 'bg-destructive/10 text-destructive',
                    active && failed === 0 && !complete && 'bg-agent-running/10 text-agent-running',
                    !active && !complete && 'bg-muted text-muted-foreground',
                    open && 'brightness-[0.97]',
                  )}
                  style={{
                    clipPath:
                      index === 0
                        ? 'polygon(0 0, calc(100% - 18px) 0, 100% 50%, calc(100% - 18px) 100%, 0 100%)'
                        : 'polygon(0 0, calc(100% - 18px) 0, 100% 50%, calc(100% - 18px) 100%, 0 100%, 18px 50%)',
                  }}
                >
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-full bg-background/80',
                      'group-focus-visible:ring-2 group-focus-visible:ring-current group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-transparent',
                      open && 'ring-2 ring-current ring-offset-2 ring-offset-transparent',
                    )}
                  >
                    {complete ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : failed > 0 ? (
                      <XCircle className="h-3.5 w-3.5" />
                    ) : active ? (
                      <span className="h-2 w-2 rounded-full bg-current" />
                    ) : (
                      <Circle className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold">
                      {phaseNameOf(group.phase)}
                    </span>
                    <span className="block text-[10px] font-medium opacity-80">
                      {done}/{group.steps.length} selected stages
                    </span>
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-0">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">{phaseNameOf(group.phase)}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {done} resolved · {running} running
                    {failed > 0 && ` · ${failed} failed`} · {pending} pending
                  </p>
                </div>
                <div className="space-y-1 bg-muted/30 p-2">
                  {group.steps.map((step) => (
                    <div
                      key={step.stageId}
                      className="flex items-center gap-2 rounded-md bg-background px-2.5 py-2 text-xs"
                    >
                      {step.state === 'done' ? (
                        <Check className="h-3.5 w-3.5 text-agent-success" />
                      ) : step.state === 'running' ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-agent-running" />
                      ) : step.state === 'failed' ? (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {humanizeStageId(step.stageId)}
                      </span>
                      <span
                        className={cn(
                          'capitalize text-muted-foreground',
                          step.state === 'failed' && 'text-destructive',
                        )}
                      >
                        {step.state}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[11px] text-muted-foreground">
                  <span>
                    {group.excluded > 0
                      ? `${group.excluded} ${group.excluded === 1 ? 'stage is' : 'stages are'} outside this selection.`
                      : 'All workflow stages in this phase are selected.'}
                  </span>
                  {group.excluded > 0 && onOpenScopeDefinition && (
                    <button
                      type="button"
                      className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline"
                      onClick={() => {
                        setOpenPhase(null);
                        onOpenScopeDefinition();
                      }}
                    >
                      Scope definition
                    </button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          );
        })}
      </div>
    </div>
  );
}
