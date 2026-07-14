import { useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import type { IntentUnit, IntentUnitPlan, UnitState } from '@/services/intents';
import { Hammer } from 'lucide-react';

// Units lane board (docs/plans/units-lane-board.md): visualizes the parallel /
// sequential unit work after fan-out. Columns are the promoted unit DAG's
// dependency layers ("waves", unitPlan.batches) — a stable left-to-right layout
// of the DAG, NOT a runtime barrier claim: in autonomous mode the orchestrator
// launches the whole wavefront and lanes self-block on their own dependencies
// (lambda/v2-orchestrator/section.js:934); only gated mode gates per wave
// (section.js:940). Card colour/state is therefore driven by unit.state, never
// inferred from the wave index.

// ── State presentation ──────────────────────────────────────────────────────
const STATE_LABEL: Record<UnitState, string> = {
  PENDING: 'Pending',
  READY: 'Ready',
  RUNNING: 'Building',
  MERGING: 'Merging',
  MERGED: 'Merged',
  BLOCKED: 'Blocked',
  FAILED: 'Failed',
};

// Tailwind classes per state. MERGING is active work but merge-back rather than
// agent construction, so it gets a distinct, subdued treatment (construction
// palette) rather than the running purple.
const STATE_STYLES: Record<UnitState, { card: string; badge: string; dot: string }> = {
  RUNNING: {
    card: 'border-agent-running/50 bg-agent-running/[0.06] ring-1 ring-agent-running/30',
    badge: 'text-agent-running bg-agent-running/10',
    dot: 'bg-agent-running',
  },
  MERGING: {
    card: 'border-phase-construction/50 bg-phase-construction/[0.06]',
    badge: 'text-phase-construction bg-phase-construction/15',
    dot: 'bg-phase-construction',
  },
  MERGED: {
    card: 'border-agent-success/40',
    badge: 'text-agent-success bg-agent-success/10',
    dot: 'bg-agent-success',
  },
  FAILED: {
    card: 'border-agent-error/50 bg-agent-error/[0.06]',
    badge: 'text-agent-error bg-agent-error/10',
    dot: 'bg-agent-error',
  },
  BLOCKED: {
    card: 'border-amber-400/50',
    badge: 'text-amber-600 dark:text-amber-400 bg-amber-400/10',
    dot: 'bg-amber-400',
  },
  READY: {
    card: 'border-border',
    badge: 'text-muted-foreground bg-muted',
    dot: 'bg-muted-foreground/50',
  },
  PENDING: {
    card: 'border-border opacity-60',
    badge: 'text-muted-foreground bg-muted',
    dot: 'bg-muted-foreground/40',
  },
};

// Order used for the header state-count chips (only present states rendered).
const STATE_ORDER: UnitState[] = [
  'MERGED',
  'RUNNING',
  'MERGING',
  'BLOCKED',
  'FAILED',
  'READY',
  'PENDING',
];

// ── Card ─────────────────────────────────────────────────────────────────────
interface UnitCardProps {
  unit: IntentUnit;
  isWalkingSkeleton: boolean;
  /** stageInstanceId of the unit's currently RUNNING stage row, if any. */
  runningStageInstanceId: string | null;
  /** Tail of the live transcript for the running stage (already trimmed). */
  stream: string | null;
  /** Open this lane's full output in the sidebar (only when building). */
  onViewLiveOutput?: (stageInstanceId: string) => void;
}

function UnitCard({
  unit,
  isWalkingSkeleton,
  runningStageInstanceId,
  stream,
  onViewLiveOutput,
}: UnitCardProps) {
  useTick(unit.state === 'RUNNING' || unit.state === 'MERGING');
  const styles = STATE_STYLES[unit.state];
  const elapsed =
    unit.startedAt && (unit.state === 'RUNNING' || unit.state === 'MERGING')
      ? formatDuration(unit.startedAt, null)
      : null;
  const showStream = runningStageInstanceId !== null && stream;

  return (
    <div className={cn('rounded-lg border p-3 transition-colors', styles.card)}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', styles.dot)} />
          <span className="truncate font-mono text-sm font-semibold">{unit.slug}</span>
          {isWalkingSkeleton && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 px-1.5 py-0 text-[9px] font-normal text-phase-construction"
              title="Walking skeleton — built solo first to validate the plan"
            >
              <Hammer className="h-2.5 w-2.5" />
              skeleton
            </Badge>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
            styles.badge,
          )}
        >
          {STATE_LABEL[unit.state]}
        </span>
      </div>

      {(unit.dependsOn.length > 0 || elapsed) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          {unit.dependsOn.length > 0 && (
            <span className="min-w-0 truncate">
              &#8627; depends on{' '}
              {unit.dependsOn.map((dep, i) => (
                <span key={dep}>
                  {i > 0 && ', '}
                  <code className="font-mono text-foreground/80">{dep}</code>
                </span>
              ))}
            </span>
          )}
          {elapsed && (
            <span className="ml-auto shrink-0 font-mono tabular-nums text-[10px]">{elapsed}</span>
          )}
        </div>
      )}

      {unit.state === 'BLOCKED' && unit.blockedOn && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          &#9203; {unit.blockedOn}
        </p>
      )}
      {unit.state === 'MERGING' && (
        <p className="mt-1.5 text-[10px] text-phase-construction">Merging back&hellip;</p>
      )}
      {unit.state === 'FAILED' && unit.failureReason && (
        <p className="mt-1.5 text-[10px] text-agent-error">&#10005; {unit.failureReason}</p>
      )}

      {showStream && (
        <div className="mt-2 flex h-20 flex-col justify-end overflow-hidden rounded-md bg-zinc-950 p-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-300">
            {stream}
            <span className="ml-0.5 inline-block h-2.5 w-1 animate-pulse bg-zinc-500 align-middle" />
          </pre>
        </div>
      )}

      {runningStageInstanceId && onViewLiveOutput && (
        <button
          type="button"
          onClick={() => onViewLiveOutput(runningStageInstanceId)}
          className="mt-1.5 text-[10px] font-medium text-agent-running hover:underline"
        >
          View live output
        </button>
      )}
    </div>
  );
}

