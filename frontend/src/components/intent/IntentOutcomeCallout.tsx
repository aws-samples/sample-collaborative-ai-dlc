import * as React from 'react';
import { Link } from 'react-router';
import {
  Ban,
  CircleCheck,
  CircleX,
  ExternalLink,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
  PencilLine,
  Play,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription, type AlertProps } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { TechnicalDetails, type TechnicalDetailItem } from '@/components/ui/technical-details';
import { gateTabLabel } from '@/components/intent/PendingQuestionsTabs';
import { displayStageName } from '@/lib/displayNames';
import { describeFailure } from '@/lib/failureReasons';
import { formatCost, summarizeCost } from '@/lib/metricAggregation';
import { intentAttention } from '@/lib/sprintStatus';
import { ageLabel, deriveIntentStatus, latestActivityAt } from '@/lib/statusModel';
import { formatAbsolute } from '@/lib/timeAgo';
import { gitRepoSlug } from '@/services/gitProvider';
import type { IntentDetail, IntentGate, IntentStage } from '@/services/intents';
import { cn } from '@/lib/utils';
import { countWorkProductDocuments } from '@/components/intent/documentHelpers';

export interface IntentOutcomeLinks {
  /** Where "View activity" goes (Overview → Work). */
  details?: string;
  /** Where "N documents" goes (the Work products tree). */
  documents?: string;
  /** Agent output for a failed run ("Open logs"). */
  logs?: string;
  /** DRAFT: the compose page ("Continue composing"). */
  compose?: string;
  /** FAILED: create page prefilled from this intent ("Start on another AI-DLC version"). */
  newVersion?: string;
  /** Per-gate destination when no `onAnswer` is given (validation → /review/:id). */
  gate?: (gate: IntentGate) => string;
}

export interface IntentOutcomeAction {
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}

export interface IntentOutcomeActions {
  /** Rewind to the failed (or, when stalled, current) stage. The label names the stage. */
  restartFromStage?: IntentOutcomeAction;
  /** Run the plan again from the beginning. */
  startAgain?: IntentOutcomeAction;
  /** Re-send a recorded answer whose callback failed (`intent.resumeRequired`). */
  resume?: IntentOutcomeAction;
  /** Inspect or retry publication after success (secondary). */
  checkDelivery?: IntentOutcomeAction;
}

export interface IntentOutcomeCalloutProps {
  detail: IntentDetail;
  /** Injected clock for ages and durations. */
  now?: number | Date;
  /** Newest event/stage/output timestamp the caller knows; merged with the detail's own. */
  lastActivityAt?: string | null;
  /** Compiled node name for a stage id; falls back to the humanized slug. */
  stageNameOf?: (stageId: string) => string | null | undefined;
  /** Opens the gate card in place; when absent, `links.gate` renders a link instead. */
  onAnswer?: (gateId: string) => void;
  /**
   * Opens the activity panel on a stage's output, in place (the Work page).
   * When absent, `links.details` renders a link instead (the Overview page).
   */
  onViewActivity?: (stageInstanceId: string | null) => void;
  links?: IntentOutcomeLinks;
  actions?: IntentOutcomeActions;
  className?: string;
}

export type IntentOutcomeKind =
  | 'draft'
  | 'created'
  | 'running'
  | 'stalled'
  | 'waiting'
  | 'waiting_engine'
  | 'resume_required'
  | 'failed'
  | 'succeeded'
  | 'cancelled';

type Tone = NonNullable<AlertProps['tone']>;

interface Surface {
  tone: Tone;
  className?: string;
  icon: LucideIcon;
  iconClassName?: string;
}

