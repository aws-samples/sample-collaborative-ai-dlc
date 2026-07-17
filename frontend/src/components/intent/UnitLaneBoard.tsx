import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { deriveLaneWaits, laneWaitKey, type LaneWaitStatus } from '@/lib/intentRecovery';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import {
  intentsService,
  type IntentFeedbackBatch,
  type IntentUnit,
  type IntentUnitPlan,
  type IntentUnitPr,
  type UnitReviewComment,
  type UnitState,
} from '@/services/intents';
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Hammer,
  Loader2,
  MessageSquare,
  TriangleAlert,
} from 'lucide-react';

// Units lane board (docs/plans/units-lane-board.md): visualizes the parallel /
// sequential unit work after fan-out. Columns are the promoted unit DAG's
// dependency layers ("waves", unitPlan.batches) — a stable left-to-right layout
// of the DAG, NOT a runtime barrier claim: in autonomous mode the orchestrator
// launches the whole wavefront and lanes self-block on their own dependencies
// (lambda/v2-orchestrator/section.js:934); only gated mode gates per wave
// (section.js:940). Card colour/state is therefore driven by unit.state, never
// inferred from the wave index.

// ── State presentation ──────────────────────────────────────────────────────
type DisplayState = UnitState | 'WAITING_INPUT' | 'NEEDS_RECOVERY';

const STATE_LABEL: Record<DisplayState, string> = {
  PENDING: 'Pending',
  READY: 'Ready',
  RUNNING: 'Building',
  PR_DRAFT: 'Draft review',
  RECONCILING: 'Reconciling',
  PR_READY: 'Ready to merge',
  ADDRESSING_FEEDBACK: 'Fixing feedback',
  MERGING: 'Merging',
  MERGED: 'Merged',
  BLOCKED: 'Blocked',
  FAILED: 'Failed',
  WAITING_INPUT: 'Waiting for input',
  NEEDS_RECOVERY: 'Needs recovery',
};

