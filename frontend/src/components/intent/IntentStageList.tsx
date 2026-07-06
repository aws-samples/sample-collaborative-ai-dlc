import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useIntent, stageRowKey, type IntentStageRow } from '@/contexts/IntentContext';
import { StageBadge, formatDuration, useTick } from '@/components/intent/stageStyle';
import { SensorChips } from '@/components/intent/SensorChips';
import { StageDetail } from '@/components/intent/StageDetail';
import { Loader2, RotateCcw, Check } from 'lucide-react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Progress } from '@/components/ui/progress';
import { phaseColorAt } from '@/components/observability/phaseConfig';
import type { IntentSensorRun } from '@/services/intents';

const ACTIVE_STATES = new Set(['RUNNING', 'WAITING_FOR_HUMAN', 'FAILED']);

function isGroupActive(rows: IntentStageRow[]): boolean {
  return rows.some((r) => ACTIVE_STATES.has(r.state));
}

// The pipeline list — the default Stages view. Plan stages (scope-filtered in
// the context) grouped by phase with per-phase progress; each row is a
// drill-down toggle sharing `selectedStageId` with the graph view. Rows are
// keyed by stage INSTANCE (docs/v2-parallel.md WP7): a fan-out stage renders
// one row per unit lane, each independently selectable.
export function IntentStageList() {
  const { stageRows, detail, selectedStageId, setSelectedStageId, sensorsByStage, phaseNameOf } =
    useIntent();

  // Group consecutive rows by phase, preserving plan order.
  const groups = useMemo(() => {
    const out: { phase: string | null; rows: IntentStageRow[] }[] = [];
    for (const row of stageRows) {
      const phase = row.phase ?? null;
      const last = out[out.length - 1];
      if (last && last.phase === phase) last.rows.push(row);
      else out.push({ phase, rows: [row] });
    }
    return out;
  }, [stageRows]);

  // Determine which AccordionItems should be open by default:
  // phases with active rows (RUNNING, WAITING_FOR_HUMAN, FAILED).
  const defaultOpen = useMemo(
    () =>
      groups
        .map((g, gi) => ({ key: `${g.phase ?? 'no-phase'}-${gi}`, active: isGroupActive(g.rows) }))
        .filter((x) => x.active)
        .map((x) => x.key),
    [groups],
  );

  if (stageRows.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages resolved yet.</p>;
  }

  return (
    <Accordion type="multiple" defaultValue={defaultOpen} className="space-y-2.5">
      {groups.map((g, gi) => {
        const itemKey = `${g.phase ?? 'no-phase'}-${gi}`;
        const done = g.rows.filter((r) => r.state === 'SUCCEEDED' || r.state === 'SKIPPED').length;
        const active = isGroupActive(g.rows);
        const allDone = done === g.rows.length;
        const pct = g.rows.length > 0 ? Math.round((done / g.rows.length) * 100) : 0;
        const palette = phaseColorAt(gi);
        const phaseName = g.phase ? phaseNameOf(g.phase) : 'Ungrouped';

        return (
          <AccordionItem
            key={itemKey}
            value={itemKey}
            className={cn(
              'rounded-lg border-2 overflow-hidden transition-colors',
              palette.blockBorder,
              palette.blockBg,
              'border-b-2',
            )}
          >
            <AccordionTrigger
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 hover:no-underline',
                palette.headerBg,
              )}
            >
              <div className="flex flex-1 items-center gap-2.5 min-w-0">
                {allDone && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-agent-success/20">
                    <Check className="h-2.5 w-2.5 text-agent-success" />
                  </span>
                )}
                {active && (
                  <span className="relative flex h-3 w-3 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent-running opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-agent-running" />
                  </span>
                )}
                {!allDone && !active && (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" />
                )}
                <span
                  className={cn(
                    'text-xs font-semibold uppercase tracking-wider',
                    palette.headerText,
                  )}
                >
                  {phaseName}
                </span>
                <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                  <span>
                    {done}/{g.rows.length}
                  </span>
                  <Progress
                    value={pct}
                    className={cn(
                      'w-12 h-1.5',
                      allDone && '[&>div]:bg-agent-success',
                      active && '[&>div]:bg-agent-running',
                    )}
                  />
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-2 pb-2 pt-1.5">
              <div className="space-y-1.5">
                {g.rows.map((row) => {
                  const key = stageRowKey(row);
                  return (
                    <StageRow
                      key={key}
                      row={row}
                      current={row.stageId === detail?.intent.currentStage}
                      selected={selectedStageId === key}
                      onToggle={() => setSelectedStageId(selectedStageId === key ? null : key)}
                      sensors={
                        row.stageInstanceId ? (sensorsByStage.get(row.stageInstanceId) ?? []) : []
                      }
                    />
                  );
                })}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

// The run states a retry may start from — mirrors StageDetail's rewind gate
// (the API 409s while RUNNING).
const RETRYABLE_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'WAITING', 'CANCELLED']);

function StageRow({
  row,
  current,
  selected,
  onToggle,
  sensors,
}: {
  row: IntentStageRow;
  current: boolean;
  selected: boolean;
  onToggle: () => void;
  sensors: IntentSensorRun[];
}) {
  const { detail, rewindIntent } = useIntent();
  useTick(row.state === 'RUNNING');
  const duration = formatDuration(row.startedAt, row.state === 'RUNNING' ? null : row.completedAt);
  // One-click retry on a failed stage, right in the list: same reset+relaunch
  // as a guidance-less rewind (this stage and everything after re-run).
  const canRetry =
    row.planned && row.state === 'FAILED' && RETRYABLE_STATUSES.has(detail?.intent.status ?? '');
  const [retrying, setRetrying] = useState(false);
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (retrying) return;
    setRetrying(true);
    try {
      await rewindIntent(row.stageId);
    } catch {
      /* the detail panel surfaces retry errors; the row stays FAILED */
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={selected}
        className={cn(
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40',
          current && 'border-primary/40 bg-primary/[0.03]',
          !current && row.state === 'SUCCEEDED' && 'bg-agent-success/10',
          !current && row.state === 'SKIPPED' && 'bg-agent-success/5',
          !current && row.state === 'RUNNING' && 'bg-agent-running/10 animate-pulse',
          !current && row.state === 'WAITING_FOR_HUMAN' && 'bg-amber-400/10',
          !current && row.state === 'FAILED' && 'bg-agent-error/10',
          selected && 'rounded-b-none',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium">{row.stageId}</span>
          {row.unitSlug && (
            <Badge variant="outline" className="ml-2 px-1 py-0 text-[9px] font-normal">
              {row.unitSlug}
            </Badge>
          )}
          {row.runtimeError && !selected && (
            <span className="block truncate text-[11px] text-agent-error">{row.runtimeError}</span>
          )}
        </span>
        <SensorChips runs={sensors} className="hidden sm:inline-flex" />
        {row.attempt > 1 && (
          <Badge variant="secondary" className="px-1 py-0 text-[9px]">
            ×{row.attempt}
          </Badge>
        )}
        {duration && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        )}
        {canRetry && (
          /* span, not <button>: the row itself is a button and buttons can't nest */
          <span
            role="button"
            tabIndex={0}
            title="Retry this stage (re-runs it and everything after)"
            aria-label={`Retry stage ${row.stageId}`}
            onClick={handleRetry}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void handleRetry(e as unknown as React.MouseEvent);
              }
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
          </span>
        )}
        <StageBadge state={row.state} />
      </button>
      {selected && <StageDetail row={row} />}
    </div>
  );
}