const SURFACE: Record<IntentOutcomeKind, Surface> = {
  draft: { tone: 'neutral', icon: PencilLine },
  created: { tone: 'info', icon: Hourglass },
  running: {
    tone: 'info',
    className: 'border-agent-running/30 bg-agent-running/5',
    icon: LoaderCircle,
    iconClassName: 'text-agent-running-fg',
  },
  stalled: { tone: 'warning', icon: TriangleAlert },
  waiting: {
    tone: 'neutral',
    className: 'border-agent-waiting/30 bg-agent-waiting/10',
    icon: MessageCircleQuestion,
    iconClassName: 'text-agent-waiting-fg',
  },
  waiting_engine: { tone: 'info', icon: Hourglass },
  resume_required: { tone: 'warning', icon: TriangleAlert },
  failed: { tone: 'danger', icon: CircleX },
  succeeded: { tone: 'success', icon: CircleCheck },
  cancelled: { tone: 'neutral', icon: Ban },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

function formatElapsed(ms: number): string {
  if (ms < MINUTE) return 'under 1 min';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return hours ? `${plural(days, 'day')} ${hours} h` : plural(days, 'day');
}

const toMs = (value: string | null | undefined) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

const repoShortName = (repository: string | null | undefined) =>
  repository ? (gitRepoSlug(repository).split('/').pop() ?? repository) : null;

interface PullRequestLink {
  key: string;
  href: string;
  label: string;
}

function pullRequestLinks(detail: IntentDetail): PullRequestLink[] {
  const links: PullRequestLink[] = [];
  const seen = new Set<string>();
  const push = (
    href: string | null | undefined,
    number: string | number | null,
    repo: string | null,
  ) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    const short = repoShortName(repo);
    const numberLabel = number != null && number !== '' ? `PR #${number}` : 'Pull request';
    links.push({ key: href, href, label: short ? `${numberLabel} · ${short}` : numberLabel });
  };
  for (const pr of detail.pullRequests ?? []) push(pr.prUrl, pr.prNumber, pr.repository);
  for (const repo of detail.delivery?.repositories ?? []) {
    if (repo.pr) push(repo.pr.prUrl, repo.pr.prNumber, repo.repoId);
  }
  return links;
}

const GATE_VERB: Record<IntentGate['kind'], string> = {
  question: 'Answer',
  validation: 'Review',
  approval: 'Decide',
  'review-verdict': 'Decide',
};

export type OpenDecision =
  | { kind: 'gate'; gate: IntentGate; stage: IntentStage | undefined; since: string | null }
  | { kind: 'stage'; stage: IntentStage; since: string | null };

/**
 * Everything the stage list paints yellow: pending gates, plus stages still
 * WAITING_FOR_HUMAN with no pending gate (answered or withdrawn but never
 * resumed). Oldest first; the first item's `since` is the header age.
 */
export function openDecisions(detail: Pick<IntentDetail, 'stages' | 'gates'>): OpenDecision[] {
  const { stages, gates } = detail;
  const stageById = new Map(stages.map((s) => [s.stageInstanceId, s]));
  const covered = new Set<string>();
  const items: OpenDecision[] = [];
  for (const gate of gates) {
    if (gate.status !== 'pending') continue;
    const stage = gate.stageInstanceId ? stageById.get(gate.stageInstanceId) : undefined;
    if (gate.stageInstanceId) covered.add(gate.stageInstanceId);
    items.push({ kind: 'gate', gate, stage, since: gate.createdAt ?? stage?.parkedAt ?? null });
  }
  for (const stage of stages) {
    if (stage.state !== 'WAITING_FOR_HUMAN' || covered.has(stage.stageInstanceId)) continue;
    items.push({
      kind: 'stage',
      stage,
      since: stage.parkedAt ?? stage.updatedAt ?? stage.startedAt ?? null,
    });
  }
  return items.toSorted((a, b) => (toMs(a.since) ?? Infinity) - (toMs(b.since) ?? Infinity));
}

interface Confirmation {
  title: string;
  description: string;
  confirm: string;
}

