import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { useIntent, stageRowKey, type IntentStageRow } from '@/contexts/IntentContext';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import { SensorChips } from '@/components/intent/SensorChips';
import { StageDetail, stageTokenTotal, useStageExecution } from '@/components/intent/StageDetail';
import {
  Loader2,
  RotateCcw,
  Check,
  MessageCircleQuestion,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Progress } from '@/components/ui/progress';
import { displayModels, displayStageName, humanizeSlug } from '@/lib/displayNames';
import { describeFailure } from '@/lib/failureReasons';
import { SETTLED_STATES, withInferredFailure } from '@/components/intent/inferredFailure';
import { formatCost, formatTokens } from '@/lib/metricAggregation';
import { TONE_CLASSES, ageLabel, deriveIntentStatus } from '@/lib/statusModel';
import { formatAbsolute } from '@/lib/timeAgo';
import { IntentStageDependencies } from '@/components/intent/IntentPhaseDiagram';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import type { IntentSensorRun } from '@/services/intents';

const ACTIVE_STATES = new Set(['RUNNING', 'WAITING_FOR_HUMAN']);

function isGroupActive(rows: IntentStageRow[]): boolean {
  return rows.some((r) => ACTIVE_STATES.has(r.state));
}

function isGroupRunning(rows: IntentStageRow[]): boolean {
  return rows.some((r) => r.state === 'RUNNING');
}

function hasGroupFailure(rows: IntentStageRow[]): boolean {
  return rows.some((r) => r.state === 'FAILED');
}