// Tailwind classes per state. MERGING is active work but merge-back rather than
// agent construction, so it gets a distinct, subdued treatment (construction
// palette) rather than the running purple.
const STATE_STYLES: Record<DisplayState, { card: string; badge: string; dot: string }> = {
  RUNNING: {
    card: 'border-agent-running/50 bg-agent-running/[0.06] ring-1 ring-agent-running/30',
    badge: 'text-agent-running bg-agent-running/10',
    dot: 'bg-agent-running',
  },
  PR_DRAFT: {
    card: 'border-sky-400/50 bg-sky-400/[0.05]',
    badge: 'text-sky-700 dark:text-sky-300 bg-sky-400/10',
    dot: 'bg-sky-400',
  },
  RECONCILING: {
    card: 'border-amber-400/50 bg-amber-400/[0.05]',
    badge: 'text-amber-700 dark:text-amber-300 bg-amber-400/10',
    dot: 'bg-amber-400',
  },
  PR_READY: {
    card: 'border-emerald-400/50 bg-emerald-400/[0.05]',
    badge: 'text-emerald-700 dark:text-emerald-300 bg-emerald-400/10',
    dot: 'bg-emerald-400',
  },
  ADDRESSING_FEEDBACK: {
    card: 'border-fuchsia-400/50 bg-fuchsia-400/[0.05]',
    badge: 'text-fuchsia-700 dark:text-fuchsia-300 bg-fuchsia-400/10',
    dot: 'bg-fuchsia-400',
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
  WAITING_INPUT: {
    card: 'border-agent-waiting/50 bg-agent-waiting/[0.05]',
    badge: 'text-agent-waiting bg-agent-waiting/10',
    dot: 'bg-agent-waiting',
  },
  NEEDS_RECOVERY: {
    card: 'border-agent-error/50 bg-agent-error/[0.06] ring-1 ring-agent-error/20',
    badge: 'text-agent-error bg-agent-error/10',
    dot: 'bg-agent-error',
  },
};

// Order used for the header state-count chips (only present states rendered).
const STATE_ORDER: DisplayState[] = [
  'MERGED',
  'NEEDS_RECOVERY',
  'WAITING_INPUT',
  'RUNNING',
  'ADDRESSING_FEEDBACK',
  'RECONCILING',
  'PR_READY',
  'PR_DRAFT',
  'MERGING',
  'BLOCKED',
  'FAILED',
  'READY',
  'PENDING',
];
const unitLaneKey = laneWaitKey;
const reviewCommentSelectionKey = (comment: UnitReviewComment) =>
  `${comment.repository}:${comment.id}`;

// ── Card ─────────────────────────────────────────────────────────────────────
interface UnitCardProps {
  unit: IntentUnit;
  prs: IntentUnitPr[];
  feedbackBatches: IntentFeedbackBatch[];
  isWalkingSkeleton: boolean;
  /** stageInstanceId of the unit's currently RUNNING stage row, if any. */
  runningStageInstanceId: string | null;
  /** Tail of the live transcript for the running stage (already trimmed). */
  stream: string | null;
  /** Open this lane's full output in the sidebar (only when building). */
  onViewLiveOutput?: (stageInstanceId: string) => void;
  onAddressFeedback?: (unit: IntentUnit) => void;
  laneWait?: LaneWaitStatus | null;
}

function UnitCard({
  unit,
  prs,
  feedbackBatches,
  isWalkingSkeleton,
  runningStageInstanceId,
  stream,
  onViewLiveOutput,
  onAddressFeedback,
  laneWait,
}: UnitCardProps) {
  useTick((unit.state === 'RUNNING' && !laneWait) || unit.state === 'MERGING');
  const displayState: DisplayState =
    laneWait?.kind === 'recovery'
      ? 'NEEDS_RECOVERY'
      : laneWait?.kind === 'input'
        ? 'WAITING_INPUT'
        : unit.state;
  const styles = STATE_STYLES[displayState];
  const elapsed =
    unit.startedAt && (unit.state === 'RUNNING' || unit.state === 'MERGING')
      ? formatDuration(unit.startedAt, laneWait?.since ?? null)
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
          {STATE_LABEL[displayState]}
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
      {unit.integrationOwner && (
        <p className="mt-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          Integration turn
        </p>
      )}
      {unit.blockedReason && (
        <p className="mt-1 text-[10px] text-muted-foreground">{unit.blockedReason}</p>
      )}
      {laneWait && (
        <p
          className={cn(
            'mt-1.5 text-[10px]',
            laneWait.kind === 'recovery' ? 'font-medium text-agent-error' : 'text-agent-waiting',
          )}
        >
          {laneWait.blocker}
        </p>
      )}
      {unit.state === 'MERGING' && (
        <p className="mt-1.5 text-[10px] text-phase-construction">Merging back&hellip;</p>
      )}
      {unit.state === 'FAILED' && unit.failureReason && (
        <p className="mt-1.5 text-[10px] text-agent-error">&#10005; {unit.failureReason}</p>
      )}

      {prs.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {prs.map((pr) => (
            <div
              key={`${pr.repository}:${pr.number ?? 'unchanged'}`}
              className="flex min-w-0 items-center gap-2 text-[10px]"
            >
              <GitPullRequest className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={pr.repository}>
                {pr.repository}
              </span>
              <span
                className={cn(
                  'shrink-0 font-medium',
                  pr.state === 'MERGED'
                    ? 'text-agent-success'
                    : pr.state === 'CONFLICTED' ||
                        pr.state === 'FAILED' ||
                        pr.state === 'CLOSED' ||
                        pr.state === 'PARTIALLY_MERGED'
                      ? 'text-agent-error'
                      : 'text-muted-foreground',
                )}
              >
                {pr.state.toLowerCase().replaceAll('_', ' ')}
              </span>
              {pr.commentCount > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                  <MessageSquare className="h-3 w-3" />
                  {pr.commentCount}
                </span>
              )}
              {pr.url && (
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${pr.repository} pull request`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {feedbackBatches.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2 text-[10px]">
          {feedbackBatches.slice(-2).map((batch) => (
            <details key={batch.batchId} className="group">
              <summary className="flex cursor-pointer list-none items-start gap-1.5">
                {batch.state === 'SUCCEEDED' ? (
                  <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-agent-success" />
                ) : batch.state === 'FAILED' ? (
                  <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-agent-error" />
                ) : (
                  <Loader2 className="mt-px h-3 w-3 shrink-0 animate-spin text-agent-running" />
                )}
                <span className="min-w-0 text-muted-foreground">
                  {batch.comments.length} comment{batch.comments.length === 1 ? '' : 's'} ·{' '}
                  {batch.state.toLowerCase()}
                  {batch.commitSha ? ` · ${batch.commitSha.slice(0, 8)}` : ''}
                </span>
              </summary>
              {(batch.output ||
                batch.changedFiles?.length ||
                batch.verification ||
                batch.failureReason) && (
                <div className="ml-4 mt-1 space-y-1 border-l pl-2 text-muted-foreground">
                  {batch.output && (
                    <p className="whitespace-pre-wrap break-words">{batch.output}</p>
                  )}
                  {batch.changedFiles && batch.changedFiles.length > 0 && (
                    <p>
                      <span className="font-medium text-foreground/80">Changed:</span>{' '}
                      {batch.changedFiles.join(', ')}
                    </p>
                  )}
                  {batch.verification && (
                    <p>
                      <span className="font-medium text-foreground/80">Verification:</span>{' '}
                      {batch.verification}
                    </p>
                  )}
                  {batch.failureReason && <p className="text-agent-error">{batch.failureReason}</p>}
                </div>
              )}
            </details>
          ))}
        </div>
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
      {prs.some((pr) => pr.commentCount > 0 && pr.state !== 'UNCHANGED' && pr.state !== 'CLOSED') &&
        onAddressFeedback && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAddressFeedback(unit)}
            className="mt-2 h-7 gap-1.5 px-2 text-[10px]"
          >
            <MessageSquare className="h-3 w-3" />
            Address feedback
          </Button>
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
  unitPrs?: IntentUnitPr[];
  feedbackBatches?: IntentFeedbackBatch[];
  /** Open a building lane's full output in the sidebar (per-unit, keyed by
   *  that lane's stageInstanceId — during fan-out each lane streams separately). */
  onViewLiveOutput?: (stageInstanceId: string) => void;
  onAddressFeedback?: (unit: IntentUnit) => void;
  laneWaitBySlug?: Record<string, LaneWaitStatus>;
}

export function UnitLaneBoardView({
  unitPlan,
  units,
  streamsBySlug,
  runningStageBySlug,
  unitPrs = [],
  feedbackBatches = [],
  onViewLiveOutput,
  onAddressFeedback,
  laneWaitBySlug = {},
}: UnitLaneBoardViewProps) {
  const unitByLane = useMemo(() => {
    const m = new Map<string, IntentUnit>();
    for (const u of units) m.set(unitLaneKey(u.sectionIndex, u.slug), u);
    return m;
  }, [units]);
  const sections = useMemo(
    () =>
      [...new Set(units.map((unit) => unit.sectionIndex ?? null))].toSorted((a, b) => {
        if (a === null) return -1;
        if (b === null) return 1;
        return a - b;
      }),
    [units],
  );

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
    const counts = new Map<DisplayState, number>();
    for (const u of units) {
      if (!planSlugs.has(u.slug)) continue;
      const wait = laneWaitBySlug[unitLaneKey(u.sectionIndex, u.slug)];
      const displayState: DisplayState =
        wait?.kind === 'recovery'
          ? 'NEEDS_RECOVERY'
          : wait?.kind === 'input'
            ? 'WAITING_INPUT'
            : u.state;
      counts.set(displayState, (counts.get(displayState) ?? 0) + 1);
    }
    return STATE_ORDER.filter((s) => counts.has(s)).map((s) => ({
      state: s,
      count: counts.get(s) as number,
    }));
  }, [units, planSlugs, laneWaitBySlug]);

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
        <div className="space-y-5">
          {sections.map((sectionIndex) => (
            <section key={sectionIndex ?? 'legacy'}>
              {sections.length > 1 && (
                <h3 className="mb-2 text-xs font-semibold">
                  {sectionIndex === null ? 'Legacy section' : `Section ${sectionIndex}`}
                </h3>
              )}
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
                            const key = unitLaneKey(sectionIndex, slug);
                            const unit = unitByLane.get(key);
                            if (!unit) return null;
                            return (
                              <UnitCard
                                key={key}
                                unit={unit}
                                prs={unitPrs.filter(
                                  (pr) =>
                                    pr.sectionIndex === sectionIndex && pr.unitSlug === unit.slug,
                                )}
                                feedbackBatches={feedbackBatches.filter(
                                  (batch) =>
                                    batch.sectionIndex === sectionIndex &&
                                    batch.unitSlug === unit.slug,
                                )}
                                isWalkingSkeleton={unitPlan.walkingSkeleton === slug}
                                runningStageInstanceId={
                                  runningStageBySlug[key] ?? runningStageBySlug[slug] ?? null
                                }
                                stream={streamsBySlug[key] ?? streamsBySlug[slug] ?? null}
                                onViewLiveOutput={onViewLiveOutput}
                                onAddressFeedback={onAddressFeedback}
                                laneWait={laneWaitBySlug[key] ?? null}
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
            </section>
          ))}
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
  const { detail, stageRows, gates, outputBuffers, ensureOutputs, outputVersion } = useIntent();
  const unitPlan = detail?.unitPlan ?? null;
  const units = useMemo(() => detail?.units ?? [], [detail?.units]);
  const unitPrs = useMemo(() => detail?.unitPrs ?? [], [detail?.unitPrs]);
  const feedbackBatches = useMemo(() => detail?.feedbackBatches ?? [], [detail?.feedbackBatches]);
  const [reviewUnit, setReviewUnit] = useState<IntentUnit | null>(null);
  const laneWaitBySlug = useMemo(
    () => deriveLaneWaits(detail?.stages ?? [], gates),
    [detail?.stages, gates],
  );

  // Resolve each unit's RUNNING stage instance. findLast + the stageInstanceId
  // guard is the safer default if retries or duplicate live rows appear. Keys on
  // the stage row's RUNNING state, NOT unit.state (MERGING has no transcript).
  const runningStageBySlug = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const u of units) {
      const row = (stageRows as IntentStageRow[]).findLast(
        (r) =>
          r.unitSlug === u.slug &&
          (r.sectionIndex ?? null) === (u.sectionIndex ?? null) &&
          r.state === 'RUNNING' &&
          r.stageInstanceId,
      );
      out[unitLaneKey(u.sectionIndex, u.slug)] = row?.stageInstanceId ?? null;
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

  // Keep the complete unit review history visible after fan-in. IntentView
  // still uses isFanoutActive to decide whether the single running-stage card
  // should yield to this board while lanes are live.
  if (!unitPlan || units.length === 0) return null;

  return (
    <>
      <UnitLaneBoardView
        unitPlan={unitPlan}
        units={units}
        streamsBySlug={streamsBySlug}
        runningStageBySlug={runningStageBySlug}
        unitPrs={unitPrs}
        feedbackBatches={feedbackBatches}
        laneWaitBySlug={laneWaitBySlug}
        onViewLiveOutput={onViewLiveOutput}
        onAddressFeedback={setReviewUnit}
      />
      <UnitReviewDrawer unit={reviewUnit} onClose={() => setReviewUnit(null)} />
    </>
  );
}

function UnitReviewDrawer({ unit, onClose }: { unit: IntentUnit | null; onClose: () => void }) {
  const { projectId, intentId } = useIntent();
  const [comments, setComments] = useState<UnitReviewComment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!unit || unit.sectionIndex == null) return;
    let live = true;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    intentsService
      .unitReviewComments(projectId, intentId, unit.sectionIndex, unit.slug)
      .then(({ comments: rows }) => {
        if (live) setComments(rows);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, intentId, unit]);

  const submit = async () => {
    if (!unit || unit.sectionIndex == null || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await intentsService.addressUnitFeedback(
        projectId,
        intentId,
        unit.sectionIndex,
        unit.slug,
        comments
          .filter((comment) => selected.has(reviewCommentSelectionKey(comment)))
          .map((comment) => ({
            repository: comment.repository,
            commentId: comment.id,
          })),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue feedback');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={Boolean(unit)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review feedback</SheetTitle>
          <SheetDescription>
            {unit ? `Section ${unit.sectionIndex} · ${unit.slug}` : ''}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 pr-3">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading comments
            </div>
          )}
          {!loading && comments.length === 0 && !error && (
            <p className="py-8 text-sm text-muted-foreground">No review comments</p>
          )}
          <div className="space-y-2 py-2">
            {comments.map((comment) => {
              const key = reviewCommentSelectionKey(comment);
              return (
                <label
                  key={`${key}:${comment.version}`}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-md border p-3',
                    comment.previouslySelected && 'cursor-default opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={selected.has(key)}
                    disabled={comment.previouslySelected}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {comment.user.login ?? 'Unknown'}
                      </span>
                      <span>{comment.repository}</span>
                      {comment.path && (
                        <code>
                          {comment.path}
                          {comment.line ? `:${comment.line}` : ''}
                        </code>
                      )}
                      {comment.previouslySelected && <span>handled</span>}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-sm">
                      {comment.body}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {error && <p className="py-2 text-sm text-agent-error">{error}</p>}
        </ScrollArea>
        <SheetFooter className="pt-3">
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || selected.size === 0 || selected.size > 20}
            className="gap-2"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageSquare className="h-4 w-4" />
            )}
            Address feedback
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