function ActionButton({
  action,
  variant = 'outline',
  icon: Icon,
  confirm,
  children,
}: {
  action: IntentOutcomeAction;
  variant?: 'default' | 'outline' | 'ghost';
  icon?: LucideIcon;
  confirm?: Confirmation;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const button = (
    <Button
      type="button"
      size="sm"
      variant={variant}
      loading={action.pending}
      disabled={action.disabled}
      onClick={confirm ? undefined : action.onClick}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </Button>
  );
  if (!confirm) return button;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep run</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              action.onClick();
            }}
          >
            {confirm.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LinkButton({
  to,
  variant = 'outline',
  children,
}: {
  to: string;
  variant?: 'default' | 'outline' | 'ghost';
  children: React.ReactNode;
}) {
  return (
    <Button asChild size="sm" variant={variant}>
      <Link to={to}>{children}</Link>
    </Button>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-2 pt-1">{items}</div>;
}

function Facts({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground">
      {items.map((item, index) => (
        <li key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {item}
        </li>
      ))}
    </ul>
  );
}

function PullRequestFacts({ links }: { links: PullRequestLink[] }) {
  return (
    <>
      {links.map((pr) => (
        <a
          key={pr.key}
          href={pr.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
        >
          {pr.label}
          <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </a>
      ))}
    </>
  );
}

function Branch({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-muted-foreground">Branch</span>
      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{name}</code>
    </span>
  );
}

export function IntentOutcomeCallout({
  detail,
  now = Date.now(),
  lastActivityAt,
  stageNameOf,
  onAnswer,
  onViewActivity,
  links = {},
  actions = {},
  className,
}: IntentOutcomeCalloutProps) {
  const { intent, stages, gates } = detail;
  const stageName = (stageId: string) => displayStageName(stageId, stageNameOf?.(stageId));

  const activity = latestActivityAt([
    lastActivityAt,
    ...stages.map((s) => s.updatedAt ?? s.completedAt ?? s.startedAt),
    ...detail.events.map((e) => e.timestamp),
    intent.updatedAt,
    intent.createdAt,
  ]);
  const derived = deriveIntentStatus(intent, { now, lastActivityAt: activity, gates });

  let kind: IntentOutcomeKind;
  let title: React.ReactNode;
  let body: React.ReactNode = null;
  let pulse = false;

  const currentStageId =
    intent.currentStage ?? stages.find((s) => s.state === 'RUNNING')?.stageId ?? null;
  const currentStageInstanceId =
    stages.find((s) => s.state === 'RUNNING')?.stageInstanceId ??
    stages.find((s) => s.stageId === currentStageId)?.stageInstanceId ??
    null;

  // Every attempt's metrics: the intent's spend so far, not one run's.
  const spentSoFar = summarizeCost(detail.metrics);
  const costSentence =
    spentSoFar && spentSoFar.priced
      ? ` So far this intent has cost ${spentSoFar.estimated ? 'about ' : ''}${formatCost(spentSoFar.totalCost, spentSoFar.currency)}.`
      : '';
  const restartWorkflowConfirm: Confirmation = {
    title: 'Restart this workflow from the beginning?',
    description: `A new run starts and agents begin working — and spending — again. The ${intent.status === 'FAILED' ? 'failed' : 'current'} run stays in history.${costSentence}`,
    confirm: 'Restart workflow',
  };
  const restartStageConfirm = (stageId: string): Confirmation => ({
    title: `Restart from ${stageName(stageId)}?`,
    description: `Agents run this stage and everything after it again, so new costs apply. Completed stages are kept; the previous attempt stays in history.${costSentence}`,
    confirm: 'Restart from this stage',
  });
  const viewActivity = links.details ? (
    <LinkButton to={links.details} variant="ghost">
      View activity
    </LinkButton>
  ) : null;

  switch (intent.status) {
    case 'DRAFT': {
      kind = 'draft';
      title = 'Draft — not started yet';
      body = links.compose ? (
        <ActionRow>
          <LinkButton to={links.compose} variant="default">
            Continue composing
          </LinkButton>
        </ActionRow>
      ) : null;
      break;
    }

    case 'CREATED':
    case 'RUNNING': {
      if (derived.stalled) {
        kind = 'stalled';
        const age = ageLabel(derived.since, now, { coarse: true });
        const neverStarted = intent.status === 'CREATED';
        title = neverStarted
          ? `Stalled before the first stage — requested ${age} ago, never picked up`
          : `Stalled${currentStageId ? ` at ${stageName(currentStageId)}` : ''} — no activity for ${age}`;
        body = (
          <>
            <AlertDescription>
              {neverStarted
                ? 'The run was requested but no agent picked it up. '
                : 'The engine still marks this run as running, so it cannot be cancelled yet. '}
              {actions.restartFromStage || actions.startAgain ? (
                'If it does not pick up again, restart it.'
              ) : (
                <>
                  Check the{' '}
                  {onViewActivity ? (
                    <button
                      type="button"
                      className="-my-1 inline-block py-1 font-medium underline underline-offset-4 hover:text-foreground"
                      aria-label="View activity"
                      onClick={() => onViewActivity(currentStageInstanceId)}
                    >
                      activity
                    </button>
                  ) : (
                    'activity'
                  )}
                  , or come back later: a cancel becomes possible once the engine parks or fails the
                  run.
                </>
              )}
            </AlertDescription>
            <ActionRow>
              {actions.restartFromStage && currentStageId ? (
                <ActionButton
                  action={actions.restartFromStage}
                  icon={RotateCcw}
                  confirm={restartStageConfirm(currentStageId)}
                >
                  Restart from {stageName(currentStageId)}
                </ActionButton>
              ) : null}
              {actions.startAgain ? (
                <ActionButton
                  action={actions.startAgain}
                  icon={Play}
                  confirm={restartWorkflowConfirm}
                >
                  Restart workflow
                </ActionButton>
              ) : null}
              {links.details ? <LinkButton to={links.details}>View activity</LinkButton> : null}
            </ActionRow>
            <TechnicalDetails
              items={[
                { label: 'Last activity', value: formatAbsolute(derived.since) },
                { label: 'Backend status', value: intent.status, copy: true },
                { label: 'Stage id', value: currentStageId, copy: true },
              ]}
            />
          </>
        );
        break;
      }
      if (intent.status === 'CREATED') {
        kind = 'created';
        const age = ageLabel(intent.createdAt ?? intent.updatedAt, now);
        title = age ? `Starting · requested ${age} ago` : 'Starting';
        break;
      }
      kind = 'running';
      pulse = true;
      const age = ageLabel(activity, now);
      const working = currentStageId ? `Working on ${stageName(currentStageId)}` : 'Working';
      title = age ? `${working} · last activity ${age} ago` : working;
      body = viewActivity ? <ActionRow>{viewActivity}</ActionRow> : null;
      break;
    }

    case 'WAITING': {
      const resumeRequired =
        intentAttention(intent) === 'resume' || gates.some((g) => g.resumeAvailable === true);
      const open = openDecisions(detail);
      const count = open.length;
      const allGates = open.every((d) => d.kind === 'gate');

      const resumeBlock = resumeRequired ? (
        <div className="space-y-1">
          {count > 0 ? (
            <p className="text-sm font-medium">
              Your answer was saved but the run did not continue
            </p>
          ) : null}
          <AlertDescription>
            Resume re-sends the recorded answer. No decision is asked again.
          </AlertDescription>
          <ActionRow>
            {actions.resume ? (
              <ActionButton action={actions.resume} variant="default" icon={Play}>
                Resume run
              </ActionButton>
            ) : null}
            {count === 0 && links.details ? (
              <LinkButton to={links.details}>View activity</LinkButton>
            ) : null}
          </ActionRow>
        </div>
      ) : null;

      const decisionList =
        count > 0 ? (
          <ul aria-label="Open decisions" className="divide-y divide-border/60">
            {open.map((decision) =>
              decision.kind === 'gate' ? (
                <GateRow
                  key={decision.gate.humanTaskId}
                  gate={decision.gate}
                  stage={decision.stage}
                  stageName={stageName}
                  onAnswer={onAnswer}
                  href={links.gate?.(decision.gate)}
                />
              ) : (
                <ParkedStageRow
                  key={decision.stage.stageInstanceId}
                  stage={decision.stage}
                  stageName={stageName}
                  href={links.details}
                  onViewActivity={onViewActivity}
                />
              ),
            )}
          </ul>
        ) : null;

      if (count > 0) {
        kind = 'waiting';
        // The header pill carries the age; the callout only says what is open.
        title = allGates
          ? count === 1
            ? '1 decision needs your answer'
            : `${count} decisions need your answer`
          : count === 1
            ? '1 stage is waiting for input'
            : `${count} stages are waiting for input`;
        body = (
          <>
            {decisionList}
            {resumeBlock}
          </>
        );
      } else if (resumeRequired) {
        kind = 'resume_required';
        title = 'Your answer was saved but the run did not continue';
        body = resumeBlock;
      } else {
        kind = 'waiting_engine';
        title = 'Waiting on the engine — no action needed from you';
        body = (
          <AlertDescription>
            The run is parked between steps and will continue on its own.
            {links.details ? (
              <>
                {' '}
                <Link to={links.details} className="underline underline-offset-4">
                  View activity
                </Link>
              </>
            ) : null}
          </AlertDescription>
        );
      }
      break;
    }

    case 'FAILED': {
      kind = 'failed';
      const failure = describeFailure(
        intent.failure?.code,
        intent.failure?.message ?? intent.failureReason,
      );
      const failedStage = stages.find((s) => s.state === 'FAILED');
      const failedStageId = failedStage?.stageId ?? failure.stageId ?? intent.currentStage ?? null;
      title = failedStageId
        ? `Failed at ${stageName(failedStageId)} — ${failure.sentence}`
        : `Failed before the first stage — ${failure.sentence}`;
      const items: TechnicalDetailItem[] = [
        { label: 'Code', value: failure.code, copy: true },
        { label: 'Message', value: failure.technical, copy: true },
        { label: 'Stage id', value: failedStageId, copy: true },
      ];
      if (failedStage?.runtimeError && failedStage.runtimeError !== failure.technical) {
        items.push({ label: 'Runtime error', value: failedStage.runtimeError, copy: true });
      }
      const canRestartStage = Boolean(actions.restartFromStage && failedStageId);
      body = (
        <>
          <ActionRow>
            {actions.restartFromStage && failedStageId ? (
              <ActionButton
                action={actions.restartFromStage}
                variant="default"
                icon={RotateCcw}
                confirm={restartStageConfirm(failedStageId)}
              >
                Restart from {stageName(failedStageId)}
              </ActionButton>
            ) : null}
            {actions.startAgain ? (
              <ActionButton
                action={actions.startAgain}
                variant={canRestartStage ? 'outline' : 'default'}
                icon={Play}
                confirm={restartWorkflowConfirm}
              >
                Restart workflow
              </ActionButton>
            ) : null}
            {links.newVersion ? (
              <LinkButton to={links.newVersion}>Start on another AI-DLC version</LinkButton>
            ) : null}
            {links.logs ? <LinkButton to={links.logs}>Open logs</LinkButton> : null}
            {viewActivity}
          </ActionRow>
          <TechnicalDetails items={items} />
        </>
      );
      break;
    }

    case 'SUCCEEDED': {
      kind = 'succeeded';
      const start =
        toMs(intent.orchestratorStartedAt) ??
        stages
          .map((s) => toMs(s.startedAt))
          .reduce<number | null>(
            (min, ms) => (ms !== null && (min === null || ms < min) ? ms : min),
            null,
          ) ??
        toMs(intent.createdAt);
      const end =
        toMs(intent.completedAt) ??
        stages
          .map((s) => toMs(s.completedAt))
          .reduce<number | null>(
            (max, ms) => (ms !== null && (max === null || ms > max) ? ms : max),
            null,
          );
      title =
        start !== null && end !== null && end >= start
          ? `Completed in ${formatElapsed(end - start)}`
          : 'Completed';
      const prs = pullRequestLinks(detail);
      const documents = countWorkProductDocuments(detail.artifacts);
      const completion = detail.unitCompletion;
      body = (
        <>
          <Facts>
            <PullRequestFacts links={prs} />
            <Branch name={intent.branch} />
            {documents > 0 ? (
              links.documents ? (
                <Link
                  to={links.documents}
                  className="font-medium underline decoration-border underline-offset-4 hover:decoration-current"
                >
                  {plural(documents, 'document')}
                </Link>
              ) : (
                <span>{plural(documents, 'document')}</span>
              )
            ) : null}
          </Facts>
          {completion && completion.state !== 'complete' && completion.total > 0 ? (
            <AlertDescription>
              {completion.integrated} of {completion.total} units integrated
              {completion.skipped ? `, ${completion.skipped} omitted` : ''}.
            </AlertDescription>
          ) : null}
          <ActionRow>
            {actions.checkDelivery ? (
              <ActionButton action={actions.checkDelivery} variant="ghost">
                Check delivery
              </ActionButton>
            ) : null}
          </ActionRow>
        </>
      );
      break;
    }

    case 'CANCELLED': {
      kind = 'cancelled';
      const when = ageLabel(intent.completedAt ?? intent.updatedAt, now);
      title = when ? `Cancelled ${when} ago` : 'Cancelled';
      const prs = pullRequestLinks(detail);
      const units = detail.units ?? [];
      const integrated =
        detail.unitCompletion?.integrated ?? units.filter((u) => u.state === 'MERGED').length;
      const total = detail.unitCompletion?.total ?? units.length;
      const delivered = integrated > 0 || prs.length > 0;
      body = delivered ? (
        <>
          <AlertDescription>
            {integrated > 0
              ? `${integrated} of ${total} units integrated before the run stopped.`
              : 'A pull request was opened before the run stopped.'}
          </AlertDescription>
          <Facts>
            <PullRequestFacts links={prs} />
            <Branch name={intent.branch} />
          </Facts>
        </>
      ) : (
        <AlertDescription>Nothing was delivered.</AlertDescription>
      );
      break;
    }

    default: {
      kind = 'created';
      title = 'Status unavailable';
    }
  }

  const surface = SURFACE[kind];
  const Icon = surface.icon;

  return (
    <Alert
      tone={surface.tone}
      title={title}
      data-slot="intent-outcome"
      data-outcome={kind}
      className={cn(surface.className, className)}
      icon={
        <Icon
          data-pulse={pulse || undefined}
          className={cn(surface.iconClassName, pulse && 'motion-safe:animate-pulse')}
        />
      }
    >
      {body}
    </Alert>
  );
}

const ROW_CLASS =
  'flex flex-col gap-2 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-x-4';

function RowText({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="line-clamp-2 text-sm font-medium">{label}</p>
      {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
    </div>
  );
}

function GateRow({
  gate,
  stage,
  stageName,
  onAnswer,
  href,
}: {
  gate: IntentGate;
  stage: IntentStage | undefined;
  stageName: (stageId: string) => string;
  onAnswer?: (gateId: string) => void;
  href?: string;
}) {
  const stageLabel = stage?.stageId ? stageName(stage.stageId) : null;
  const laneLabel = gate.unitSlug ? ` · ${gate.unitSlug}` : '';
  const question = gate.kind === 'question' ? gateTabLabel(gate) : gate.prompt;
  const label = question ?? (stageLabel ? `Review of ${stageLabel}` : gateTabLabel(gate));
  const subject = gate.kind === 'question' ? label : (stageLabel ?? label);
  const verb = GATE_VERB[gate.kind];
  const meta = gate.kind === 'question' && stageLabel ? `${stageLabel}${laneLabel}` : '';
  const name = `${verb}: ${subject}`;

  return (
    <li className={ROW_CLASS}>
      <RowText label={label} meta={meta} />
      {onAnswer ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="self-start sm:self-auto"
          aria-label={name}
          onClick={() => onAnswer(gate.humanTaskId)}
        >
          {verb}
        </Button>
      ) : href ? (
        <Button asChild size="sm" variant="default" className="self-start sm:self-auto">
          <Link to={href} aria-label={name}>
            {verb}
          </Link>
        </Button>
      ) : null}
    </li>
  );
}

// A stage still parked although every question on it is answered or
// withdrawn: counted, never hidden — there is nothing to answer, so the row
// offers the stage's output instead of pretending a card exists for it.
function ParkedStageRow({
  stage,
  stageName,
  href,
  onViewActivity,
}: {
  stage: IntentStage;
  stageName: (stageId: string) => string;
  href?: string;
  onViewActivity?: (stageInstanceId: string | null) => void;
}) {
  const label = stage.stageId ? stageName(stage.stageId) : 'Stage';
  const lane = stage.unitSlug ? ` · ${stage.unitSlug}` : '';
  const name = `View activity: ${label}`;
  return (
    <li className={ROW_CLASS}>
      <RowText label={`${label}${lane}`} meta="Parked with no open question" />
      {onViewActivity ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start sm:self-auto"
          aria-label={name}
          onClick={() => onViewActivity(stage.stageInstanceId)}
        >
          View activity
        </Button>
      ) : href ? (
        <Button asChild size="sm" variant="outline" className="self-start sm:self-auto">
          <Link to={href} aria-label={name}>
            View activity
          </Link>
        </Button>
      ) : null}
    </li>
  );
}