// The pipeline list — the default Stages view. Plan stages (scope-filtered in
// the context) grouped by phase with per-phase progress; each row is a
// drill-down toggle sharing `selectedStageId` with the graph view. Rows are
// keyed by stage INSTANCE (docs/v2-parallel.md WP7): a fan-out stage renders
// one row per unit lane, each independently selectable. Stages the intent's
// scope leaves out are listed once, folded, so the counters above only ever
// count what this run will execute.
export function IntentStageList() {
  const {
    stageRows,
    detail,
    compiled,
    selectedStageId,
    setSelectedStageId,
    sensorsByStage,
    phaseNameOf,
    lastActivityAt,
    gates,
    initializationPhasePaths,
  } = useIntent();

  // The engine still reports the current stage as running: when the run is
  // stalled, that stage reads "Stalled since <last activity>" instead of its
  // (never updated) backend state.
  const stalledSince = useMemo(() => {
    if (!detail) return null;
    const derived = deriveIntentStatus(detail.intent, { lastActivityAt, gates });
    return derived.stalled ? (derived.since ?? null) : null;
  }, [detail, gates, lastActivityAt]);

  // A run can fail before the failing stage gets a row (the orchestrator
  // rejects it at dispatch): every row still reads PENDING/SUCCEEDED while the
  // run is FAILED. The failure message or event names the stage; show it there.
  const rows = useMemo(
    () => withInferredFailure(stageRows, detail?.intent, detail?.events ?? []),
    [detail?.events, detail?.intent, stageRows],
  );

  const groups = useMemo(() => {
    // One group per phase, in first-seen order: rows outside the compiled plan
    // arrive unsorted, and a split phase would read as two phases.
    const byPhase = new Map<string | null, IntentStageRow[]>();
    for (const row of rows) {
      const phase = row.phase ?? null;
      const list = byPhase.get(phase);
      if (list) list.push(row);
      else byPhase.set(phase, [row]);
    }
    return [...byPhase].map(([phase, phaseRows]) => ({ phase, rows: phaseRows }));
  }, [rows]);

  const outOfScope = useMemo(() => {
    if (!detail || !compiled) return [];
    const inRun = new Set(stageRows.map((r) => r.stageId));
    return getIntentStageSelection(detail.intent, compiled, initializationPhasePaths)
      .available.filter((n) => !inRun.has(n.stageId))
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((n) => ({
        stageId: n.stageId,
        phase: n.phasePath ? phaseNameOf(n.phasePath) : null,
      }));
  }, [compiled, detail, initializationPhasePaths, phaseNameOf, stageRows]);

  const currentStage = detail?.intent.currentStage ?? null;
  const defaultOpenKeys = useMemo(
    () =>
      groups
        .map((g, gi) => ({
          key: `${g.phase ?? 'no-phase'}-${gi}`,
          active:
            isGroupActive(g.rows) ||
            hasGroupFailure(g.rows) ||
            (stalledSince !== null && g.rows.some((r) => r.stageId === currentStage)),
        }))
        .filter((x) => x.active)
        .map((x) => x.key),
    [currentStage, groups, stalledSince],
  );

  // A selection made elsewhere (Audit's stage link, the graph) can point into a
  // folded phase; open it so the selected stage's detail is actually shown.
  const selectedGroupKey = useMemo(() => {
    if (!selectedStageId) return null;
    const gi = groups.findIndex((g) => g.rows.some((r) => stageRowKey(r) === selectedStageId));
    return gi < 0 ? null : `${groups[gi].phase ?? 'no-phase'}-${gi}`;
  }, [groups, selectedStageId]);

  const [openItems, setOpenItems] = useState<string[]>(() =>
    selectedGroupKey ? [...new Set([...defaultOpenKeys, selectedGroupKey])] : defaultOpenKeys,
  );

  useEffect(() => {
    const wanted = selectedGroupKey ? [...defaultOpenKeys, selectedGroupKey] : defaultOpenKeys;
    setOpenItems((prev) => {
      const merged = [...new Set([...prev, ...wanted])];
      return merged.length === prev.length ? prev : merged;
    });
  }, [defaultOpenKeys, selectedGroupKey]);

  if (stageRows.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages resolved yet.</p>;
  }

  return (
    <div className="space-y-2.5">
      <Accordion
        type="multiple"
        value={openItems}
        onValueChange={setOpenItems}
        className="space-y-2.5"
      >
        {groups.map((g, gi) => {
          const itemKey = `${g.phase ?? 'no-phase'}-${gi}`;
          const done = g.rows.filter(
            (r) => r.state === 'SUCCEEDED' || r.state === 'SKIPPED',
          ).length;
          const active = isGroupActive(g.rows);
          const running = isGroupRunning(g.rows);
          const waiting = g.rows.some((r) => r.state === 'WAITING_FOR_HUMAN');
          const failed = hasGroupFailure(g.rows);
          const allDone = done === g.rows.length;
          const pct = g.rows.length > 0 ? Math.round((done / g.rows.length) * 100) : 0;
          const phaseName = g.phase ? phaseNameOf(g.phase) : 'Ungrouped';

          return (
            <AccordionItem
              key={itemKey}
              value={itemKey}
              className="overflow-hidden rounded-lg border transition-colors"
            >
              <AccordionTrigger className="flex w-full items-center gap-2.5 bg-muted/20 px-3 py-2 hover:no-underline">
                <div className="flex flex-1 items-center gap-2.5 min-w-0">
                  {allDone && (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-agent-success/20">
                      <Check className="h-2.5 w-2.5 text-agent-success-fg" />
                    </span>
                  )}
                  {running && (
                    <span className="relative flex h-3 w-3 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent-running opacity-75 motion-reduce:hidden" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-agent-running" />
                    </span>
                  )}
                  {waiting && !running && (
                    <MessageCircleQuestion
                      aria-label="Waiting for a response"
                      className="h-3.5 w-3.5 shrink-0 text-agent-waiting-fg"
                    />
                  )}
                  {failed && !active && !allDone && (
                    <XCircle
                      aria-label="Phase has a failed stage"
                      className="h-3.5 w-3.5 shrink-0 text-agent-error-fg"
                    />
                  )}
                  {!allDone && !active && !failed && (
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" />
                  )}
                  <span className="text-xs font-medium text-muted-foreground">{phaseName}</span>
                  <span className="ml-auto flex items-center gap-2 text-2xs tabular-nums text-muted-foreground">
                    <span>
                      {done}/{g.rows.length}
                    </span>
                    <Progress
                      value={pct}
                      aria-label={`${done} of ${g.rows.length} stages completed`}
                      className={cn(
                        'w-12 h-1.5',
                        allDone && '[&>div]:bg-agent-success',
                        running && '[&>div]:bg-agent-running',
                        waiting && !running && '[&>div]:bg-agent-waiting',
                        failed && !active && '[&>div]:bg-agent-error',
                      )}
                    />
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-2 pb-2 pt-1.5">
                <PhaseRows
                  rows={g.rows}
                  currentStage={currentStage}
                  stalledSince={stalledSince}
                  selectedStageId={selectedStageId}
                  setSelectedStageId={setSelectedStageId}
                  sensorsByStage={sensorsByStage}
                />
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {outOfScope.length > 0 && (
        <Disclosure
          title={`${outOfScope.length} ${outOfScope.length === 1 ? 'stage' : 'stages'} not selected`}
          summary={
            <span className="hidden sm:inline">
              Left out by the{' '}
              {detail?.intent.scope ? humanizeSlug(detail.intent.scope) : 'selected'} scope
            </span>
          }
          variant="row"
          className="rounded-lg border border-dashed"
        >
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {outOfScope.map((stage) => (
              <li
                key={stage.stageId}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground"
              >
                <span className="truncate">{displayStageName(stage.stageId)}</span>
                <span className="flex shrink-0 items-center gap-2 text-2xs">
                  {stage.phase}
                  <span className={cn('rounded-full px-1.5 py-0.5', TONE_CLASSES.neutral.pill)}>
                    Not selected
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <div className="flex justify-end pt-1">
        <IntentStageDependencies />
      </div>
    </div>
  );
}

type Segment =
  | { kind: 'flat'; rows: IntentStageRow[] }
  | { kind: 'units'; order: string[]; byUnit: Map<string, IntentStageRow[]> };

// Preserve plan order. A fan-out section is a CONTIGUOUS run of unit rows;
// collapse that run into per-unit groups IN PLACE so once-per-workflow stages
// before it (design) and after it (build & test) keep their position.
function segmentRows(rows: IntentStageRow[]): Segment[] {
  const segments: Segment[] = [];
  for (const row of rows) {
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
  return segments;
}

function PhaseRows({
  rows,
  currentStage,
  stalledSince,
  selectedStageId,
  setSelectedStageId,
  sensorsByStage,
}: {
  rows: IntentStageRow[];
  currentStage: string | null;
  stalledSince: string | null;
  selectedStageId: string | null;
  setSelectedStageId: (key: string | null) => void;
  sensorsByStage: Map<string, IntentSensorRun[]>;
}) {
  const segments = useMemo(() => segmentRows(rows), [rows]);
  const renderRow = (row: IntentStageRow) => {
    const key = stageRowKey(row);
    const current = row.stageId === currentStage;
    return (
      <StageRow
        key={key}
        row={row}
        current={current}
        stalledSince={current && !SETTLED_STATES.has(row.state) ? stalledSince : null}
        selected={selectedStageId === key}
        onToggle={() => setSelectedStageId(selectedStageId === key ? null : key)}
        sensors={row.stageInstanceId ? (sensorsByStage.get(row.stageInstanceId) ?? []) : []}
      />
    );
  };

  return (
    <div className="space-y-2">
      {segments.map((seg, si) =>
        seg.kind === 'flat' ? (
          <div key={si} className="space-y-1.5">
            {seg.rows.map(renderRow)}
          </div>
        ) : (
          <div key={si} className="space-y-2">
            {seg.order.map((slug) => (
              <div key={slug} className="space-y-1.5">
                <div className="flex items-center gap-1.5 px-1">
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                  <span className="text-2xs font-medium text-muted-foreground">
                    {displayStageName(slug)}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                {seg.byUnit.get(slug)!.map(renderRow)}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

// The run states a retry may start from — mirrors StageDetail's rewind gate
// (the API 409s while RUNNING).
const RETRYABLE_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'WAITING', 'CANCELLED']);

function stageSummary(
  row: IntentStageRow,
  execution: ReturnType<typeof useStageExecution>,
): string | null {
  if (row.state === 'PENDING' || row.state === 'SKIPPED') return null;
  const parts: string[] = [];
  const docs = execution.currentArtifacts.length;
  if (docs > 0) parts.push(`${docs} ${docs === 1 ? 'document' : 'documents'}`);
  if (execution.usedModels.length > 0) parts.push(displayModels(execution.usedModels));
  const tokens = stageTokenTotal(execution.stageMetrics);
  if (tokens !== null && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (execution.stageCost?.priced) {
    parts.push(
      `${execution.stageCost.estimated ? '≈' : ''}${formatCost(
        execution.stageCost.totalCost,
        execution.stageCost.currency,
      )}`,
    );
  }
  return parts.length ? parts.join(' · ') : null;
}

// A rewind bumps `attempt` on every reset row, including stages that never
// ran; only a stage that actually started has attempts worth showing.
function attemptRan(row: IntentStageRow): boolean {
  return row.attempt > 1 && (row.startedAt !== null || row.state !== 'PENDING');
}

function StalledStagePill({ since }: { since: string }) {
  return (
    <span
      data-tone="warning"
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium',
        TONE_CLASSES.warning.pill,
      )}
    >
      <TriangleAlert aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="truncate">
        Stalled since {formatAbsolute(since, { includeTime: false })}
      </span>
    </span>
  );
}

function StageRow({
  row,
  current,
  stalledSince,
  selected,
  onToggle,
  sensors,
}: {
  row: IntentStageRow;
  current: boolean;
  stalledSince: string | null;
  selected: boolean;
  onToggle: () => void;
  sensors: IntentSensorRun[];
}) {
  const { detail, rewindIntent, mayControlStage } = useIntent();
  useTick(row.state === 'RUNNING');
  // A parked stage reads its wait like every other surface ("110 days", the
  // header's grammar) rather than a stopwatch ("110d 19h"); finished and
  // running stages keep the precise duration.
  const duration =
    row.state === 'WAITING_FOR_HUMAN'
      ? ageLabel(row.parkedAt ?? row.startedAt) || null
      : formatDuration(row.startedAt, row.state === 'RUNNING' ? null : row.completedAt);
  const execution = useStageExecution(row);
  const summary = selected ? null : stageSummary(row, execution);
  const stageName = displayStageName(row.stageId);
  const failure = row.runtimeError ? describeFailure(undefined, row.runtimeError) : null;
  const canRetry =
    mayControlStage(row.stageId) &&
    row.planned &&
    row.state === 'FAILED' &&
    RETRYABLE_STATUSES.has(detail?.intent.status ?? '');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) containerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await rewindIntent(row.stageId);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Failed to retry stage');
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div ref={containerRef} className="scroll-mt-4">
      <div className="flex items-stretch gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={selected}
          className={cn(
            'flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40',
            current && 'border-primary/40 bg-primary/[0.03]',
            row.state === 'FAILED' && 'border-agent-error/40',
            selected && 'rounded-b-none',
          )}
        >
          <span className="min-w-0 basis-full sm:flex-1 sm:basis-0">
            <span className="block truncate font-medium">{stageName}</span>
            {summary && (
              <span className="block truncate text-xs text-muted-foreground">{summary}</span>
            )}
            {failure && !selected && (
              <span className="block truncate text-xs text-agent-error-fg">{failure.sentence}</span>
            )}
          </span>
          <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {!selected && <SensorChips summary runs={sensors} />}
            {attemptRan(row) && (
              <Badge variant="secondary" size="sm">
                Attempt {row.attempt}
              </Badge>
            )}
            {duration && (
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {duration}
              </span>
            )}
            {stalledSince ? (
              <StalledStagePill since={stalledSince} />
            ) : (
              <StatusPill kind="stage" status={row.state} />
            )}
          </span>
        </button>
        {canRetry && !selected && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={retrying}
            title={`Retry ${stageName} and every stage after it`}
            aria-label={`Retry stage ${stageName}`}
            onClick={() => void handleRetry()}
            className="h-auto w-9 shrink-0"
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </div>
      {retryError && (
        <p role="alert" className="px-2 pt-1 text-xs text-agent-error-fg">
          Retry failed: {retryError}
        </p>
      )}
      {selected && <StageDetail row={row} durationInHeading={!!duration} />}
    </div>
  );
}
