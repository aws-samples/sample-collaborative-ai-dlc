import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatusPill } from '@/components/ui/status-pill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { completionExplanation } from '@/lib/completionExplanation';
import { cn } from '@/lib/utils';
import { humanizeSlug } from '@/lib/displayNames';
import {
  getStatus,
  isTerminalIntentStatus,
  TONE_CLASSES,
  type StatusTone,
  type UnitStatusKey,
} from '@/lib/statusModel';
import { deriveLaneWaits, laneWaitKey, type LaneWaitStatus } from '@/lib/intentRecovery';
import { useIntent, useVisibleOutputPanes, type IntentStageRow } from '@/contexts/IntentContext';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import { gitRepoSlug } from '@/services/gitProvider';
import type { PhaseNode } from '@/services/workflows';
import {
  intentsService,
  type IntentDetail,
  type IntentFeedbackBatch,
  type IntentPullRequest,
  type IntentUnit,
  type IntentUnitPlan,
  type IntentUnitPr,
  type UnitPrState,
  type UnitReviewComment,
  type UnitState,
} from '@/services/intents';
import {
  ExternalLink,
  GitPullRequest,
  Hammer,
  Loader2,
  MessageSquare,
  RefreshCw,
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

type DisplayState = UnitStatusKey;

const displayStateOf = (unit: IntentUnit, laneWait?: LaneWaitStatus | null): DisplayState =>
  laneWait?.kind === 'recovery'
    ? 'NEEDS_RECOVERY'
    : laneWait?.kind === 'input'
      ? 'WAITING_INPUT'
      : unit.state;

const CARD_TONE: Record<StatusTone, string> = {
  neutral: 'border-border',
  info: 'border-border',
  running: 'border-agent-running/50 bg-agent-running/[0.06]',
  waiting: 'border-agent-waiting/50 bg-agent-waiting/[0.06]',
  success: 'border-agent-success/40',
  danger: 'border-agent-error/50 bg-agent-error/[0.06]',
  warning: 'border-warning/50 bg-warning/[0.08]',
};

// Order used for the one-line summary (only present states rendered).
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
const PR_NEEDS_ATTENTION: ReadonlySet<UnitPrState> = new Set([
  'CONFLICTED',
  'FAILED',
  'CLOSED',
  'PARTIALLY_MERGED',
]);
const unitLaneKey = laneWaitKey;
const unitName = (slug: string) => humanizeSlug(slug);
const repoShortName = (repository: string | null | undefined) =>
  repository ? (gitRepoSlug(repository).split('/').pop() ?? repository) : null;
const reviewCommentSelectionKey = (comment: UnitReviewComment) =>
  `${comment.repository}:${comment.id}`;
const isAutomated = (comment: UnitReviewComment) => comment.bot || comment.system;
// The unit states in which the feedback API accepts a batch. The drawer
// loads the comments itself, so the stored commentCount (written only by
// that load) must not decide whether the drawer can be opened.
const FEEDBACK_UNIT_STATES: ReadonlySet<UnitState> = new Set([
  'PR_DRAFT',
  'RECONCILING',
  'PR_READY',
  'ADDRESSING_FEEDBACK',
]);
const canReviewFeedback = (unit: IntentUnit, prs: IntentUnitPr[]) =>
  FEEDBACK_UNIT_STATES.has(unit.state) &&
  prs.some((pr) => pr.number != null && pr.state !== 'UNCHANGED' && pr.state !== 'CLOSED');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  completionNote?: string;
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
  completionNote,
}: UnitCardProps) {
  useTick((unit.state === 'RUNNING' && !laneWait) || unit.state === 'MERGING');
  const displayState = displayStateOf(unit, laneWait);
  const entry = getStatus('unit', displayState);
  const elapsed =
    unit.startedAt && (unit.state === 'RUNNING' || unit.state === 'MERGING')
      ? formatDuration(unit.startedAt, laneWait?.since ?? null)
      : null;
  const showStream = runningStageInstanceId !== null && stream;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        CARD_TONE[entry.tone],
        displayState === 'PENDING' && 'opacity-70',
      )}
      data-unit-slug={unit.slug}
      data-unit-state={displayState}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">{unitName(unit.slug)}</p>
          {isWalkingSkeleton && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    size="sm"
                    tabIndex={0}
                    className="mt-1 gap-1 font-normal text-phase-construction"
                  >
                    <Hammer aria-hidden="true" />
                    Walking skeleton
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Built on its own first to validate the plan.</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <StatusPill kind="unit" status={displayState} hint className="shrink-0" />
      </div>

      {(unit.dependsOn.length > 0 || elapsed) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          {unit.dependsOn.length > 0 && (
            <span className="min-w-0 flex-1">
              Depends on{' '}
              {unit.dependsOn.map((dep, i) => (
                <span key={dep}>
                  {i > 0 && ', '}
                  <span className="text-foreground/80">{unitName(dep)}</span>
                </span>
              ))}
            </span>
          )}
          {elapsed && <span className="ml-auto shrink-0 tabular-nums">{elapsed}</span>}
        </div>
      )}

      {unit.state === 'BLOCKED' && unit.blockedOn && (
        <p className="mt-1.5 text-xs text-warning-fg">Waiting: {unit.blockedOn}</p>
      )}
      {completionNote && <p className="mt-1 text-xs text-muted-foreground">{completionNote}</p>}
      {unit.integrationOwner && (
        <p className="mt-1.5 text-xs font-medium text-warning-fg">Integration turn</p>
      )}
      {unit.blockedReason && (
        <p className="mt-1 text-xs text-muted-foreground">{unit.blockedReason}</p>
      )}
      {laneWait && (
        <p
          className={cn(
            'mt-1.5 text-xs',
            laneWait.kind === 'recovery'
              ? 'font-medium text-agent-error-fg'
              : 'text-agent-waiting-fg',
          )}
        >
          {laneWait.blocker}
        </p>
      )}
      {unit.state === 'MERGING' && (
        <p className="mt-1.5 text-xs text-agent-running-fg">Merging back&hellip;</p>
      )}
      {unit.state === 'FAILED' && unit.failureReason && (
        <p className="mt-1.5 text-xs text-agent-error-fg">{unit.failureReason}</p>
      )}

      {prs.length > 0 && (
        <ul className="mt-2 space-y-1 border-t pt-2">
          {prs.map((pr) => {
            const prEntry = getStatus('unit', pr.state);
            return (
              <li
                key={`${pr.repository}:${pr.number ?? 'unchanged'}`}
                className="flex min-w-0 items-center gap-2 text-xs"
              >
                <GitPullRequest
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{pr.repository}</span>
                <span
                  className={cn(
                    'shrink-0 font-medium',
                    PR_NEEDS_ATTENTION.has(pr.state)
                      ? 'text-agent-error-fg'
                      : TONE_CLASSES[prEntry.tone].text,
                  )}
                >
                  {prEntry.label}
                </span>
                {pr.commentCount > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
                    <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
                    {pr.commentCount}
                    <span className="sr-only"> comments</span>
                  </span>
                )}
                {pr.url && (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${pr.repository} pull request`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {feedbackBatches.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {feedbackBatches.slice(-2).map((batch) => {
            const batchEntry = getStatus('stage', batch.state);
            const hasDetail = Boolean(
              batch.output ||
              batch.changedFiles?.length ||
              batch.verification ||
              batch.failureReason,
            );
            return (
              <Disclosure
                key={batch.batchId}
                variant="inline"
                title={`${plural(batch.comments.length, 'comment')} · ${batchEntry.label}`}
                status={
                  <StatusPill
                    kind="stage"
                    status={batch.state}
                    className="[&>span:last-child]:sr-only"
                  />
                }
              >
                {hasDetail ? (
                  <div className="space-y-1 border-l pl-2 text-xs text-muted-foreground">
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
                    {batch.failureReason && (
                      <p className="text-agent-error-fg">{batch.failureReason}</p>
                    )}
                    {batch.commitSha && (
                      <p>
                        Commit <code className="font-mono">{batch.commitSha.slice(0, 8)}</code>
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No output recorded yet.</p>
                )}
              </Disclosure>
            );
          })}
        </div>
      )}

      {showStream && (
        <div className="mt-2 flex h-20 flex-col justify-end overflow-hidden rounded-md bg-zinc-950 p-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-zinc-300">
            {stream}
            <span className="ml-0.5 inline-block h-2.5 w-1 bg-zinc-500 align-middle motion-safe:animate-pulse" />
          </pre>
        </div>
      )}

      {(runningStageInstanceId && onViewLiveOutput) ||
      (canReviewFeedback(unit, prs) && onAddressFeedback) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {runningStageInstanceId && onViewLiveOutput && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onViewLiveOutput(runningStageInstanceId)}
            >
              View live output
            </Button>
          )}
          {canReviewFeedback(unit, prs) && onAddressFeedback && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onAddressFeedback(unit)}
            >
              <MessageSquare aria-hidden="true" />
              Address feedback
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Presentational board (pure — tested in isolation) ────────────────────────
export interface UnitLaneBoardViewProps {
  /** How a finished run's units ended (unfinished or skipped units). */
  completion?: IntentDetail['unitCompletion'];
  intentBranch?: string | null;
  /**
   * Name the intent branch in the summary line. Off once the run has finished:
   * the outcome callout above the board already states the branch, and one
   * screen names it once.
   */
  branchInSummary?: boolean;
  unitPlan: IntentUnitPlan;
  units: IntentUnit[];
  /** Live transcript tail per unit slug (only running units need an entry). */
  streamsBySlug: Record<string, string | null>;
  /** RUNNING stageInstanceId per unit slug (null when the unit isn't building). */
  runningStageBySlug: Record<string, string | null>;
  unitPrs?: IntentUnitPr[];
  feedbackBatches?: IntentFeedbackBatch[];
  /** The run-level pull requests (intent branch → base), one per repository. */
  pullRequests?: IntentPullRequest[];
  /** Open a building lane's full output in the sidebar (per-unit, keyed by
   *  that lane's stageInstanceId — during fan-out each lane streams separately). */
  onViewLiveOutput?: (stageInstanceId: string) => void;
  onAddressFeedback?: (unit: IntentUnit) => void;
  laneWaitBySlug?: Record<string, LaneWaitStatus>;
}

interface UnitSummary {
  total: number;
  integrated: number;
  segments: { state: DisplayState; label: string }[];
}

function integratedLabel({ total, integrated }: UnitSummary): string | null {
  if (integrated === 0) return null;
  if (integrated === total) {
    if (total === 1) return 'integrated';
    if (total === 2) return 'both integrated';
    return `all ${total} integrated`;
  }
  return `${integrated} of ${total} integrated`;
}

export function UnitLaneBoardView({
  completion,
  intentBranch,
  branchInSummary = true,
  unitPlan,
  units,
  streamsBySlug,
  runningStageBySlug,
  unitPrs = [],
  feedbackBatches = [],
  pullRequests = [],
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
    return new Set((unitPlan.units ?? []).map((u) => u.slug));
  }, [unitPlan.units]);

  const summary = useMemo<UnitSummary>(() => {
    const counts = new Map<DisplayState, number>();
    let total = 0;
    for (const u of units) {
      if (!planSlugs.has(u.slug)) continue;
      total += 1;
      const state = displayStateOf(u, laneWaitBySlug[unitLaneKey(u.sectionIndex, u.slug)]);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const integrated = counts.get('MERGED') ?? 0;
    const segments = STATE_ORDER.filter((s) => s !== 'MERGED' && counts.has(s)).map((s) => ({
      state: s,
      label: `${counts.get(s)} ${getStatus('unit', s).label.toLowerCase()}`,
    }));
    return { total, integrated, segments };
  }, [units, planSlugs, laneWaitBySlug]);

  const allIntegrated = summary.total > 0 && summary.integrated === summary.total;
  const waves = unitPlan.batches ?? [];
  const finalPrs = pullRequests.filter((pr) => pr.prUrl);
  const integrated = integratedLabel(summary);

  const description = (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span className="text-foreground">{plural(summary.total, 'unit')}</span>
      {integrated && (
        <span>
          <span aria-hidden="true">· </span>
          {integrated}
          {intentBranch && branchInSummary && (
            <>
              {' '}
              into <code className="break-all font-mono text-foreground">{intentBranch}</code>
            </>
          )}
        </span>
      )}
      {summary.segments.map(({ state, label }) => (
        <span key={state} className={cn(TONE_CLASSES[getStatus('unit', state).tone].text)}>
          <span aria-hidden="true" className="text-muted-foreground">
            ·{' '}
          </span>
          {label}
        </span>
      ))}
    </span>
  );

  return (
    <Disclosure
      variant="card"
      title="Units"
      headingLevel={2}
      defaultOpen={!allIntegrated}
      description={description}
      actions={
        finalPrs.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            {finalPrs.map((pr) => (
              <Button key={pr.id} asChild size="xs" variant="outline">
                <a href={pr.prUrl ?? undefined} target="_blank" rel="noreferrer">
                  <GitPullRequest aria-hidden="true" />
                  PR{pr.prNumber ? ` #${pr.prNumber}` : ''}
                  {finalPrs.length > 1 && repoShortName(pr.repository)
                    ? ` · ${repoShortName(pr.repository)}`
                    : ''}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            ))}
          </span>
        ) : undefined
      }
    >
      {completion?.state === 'incomplete' ? (
        <p className="mb-3 flex items-center gap-2 text-xs text-warning-fg">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          {plural(completion.unresolved.length, 'unfinished unit')}:{' '}
          {completion.unresolved.map((unit) => unit.slug).join(', ')}
        </p>
      ) : completion?.state === 'partial' ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {plural(completion.skipped, 'unit')} skipped by decision
        </p>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">
          {plural(waves.length, 'wave')}
          {unitPlan.autonomyMode ? ` · ${humanizeSlug(unitPlan.autonomyMode)} mode` : ''}
          {intentBranch
            ? '. Integrated units land on the intent branch; the final pull request is reviewed and merged separately.'
            : '.'}
        </p>
      )}
      <div className="space-y-5">
        {sections.map((sectionIndex) => (
          <section key={sectionIndex ?? 'legacy'}>
            {sections.length > 1 && (
              <h3 className="mb-2 text-xs font-semibold">
                {sectionIndex === null ? 'Legacy section' : `Section ${sectionIndex}`}
              </h3>
            )}
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
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        <span className="font-semibold">Wave {waveIdx + 1}</span>
                        <span className="rounded-full border px-1.5 text-2xs tabular-nums text-muted-foreground">
                          {slugs.length}
                        </span>
                        <span className="text-muted-foreground">{label}</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {slugs.map((slug) => {
                          const key = unitLaneKey(sectionIndex, slug);
                          const unit = unitByLane.get(key);
                          if (!unit) return null;
                          const unresolved = completion?.unresolved.find(
                            (entry) => entry.sectionIndex === sectionIndex && entry.slug === slug,
                          );
                          return (
                            <UnitCard
                              key={key}
                              unit={unit}
                              completionNote={
                                unresolved && unresolved.reason !== 'unit_unfinished'
                                  ? completionExplanation(unresolved.reason)
                                  : undefined
                              }
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
                          <p className="py-2 text-xs text-muted-foreground">No units</p>
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
    </Disclosure>
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

export function isBeforeConstructionPhase(
  currentPhasePath: string | null,
  workflowPhases: PhaseNode[] | null,
): boolean {
  if (!currentPhasePath || !workflowPhases) return false;
  const constructionPhase = workflowPhases.find((phase) => phase.phaseId === 'construction');
  return Boolean(constructionPhase && currentPhasePath < constructionPhase.path);
}

export function UnitLaneBoard({
  onViewLiveOutput,
}: { onViewLiveOutput?: (stageInstanceId: string) => void } = {}) {
  const {
    detail,
    stageRows,
    gates,
    outputBuffers,
    outputVersion,
    currentPhasePath,
    workflowPhases,
  } = useIntent();
  const unitPlan = detail?.unitPlan ?? null;
  const units = useMemo(() => detail?.units ?? [], [detail?.units]);
  const unitPrs = useMemo(() => detail?.unitPrs ?? [], [detail?.unitPrs]);
  const feedbackBatches = useMemo(() => detail?.feedbackBatches ?? [], [detail?.feedbackBatches]);
  const pullRequests = useMemo(() => detail?.pullRequests ?? [], [detail?.pullRequests]);
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

  // Lazily seed the transcript pane for each running unit, kept visible while shown.
  useVisibleOutputPanes(Object.values(runningStageBySlug));

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
  if (
    !unitPlan ||
    units.length === 0 ||
    isBeforeConstructionPhase(currentPhasePath, workflowPhases)
  ) {
    return null;
  }

  return (
    <>
      <UnitLaneBoardView
        completion={detail?.intent.status === 'SUCCEEDED' ? detail.unitCompletion : null}
        intentBranch={detail?.intent.branch}
        branchInSummary={!isTerminalIntentStatus(detail?.intent.status)}
        unitPlan={unitPlan}
        units={units}
        streamsBySlug={streamsBySlug}
        runningStageBySlug={runningStageBySlug}
        unitPrs={unitPrs}
        feedbackBatches={feedbackBatches}
        pullRequests={pullRequests}
        laneWaitBySlug={laneWaitBySlug}
        onViewLiveOutput={onViewLiveOutput}
        onAddressFeedback={setReviewUnit}
      />
      <UnitReviewDrawer unit={reviewUnit} onClose={() => setReviewUnit(null)} />
    </>
  );
}

// ── Review feedback drawer ───────────────────────────────────────────────────
const MAX_SELECTED_COMMENTS = 20;

function ReviewCommentRow({
  comment,
  checked,
  readOnly,
  onChange,
}: {
  comment: UnitReviewComment;
  checked: boolean;
  /** The drawer's rule: space read-only, or no decision on the producing stage. */
  readOnly: boolean;
  onChange: (checked: boolean) => void;
}) {
  const key = reviewCommentSelectionKey(comment);
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border p-3 hover:bg-muted/40',
        comment.previouslySelected && 'cursor-default opacity-60 hover:bg-transparent',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0"
        checked={checked}
        disabled={readOnly || comment.previouslySelected}
        aria-label={comment.body}
        onChange={(event) => onChange(event.target.checked)}
        data-comment-key={key}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{comment.user.login ?? 'Unknown'}</span>
          {isAutomated(comment) && (
            <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
              Automated
            </Badge>
          )}
          <span className="truncate">{repoShortName(comment.repository)}</span>
          {comment.path && (
            <code className="break-all font-mono">
              {comment.path}
              {comment.line ? `:${comment.line}` : ''}
            </code>
          )}
          {comment.previouslySelected && (
            <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
              Already handled
            </Badge>
          )}
        </span>
        <span className="mt-1 block whitespace-pre-wrap break-words text-sm">{comment.body}</span>
      </span>
    </label>
  );
}

export function UnitReviewDrawer({
  unit,
  onClose,
}: {
  unit: IntentUnit | null;
  onClose: () => void;
}) {
  const { projectId, intentId, stageRows, stageAccess, enforceStageRoles } = useIntent();
  const { readOnly: spaceReadOnly } = useSpacePermissions();
  const producer = stageRows
    .filter(
      (row) =>
        unit &&
        row.unitSlug === unit.slug &&
        row.sectionIndex === unit.sectionIndex &&
        row.state === 'SUCCEEDED',
    )
    .toSorted((a, b) => b.order - a.order)[0];
  const readOnly =
    spaceReadOnly ||
    (enforceStageRoles !== false && (!producer || !stageAccess(producer.stageInstanceId)?.decide));
  const [comments, setComments] = useState<UnitReviewComment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Refresh: comments can arrive while the drawer is open.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    setSelected(new Set());
  }, [unit]);

  useEffect(() => {
    if (!unit || unit.sectionIndex == null) return;
    let live = true;
    setLoading(true);
    setError(null);
    intentsService
      .unitReviewComments(projectId, intentId, unit.sectionIndex, unit.slug)
      .then(({ comments: rows }) => {
        if (!live) return;
        setComments(rows);
        // Keep a refresh from dropping choices that are still selectable.
        const selectable = new Set(
          rows
            .filter((comment) => !comment.previouslySelected)
            .map((comment) => reviewCommentSelectionKey(comment)),
        );
        setSelected((current) => new Set([...current].filter((key) => selectable.has(key))));
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
  }, [projectId, intentId, unit, reloads]);

  const humanComments = comments.filter((comment) => !isAutomated(comment));
  const automatedComments = comments.filter(isAutomated);
  const selectableHuman = humanComments.filter((comment) => !comment.previouslySelected);
  const selectableTotal = comments.filter((comment) => !comment.previouslySelected).length;
  const allHumanSelected =
    selectableHuman.length > 0 &&
    selectableHuman.every((comment) => selected.has(reviewCommentSelectionKey(comment)));

  const toggle = (comment: UnitReviewComment, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      const key = reviewCommentSelectionKey(comment);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const selectAllHuman = () =>
    setSelected(new Set(selectableHuman.map((comment) => reviewCommentSelectionKey(comment))));

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

  const tooMany = selected.size > MAX_SELECTED_COMMENTS;

  return (
    <Sheet open={Boolean(unit)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review feedback</SheetTitle>
          <SheetDescription>
            {unit ? `${unitName(unit.slug)} · Section ${unit.sectionIndex}` : ''}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 pr-3">
          {loading && (
            <div
              role="status"
              className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Loading comments
            </div>
          )}
          {!loading && comments.length === 0 && !error && (
            <p className="py-8 text-sm text-muted-foreground">No review comments yet.</p>
          )}
          {!loading && comments.length > 0 && (
            <div className="space-y-2 py-2">
              {humanComments.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {plural(humanComments.length, 'reviewer comment')}
                  </p>
                  {!readOnly && selectableHuman.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={allHumanSelected ? () => setSelected(new Set()) : selectAllHuman}
                    >
                      {allHumanSelected ? 'Clear selection' : 'Select all'}
                    </Button>
                  )}
                </div>
              )}
              {humanComments.map((comment) => (
                <ReviewCommentRow
                  key={`${reviewCommentSelectionKey(comment)}:${comment.version}`}
                  comment={comment}
                  checked={selected.has(reviewCommentSelectionKey(comment))}
                  readOnly={readOnly}
                  onChange={(checked) => toggle(comment, checked)}
                />
              ))}
              {automatedComments.length > 0 && (
                <Disclosure
                  variant="row"
                  title={plural(automatedComments.length, 'automated comment')}
                  description="From bots and CI; usually nothing for the agent to address."
                  contentClassName="space-y-2"
                >
                  {automatedComments.map((comment) => (
                    <ReviewCommentRow
                      key={`${reviewCommentSelectionKey(comment)}:${comment.version}`}
                      comment={comment}
                      checked={selected.has(reviewCommentSelectionKey(comment))}
                      readOnly={readOnly}
                      onChange={(checked) => toggle(comment, checked)}
                    />
                  ))}
                </Disclosure>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="py-2 text-sm text-agent-error-fg">
              {error}
            </p>
          )}
        </ScrollArea>
        <SheetFooter className="gap-2 border-t pt-3 sm:items-center">
          <p
            className={cn(
              'mr-auto text-xs tabular-nums',
              tooMany ? 'text-agent-error-fg' : 'text-muted-foreground',
            )}
          >
            {comments.length > 0
              ? tooMany
                ? `Select at most ${MAX_SELECTED_COMMENTS} comments per batch`
                : `${selected.size} of ${selectableTotal} selected`
              : ''}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setReloads((count) => count + 1)}
            disabled={loading || submitting}
          >
            <RefreshCw aria-hidden="true" className={cn(loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            onClick={submit}
            loading={submitting}
            disabled={readOnly || submitting || selected.size === 0 || tooMany}
          >
            {!submitting && <MessageSquare aria-hidden="true" />}
            Address feedback
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
