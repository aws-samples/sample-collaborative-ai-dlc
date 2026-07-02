import { useMemo } from 'react';
import { GitMerge, GitBranch, CircleDashed, Loader2, AlertCircle, Ban, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import type { IntentUnit, UnitState } from '@/services/intents';

// Unit lane board (docs/v2-parallel.md WP7): one row per unit-of-work lane,
// grouped into columns by scheduling wave (the promoted UNITPLAN's batches —
// the DDB scheduling truth), with dependency chips, the lane's own stage strip
// (this unit's per-stage instances), and the lane git/verdict state. The
// walking skeleton is visually distinct (it runs first, solo, gated).

const UNIT_STYLE: Record<UnitState, { label: string; cls: string; Icon: typeof GitMerge }> = {
  PENDING: { label: 'Pending', cls: 'bg-muted text-muted-foreground', Icon: CircleDashed },
  READY: { label: 'Ready', cls: 'bg-muted text-muted-foreground', Icon: CircleDashed },
  RUNNING: { label: 'Running', cls: 'bg-agent-working/15 text-agent-working', Icon: Loader2 },
  MERGING: { label: 'Merging', cls: 'bg-agent-working/15 text-agent-working', Icon: GitMerge },
  MERGED: { label: 'Merged', cls: 'bg-agent-online/15 text-agent-online', Icon: GitMerge },
  FAILED: { label: 'Failed', cls: 'bg-agent-error/15 text-agent-error', Icon: AlertCircle },
  BLOCKED: { label: 'Blocked', cls: 'bg-agent-error/10 text-agent-error', Icon: Ban },
};

export function UnitBadge({ state }: { state: UnitState }) {
  const s = UNIT_STYLE[state] ?? UNIT_STYLE.PENDING;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        s.cls,
      )}
    >
      <s.Icon className={cn('h-3 w-3', state === 'RUNNING' && 'animate-spin')} />
      {s.label}
    </span>
  );
}

export function UnitLaneBoard() {
  const { units, unitPlan, stageRows, selectedStageId, setSelectedStageId } = useIntent();

  // This unit's stage instances, in plan order (stageRows is plan-ordered).
  const rowsByUnit = useMemo(() => {
    const map = new Map<string, IntentStageRow[]>();
    for (const row of stageRows) {
      if (!row.unitSlug) continue;
      const list = map.get(row.unitSlug) ?? [];
      list.push(row);
      map.set(row.unitSlug, list);
    }
    return map;
  }, [stageRows]);

  // Waves: prefer the frozen UNITPLAN batches, fall back to batchIndex.
  const waves = useMemo(() => {
    const bySlug = new Map(units.map((u) => [u.slug, u]));
    const planned = (unitPlan?.batches ?? [])
      .map((wave) => wave.map((slug) => bySlug.get(slug)).filter((u): u is IntentUnit => !!u))
      .filter((w) => w.length > 0);
    if (planned.length) return planned;
    const byIndex = new Map<number, IntentUnit[]>();
    for (const u of units) {
      const list = byIndex.get(u.batchIndex ?? 0) ?? [];
      list.push(u);
      byIndex.set(u.batchIndex ?? 0, list);
    }
    return [...byIndex.entries()].toSorted((a, b) => a[0] - b[0]).map(([, us]) => us);
  }, [units, unitPlan]);

  if (units.length === 0) return null;

  const merged = units.filter((u) => u.state === 'MERGED').length;
  const skeleton = unitPlan?.walkingSkeleton ?? null;

  return (
    <div className="space-y-3">
      <p className="text-[11px] tabular-nums text-muted-foreground">
        {merged}/{units.length} unit(s) merged
        {unitPlan?.autonomyMode && ` · ${unitPlan.autonomyMode} mode`}
      </p>
      {waves.map((wave, wi) => (
        <div key={`wave-${wi}`}>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Wave {wi + 1}
          </p>
          <div className="space-y-1.5">
            {wave.map((unit) => (
              <UnitLaneRow
                key={unit.slug}
                unit={unit}
                isSkeleton={unit.slug === skeleton}
                stageRows={rowsByUnit.get(unit.slug) ?? []}
                selectedStageId={selectedStageId}
                setSelectedStageId={setSelectedStageId}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UnitLaneRow({
  unit,
  isSkeleton,
  stageRows,
  selectedStageId,
  setSelectedStageId,
}: {
  unit: IntentUnit;
  isSkeleton: boolean;
  stageRows: IntentStageRow[];
  selectedStageId: string | null;
  setSelectedStageId: (key: string | null) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2',
        isSkeleton && 'border-primary/40 bg-primary/[0.03]',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{unit.slug}</span>
        {isSkeleton && (
          <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[9px]">
            <Play className="h-2.5 w-2.5" /> skeleton
          </Badge>
        )}
        {(unit.dependsOn ?? []).map((dep) => (
          <Badge key={dep} variant="secondary" className="px-1.5 py-0 text-[9px] font-normal">
            ← {dep}
          </Badge>
        ))}
        <span className="min-w-0 flex-1" />
        {unit.branch && (
          <span className="hidden items-center gap-1 font-mono text-[10px] text-muted-foreground sm:inline-flex">
            <GitBranch className="h-3 w-3" />
            {unit.branch}
          </span>
        )}
        <UnitBadge state={unit.state} />
      </div>
      {/* This lane's stage strip: one chip per stage instance, drill-down
          shared with the list/graph via selectedStageId. */}
      {stageRows.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {stageRows.map((row) => {
            const key = row.stageInstanceId ?? `${row.stageId}:${unit.slug}`;
            const selected = selectedStageId === key;
            return (
              <button
                key={key}
                type="button"
                title={`${row.stageId} — ${row.state}`}
                onClick={() => setSelectedStageId(selected ? null : key)}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-muted/40',
                  row.state === 'SUCCEEDED' && 'border-agent-online/40 text-agent-online',
                  row.state === 'RUNNING' && 'border-agent-working/50 text-agent-working',
                  row.state === 'WAITING_FOR_HUMAN' && 'border-agent-waiting/50 text-agent-waiting',
                  row.state === 'FAILED' && 'border-agent-error/50 text-agent-error',
                  row.state === 'SKIPPED' && 'border-muted text-muted-foreground line-through',
                  row.state === 'PENDING' && 'border-muted text-muted-foreground',
                  selected && 'ring-1 ring-primary',
                )}
              >
                {row.stageId}
              </button>
            );
          })}
        </div>
      )}
      {(unit.failureReason || unit.blockedOn) && (
        <p className="mt-1 text-[11px] text-agent-error">
          {unit.failureReason ?? `blocked on ${unit.blockedOn}`}
        </p>
      )}
    </div>
  );
}
