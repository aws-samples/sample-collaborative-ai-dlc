import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { StageBadge, formatDuration, useTick } from '@/components/intent/stageStyle';
import { SensorChips } from '@/components/intent/SensorChips';
import { StageDetail } from '@/components/intent/StageDetail';
import type { IntentSensorRun } from '@/services/intents';

// The pipeline list — the default Stages view. Plan stages (scope-filtered in
// the context) grouped by phase with per-phase progress; each row is a
// drill-down toggle sharing `selectedStageId` with the graph view.
export function IntentStageList() {
  const { stageRows, detail, selectedStageId, setSelectedStageId, sensorsByStage } = useIntent();

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

  if (stageRows.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages resolved yet.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((g, gi) => {
        const done = g.rows.filter((r) => r.state === 'SUCCEEDED' || r.state === 'SKIPPED').length;
        return (
          <div key={`${g.phase ?? 'no-phase'}-${gi}`}>
            {g.phase && (
              <div className="mb-1.5 flex items-baseline justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Phase {g.phase}
                </p>
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {done}/{g.rows.length} done
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              {g.rows.map((row) => (
                <StageRow
                  key={row.stageId}
                  row={row}
                  current={row.stageId === detail?.intent.currentStage}
                  selected={selectedStageId === row.stageId}
                  onToggle={() =>
                    setSelectedStageId(selectedStageId === row.stageId ? null : row.stageId)
                  }
                  sensors={
                    row.stageInstanceId ? (sensorsByStage.get(row.stageInstanceId) ?? []) : []
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
  useTick(row.state === 'RUNNING');
  const duration = formatDuration(row.startedAt, row.state === 'RUNNING' ? null : row.completedAt);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={selected}
        className={cn(
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40',
          current && 'border-primary/40 bg-primary/[0.03]',
          selected && 'rounded-b-none',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium">{row.stageId}</span>
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
        <StageBadge state={row.state} />
      </button>
      {selected && <StageDetail row={row} />}
    </div>
  );
}