// ── Presentational board (pure — tested in isolation) ────────────────────────
export interface UnitLaneBoardViewProps {
  unitPlan: IntentUnitPlan;
  units: IntentUnit[];
  /** Live transcript tail per unit slug (only running units need an entry). */
  streamsBySlug: Record<string, string | null>;
  /** RUNNING stageInstanceId per unit slug (null when the unit isn't building). */
  runningStageBySlug: Record<string, string | null>;
  /** Open a building lane's full output in the sidebar (per-unit, keyed by
   *  that lane's stageInstanceId — during fan-out each lane streams separately). */
  onViewLiveOutput?: (stageInstanceId: string) => void;
}

export function UnitLaneBoardView({
  unitPlan,
  units,
  streamsBySlug,
  runningStageBySlug,
  onViewLiveOutput,
}: UnitLaneBoardViewProps) {
  const unitBySlug = useMemo(() => {
    const m = new Map<string, IntentUnit>();
    for (const u of units) m.set(u.slug, u);
    return m;
  }, [units]);

  // Slugs the board actually renders — the current plan snapshot's units. The
  // backend intentionally keeps ORPHANED unit rows around after a re-promotion /
  // rewind (they stay in detail.units for audit but are dropped from the plan;
  // lambda/shared/v2-process-store.js:1000), so counting over all detail.units
  // would report states for units that aren't on the board.
  const planSlugs = useMemo(() => {
    const fromBatches = (unitPlan.batches ?? []).flat();
    const slugs = fromBatches.length > 0 ? fromBatches : (unitPlan.units ?? []).map((u) => u.slug);
    return new Set(slugs);
  }, [unitPlan.batches, unitPlan.units]);

  // State-count chips — only states actually present among plan units, in a
  // stable order.
  const stateCounts = useMemo(() => {
    const counts = new Map<UnitState, number>();
    for (const u of units) {
      if (!planSlugs.has(u.slug)) continue;
      counts.set(u.state, (counts.get(u.state) ?? 0) + 1);
    }
    return STATE_ORDER.filter((s) => counts.has(s)).map((s) => ({
      state: s,
      count: counts.get(s) as number,
    }));
  }, [units, planSlugs]);

  const waves = unitPlan.batches ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">Units</CardTitle>
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {unitPlan.unitCount} unit{unitPlan.unitCount === 1 ? '' : 's'} &middot; {waves.length}{' '}
            wave{waves.length === 1 ? '' : 's'}
          </Badge>
          {unitPlan.autonomyMode && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {unitPlan.autonomyMode}
            </Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {stateCounts.map(({ state, count }) => (
              <span
                key={state}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]',
                  STATE_STYLES[state].badge,
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', STATE_STYLES[state].dot)} />
                {count} {STATE_LABEL[state].toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Horizontal scroll so many waves (or narrow/mobile widths) keep each
            column readable instead of collapsing. */}
        <div className="overflow-x-auto">
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${Math.max(waves.length, 1)}, minmax(14rem, 1fr))`,
            }}
          >
            {waves.map((slugs, waveIdx) => {
              const label =
                waveIdx === 0
                  ? '· runs first'
                  : waveIdx === waves.length - 1
                    ? '· last'
                    : '· parallel';
              return (
                <div key={waveIdx}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-semibold">Wave {waveIdx + 1}</span>
                    <span className="rounded-full border px-1.5 text-[9px] text-muted-foreground">
                      {slugs.length}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{label}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {slugs.map((slug) => {
                      const unit = unitBySlug.get(slug);
                      if (!unit) return null;
                      return (
                        <UnitCard
                          key={slug}
                          unit={unit}
                          isWalkingSkeleton={unitPlan.walkingSkeleton === slug}
                          runningStageInstanceId={runningStageBySlug[slug] ?? null}
                          stream={streamsBySlug[slug] ?? null}
                          onViewLiveOutput={onViewLiveOutput}
                        />
                      );
                    })}
                    {slugs.length === 0 && (
                      <p className="py-2 text-[11px] text-muted-foreground">No units</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Trim a raw transcript buffer to a short readable tail for the card.
function tailOf(buffer: string | undefined): string | null {
  if (!buffer) return null;
  const lines = buffer
    .trim()
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0) return null;
  return lines.slice(-4).join('\n');
}

// ── Context wrapper (mounted in the workbench) ────────────────────────────────

// The DAG is promoted (unitPlan written) at the unit-DAG stage, whose
// validation gate doubles as the fan-out approval; the section runner emits a
// section_started event when its lanes actually open
// (lambda/v2-orchestrator/section.js). Each section completes with a fan-in
// event. Fan-out is "active" — lanes are live and the board should replace the
// single-stage Running card — while more sections have started than have
// fanned in.
const SECTION_STARTED_EVENT = 'v2.units.section_started';
const FAN_IN_EVENT = 'v2.units.fan_in';

/**
 * True while parallel unit lanes are live (section started, not yet fanned in).
 * Shared by IntentView so it can hide the single-stage Running card and let the
 * units board own the "what's building" view until fan-in.
 */
export function isFanoutActive(detail: { events?: { type: string }[] } | null): boolean {
  const events = detail?.events ?? [];
  let open = 0;
  for (const e of events) {
    if (e.type === SECTION_STARTED_EVENT) open += 1;
    else if (e.type === FAN_IN_EVENT) open -= 1;
  }
  return open > 0;
}

export function UnitLaneBoard({
  onViewLiveOutput,
}: { onViewLiveOutput?: (stageInstanceId: string) => void } = {}) {
  const { detail, stageRows, outputBuffers, ensureOutputs, outputVersion } = useIntent();
  const unitPlan = detail?.unitPlan ?? null;
  const units = useMemo(() => detail?.units ?? [], [detail?.units]);

  const fanoutActive = useMemo(() => isFanoutActive(detail), [detail]);

  // Resolve each unit's RUNNING stage instance. findLast + the stageInstanceId
  // guard is the safer default if retries or duplicate live rows appear. Keys on
  // the stage row's RUNNING state, NOT unit.state (MERGING has no transcript).
  const runningStageBySlug = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const u of units) {
      const row = (stageRows as IntentStageRow[]).findLast(
        (r) => r.unitSlug === u.slug && r.state === 'RUNNING' && r.stageInstanceId,
      );
      out[u.slug] = row?.stageInstanceId ?? null;
    }
    return out;
  }, [units, stageRows]);

  // Lazily seed the transcript pane for each running unit.
  useEffect(() => {
    for (const id of Object.values(runningStageBySlug)) {
      if (id) ensureOutputs(id);
    }
  }, [runningStageBySlug, ensureOutputs]);

  // Subscribe to buffer mutations: outputBuffers is a mutated Map, so without
  // depending on outputVersion the cards won't re-render as chunks stream in.
  const streamsBySlug = useMemo(() => {
    void outputVersion;
    const out: Record<string, string | null> = {};
    for (const [slug, id] of Object.entries(runningStageBySlug)) {
      out[slug] = id ? tailOf(outputBuffers.get(id)) : null;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningStageBySlug, outputBuffers, outputVersion]);

  // Show the board only while fan-out is active: from gate approval (unitPlan is
  // set earlier, at promotion) until fan-in, when the single-stage Running card
  // takes over again.
  if (!unitPlan || !fanoutActive) return null;

  return (
    <UnitLaneBoardView
      unitPlan={unitPlan}
      units={units}
      streamsBySlug={streamsBySlug}
      runningStageBySlug={runningStageBySlug}
      onViewLiveOutput={onViewLiveOutput}
    />
  );
}
