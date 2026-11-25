import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Circle, LoaderCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { withInferredFailure } from '@/components/intent/inferredFailure';
import { displayStageName } from '@/lib/displayNames';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import type { IntentSection } from '@/lib/intentSectionPreference';

export function detectSection(pathname: string): IntentSection {
  if (pathname.endsWith('/graph')) return 'graph';
  if (pathname.endsWith('/observability') || pathname.endsWith('/audit')) return 'overview';
  return 'work';
}

type StepState = 'done' | 'running' | 'failed' | 'pending';

function stepState(rows: Pick<IntentStageRow, 'state'>[]): StepState {
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
    stageRows,
    phaseNameOf,
    initializationPhasePaths,
    workflowPhases,
    currentPhasePath,
  } = useIntent();
  const [openPhase, setOpenPhase] = useState<string | null>(null);

  const phases = useMemo(() => {
    if (!detail || !compiled || !workflowPhases) return [];
    const intent = detail.intent;
    // Same rows, same inferred failure as the stage list: a run that failed
    // before its stage got a row still paints that stage (and its phase) red.
    const liveRows = withInferredFailure(stageRows, intent, detail.events ?? []);
    const rowsByStage = new Map<string, IntentStageRow[]>();
    for (const row of liveRows) {
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
  }, [compiled, detail, initializationPhasePaths, stageRows, workflowPhases]);

  // Below `sm` the chevrons overflow a 390 px screen: bring the phase that
  // matters into view once, and fade whichever edge still hides phases.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const phaseKey = phases.map((group) => group.phase).join('\u0000');
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const start = scroller.scrollLeft > 8;
      const end = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 8;
      setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    const active = scroller.querySelector<HTMLElement>('[data-active="true"]');
    if (active && scroller.scrollWidth > scroller.clientWidth) {
      // Horizontal only: scrollIntoView would also drag the page vertically.
      const offset =
        active.getBoundingClientRect().left -
        scroller.getBoundingClientRect().left +
        scroller.scrollLeft;
      scroller.scrollLeft = Math.max(
        0,
        offset - (scroller.clientWidth - active.getBoundingClientRect().width) / 2,
      );
    }
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [phaseKey]);

  const intent = detail?.intent;
  const terminal =
    intent?.status === 'SUCCEEDED' || intent?.status === 'FAILED' || intent?.status === 'CANCELLED';
  if (intent && (!compiled || !workflowPhases)) {
    return (
      <Skeleton
        className="h-12 w-full rounded-none"
        data-testid="intent-phase-breadcrumb-placeholder"
      />
    );
  }
  if (!intent || phases.length === 0) return null;

  return (
    <div data-testid="intent-phase-breadcrumb">
      <div
        ref={scrollerRef}
        className={cn(
          'flex w-full overflow-x-auto pr-4',
          fade.start &&
            fade.end &&
            '[mask-image:linear-gradient(to_right,transparent,black_2.5rem,black_calc(100%-2.5rem),transparent)]',
          fade.start &&
            !fade.end &&
            '[mask-image:linear-gradient(to_right,transparent,black_2.5rem)]',
          !fade.start &&
            fade.end &&
            '[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]',
        )}
        data-testid="intent-phase-breadcrumb-scroll"
        data-fade-start={fade.start || undefined}
        data-fade-end={fade.end || undefined}
      >
        {phases.map((group, index) => {
          const done = group.steps.filter((step) => step.state === 'done').length;
          const running = group.steps.filter((step) => step.state === 'running').length;
          const failed = group.steps.filter((step) => step.state === 'failed').length;
          const pending = group.steps.filter((step) => step.state === 'pending').length;
          const failedStage = group.steps.find((step) => step.state === 'failed') ?? null;
          const complete = done === group.steps.length && group.steps.length > 0;
          const current =
            group.steps.length > 0 &&
            (group.phase === currentPhasePath || running > 0 || failed > 0);
          // A finished run has no phase "in progress": its unfinished phases
          // read neutral — "stopped" where work started, "not run" otherwise.
          const active = current && (!terminal || failed > 0);
          const halted = terminal && !complete && failed === 0;
          const stopped = halted && done > 0;
          const open = openPhase === group.phase;
          const progress = `${done} of ${group.steps.length} ${group.steps.length === 1 ? 'stage' : 'stages'}`;
          const subtitle =
            failedStage && !complete
              ? `Failed at ${displayStageName(failedStage.stageId)}`
              : halted
                ? `${progress} · ${stopped ? 'stopped' : 'not run'}`
                : `${progress} done`;

          return (
            <Popover
              key={group.phase}
              open={open}
              onOpenChange={(next) => setOpenPhase(next ? group.phase : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-active={current || undefined}
                  data-state={
                    complete
                      ? 'done'
                      : failed > 0
                        ? 'failed'
                        : stopped
                          ? 'stopped'
                          : active
                            ? 'active'
                            : 'pending'
                  }
                  className={cn(
                    'group relative flex min-h-12 min-w-52 flex-1 items-center gap-2.5 px-8 py-2 text-left transition-[filter] focus-visible:outline-none',
                    index > 0 && '-ml-4',
                    complete && 'bg-agent-success/10 text-agent-success-fg',
                    failed > 0 && !complete && 'bg-agent-error/15 text-agent-error-fg',
                    active &&
                      failed === 0 &&
                      !complete &&
                      'bg-agent-running/10 text-agent-running-fg',
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
                    {/* One line: the bar scrolls before a count wraps mid-phrase ("0 of 7 stages / done"). */}
                    <span
                      className="block truncate whitespace-nowrap text-2xs font-medium"
                      title={
                        failedStage && !complete
                          ? subtitle
                          : `${done} of ${group.steps.length} stages in scope ${done === 1 ? 'is' : 'are'} done`
                      }
                    >
                      {subtitle}
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
                        <XCircle className="h-3.5 w-3.5 text-agent-error-fg" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {humanizeStageId(step.stageId)}
                      </span>
                      <span
                        className={cn(
                          'capitalize text-muted-foreground',
                          step.state === 'failed' && 'text-agent-error-fg',
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
