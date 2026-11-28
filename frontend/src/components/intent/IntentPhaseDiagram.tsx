import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { stageRowKey, useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { displayStageName } from '@/lib/displayNames';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import { TONE_CLASSES, getStatus } from '@/lib/statusModel';
import { cn } from '@/lib/utils';
import type { StageState } from '@/services/intents';
import type { CompiledWorkflow } from '@/services/workflows';
import { GitBranch } from 'lucide-react';

const WorkflowScopeGraph = lazy(() =>
  import('@/components/v2/WorkflowScopeGraph').then((m) => ({ default: m.WorkflowScopeGraph })),
);

const STAGE_STATE_ORDER: StageState[] = [
  'RUNNING',
  'WAITING_FOR_HUMAN',
  'FAILED',
  'SUCCEEDED',
  'SKIPPED',
  'PENDING',
];

// The unit chooser lists the units that need attention first: failed, then
// waiting, then running, then finished.
const CHOOSER_ORDER: StageState[] = [
  'FAILED',
  'WAITING_FOR_HUMAN',
  'RUNNING',
  'SUCCEEDED',
  'SKIPPED',
  'PENDING',
];

const DONE_STATES = new Set<StageState>(['SUCCEEDED', 'SKIPPED']);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface StageDependenciesSheetProps {
  /** The dependency graph (WorkflowScopeGraph), rendered only while open. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel?: string;
  className?: string;
}

// Full-width, bottom-anchored sheet for the stage dependency graph (O6). The
// summary counts only the stages in this run's plan — the same denominator as
// the "Stages run" stat — and the legend names only the states actually
// present, with the shared status tones rather than phase colours.
export function StageDependenciesSheet({
  children,
  open: openProp,
  onOpenChange,
  triggerLabel = 'View stage dependencies',
  className,
}: StageDependenciesSheetProps) {
  const { stageRows, compiled, detail, initializationPhasePaths } = useIntent();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const { done, total, outOfScope, presentStates } = useMemo(() => {
    const inRun = new Set(stageRows.map((r) => r.stageId));
    const outOfScope =
      detail && compiled
        ? getIntentStageSelection(
            detail.intent,
            compiled,
            initializationPhasePaths,
          ).available.filter((n) => !inRun.has(n.stageId)).length
        : 0;
    const planned = stageRows.filter(
      (r) => r.planned && !initializationPhasePaths.has(r.phase ?? ''),
    );
    const present = new Set(stageRows.map((r) => r.state));
    return {
      done: planned.filter((r) => DONE_STATES.has(r.state)).length,
      total: planned.length,
      outOfScope,
      presentStates: STAGE_STATE_ORDER.filter((state) => present.has(state)),
    };
  }, [compiled, detail, initializationPhasePaths, stageRows]);

  const summary = [
    total > 0 ? `${done} of ${plural(total, 'stage')} completed` : null,
    outOfScope > 0 ? `${plural(outOfScope, 'stage')} not selected` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={className}>
          <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="flex max-h-[85vh] flex-col gap-4 overflow-hidden">
        <SheetHeader className="pr-8 text-left">
          <SheetTitle>Stage dependencies</SheetTitle>
          <SheetDescription>{summary || 'No stages resolved yet.'}</SheetDescription>
        </SheetHeader>
        {presentStates.length > 0 && (
          <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            {presentStates.map((state) => {
              const entry = getStatus('stage', state);
              return (
                <li key={state} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-flex h-4 w-4 items-center justify-center rounded-full',
                      TONE_CLASSES[entry.tone].pill,
                    )}
                  >
                    <entry.icon className="h-3 w-3" />
                  </span>
                  <span className="text-muted-foreground">{entry.label}</span>
                </li>
              );
            })}
            {outOfScope > 0 && (
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-4 rounded-sm border border-dashed border-muted-foreground/60 bg-muted/40"
                />
                <span className="text-muted-foreground">Not selected</span>
              </li>
            )}
          </ul>
        )}
        <div className="min-h-0 flex-1 overflow-auto [&_svg]:min-w-[720px]">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

// One status per stage node: a fan-out stage has one row per unit lane, and
// the graph shows the worst of them.
function aggregateStageStatus(rows: IntentStageRow[]): Record<string, StageState> {
  const byStage = new Map<string, StageState[]>();
  for (const row of rows) {
    const list = byStage.get(row.stageId) ?? [];
    list.push(row.state);
    byStage.set(row.stageId, list);
  }
  const result: Record<string, StageState> = {};
  for (const [stageId, states] of byStage) {
    if (states.includes('FAILED')) result[stageId] = 'FAILED';
    else if (states.includes('RUNNING')) result[stageId] = 'RUNNING';
    else if (states.includes('WAITING_FOR_HUMAN')) result[stageId] = 'WAITING_FOR_HUMAN';
    else if (states.every((s) => DONE_STATES.has(s))) result[stageId] = 'SUCCEEDED';
    else result[stageId] = 'PENDING';
  }
  return result;
}

function scopeCompiledToRun(
  compiled: CompiledWorkflow,
  stageRows: IntentStageRow[],
  hidden: Set<string>,
): CompiledWorkflow {
  const ids = new Set(stageRows.map((r) => r.stageId));
  const keep = (id: string) => ids.has(id) && !hidden.has(id);
  return {
    ...compiled,
    graph: {
      ...compiled.graph,
      nodes: compiled.graph.nodes.filter((n) => keep(n.stageId)),
      edges: compiled.graph.edges.filter((e) => keep(e.from) && keep(e.to)),
    },
  };
}

// The Overview's dependency view: the compiled graph restricted to this run's
// stages (workspace initialization left out — it is plumbing, not method),
// coloured by live status, labelled with human stage names. Clicking a node
// selects that stage in the list and closes the sheet. Open state lives per
// intent, so it never leaks from one intent to the next.
export function IntentStageDependencies({ className }: { className?: string }) {
  const {
    intentId,
    compiled,
    detail,
    stageRows,
    workflowPhases,
    initializationPhasePaths,
    phaseNameOf,
    setSelectedStageId,
  } = useIntent();
  const [open, setOpen] = useState(false);
  // A fan-out stage is one node for every unit lane: clicking it asks which
  // unit to open instead of guessing, since the lanes can differ (one failed).
  const [choice, setChoice] = useState<{ stageId: string; rows: IntentStageRow[] } | null>(null);
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setChoice(null);
  }, []);

  const initStageIds = useMemo(
    () =>
      new Set(
        (compiled?.graph.nodes ?? [])
          .filter((n) => n.phasePath && initializationPhasePaths.has(n.phasePath))
          .map((n) => n.stageId),
      ),
    [compiled, initializationPhasePaths],
  );

  const scoped = useMemo(
    () => (compiled ? scopeCompiledToRun(compiled, stageRows, initStageIds) : null),
    [compiled, stageRows, initStageIds],
  );

  const stageStatus = useMemo(() => {
    const all = aggregateStageStatus(stageRows);
    for (const id of initStageIds) delete all[id];
    return all;
  }, [stageRows, initStageIds]);

  const phases = useMemo(() => {
    if (!workflowPhases) return undefined;
    const used = new Set((scoped?.graph.nodes ?? []).map((n) => n.phasePath));
    return workflowPhases
      .filter((p) => used.has(p.path))
      .map((p) => ({ path: p.path, name: phaseNameOf(p.path) }));
  }, [workflowPhases, scoped, phaseNameOf]);

  const stageMeta = useMemo(() => {
    const meta: Record<string, { number: string; name: string; phase: string }> = {};
    for (const node of scoped?.graph.nodes ?? []) {
      meta[node.stageId] = {
        number: '',
        name: displayStageName(node.stageId),
        phase: node.phasePath ? phaseNameOf(node.phasePath) : '',
      };
    }
    return meta;
  }, [scoped, phaseNameOf]);

  const openRow = useCallback(
    (row: IntentStageRow) => {
      setSelectedStageId(stageRowKey(row));
      changeOpen(false);
    },
    [setSelectedStageId, changeOpen],
  );

  const handleStageClick = useCallback(
    (stageId: string) => {
      const rows = stageRows.filter((r) => r.stageId === stageId);
      if (rows.length === 0) return;
      if (rows.length === 1) return openRow(rows[0]);
      setChoice({
        stageId,
        rows: rows.toSorted(
          (a, b) => CHOOSER_ORDER.indexOf(a.state) - CHOOSER_ORDER.indexOf(b.state),
        ),
      });
    },
    [stageRows, openRow],
  );

  // The chooser opens above a possibly tall graph: move focus to its first
  // option so the click visibly did something (and a screen reader hears it).
  const chooserRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (choice) chooserRef.current?.querySelector('button')?.focus();
  }, [choice]);

  return (
    <StageDependenciesSheet
      key={intentId}
      open={open}
      onOpenChange={changeOpen}
      className={className}
    >
      {choice && (
        <div
          ref={chooserRef}
          role="group"
          aria-label={`Choose a unit for ${displayStageName(choice.stageId)}`}
          className="mb-3 rounded-md border bg-muted/30 p-3"
        >
          <p className="text-sm">
            {displayStageName(choice.stageId)} ran for {plural(choice.rows.length, 'unit')}. Choose
            the one to open.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {choice.rows.map((row, index) => (
              <li key={stageRowKey(row)}>
                <Button type="button" variant="outline" size="sm" onClick={() => openRow(row)}>
                  {row.unitSlug ? displayStageName(row.unitSlug) : `Run ${index + 1}`}
                  <StatusPill kind="stage" status={row.state} size="xs" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {scoped && scoped.graph.nodes.length > 0 ? (
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading dependencies…
            </p>
          }
        >
          <WorkflowScopeGraph
            compiled={scoped}
            activeScope={detail?.intent.scope ?? undefined}
            phases={phases}
            stageMeta={stageMeta}
            stageStatus={stageStatus}
            onStageClick={handleStageClick}
            edgesOnFocus
            hideScopeSelector
            hideLegend
            hideSummary
            readOnly
          />
        </Suspense>
      ) : (
        <p className="text-sm text-muted-foreground">No graph data yet.</p>
      )}
    </StageDependenciesSheet>
  );
}
