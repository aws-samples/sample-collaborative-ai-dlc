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
import { Alert, type AlertProps } from '@/components/ui/alert';
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
import { gateTabLabel } from '@/components/intent/PendingQuestionsTabs';
import { displayStageName } from '@/lib/displayNames';
import { describeFailure } from '@/lib/failureReasons';
import { formatCost, summarizeCost } from '@/lib/metricAggregation';
import { intentAttention } from '@/lib/sprintStatus';
import { ageLabel, deriveIntentStatus, latestActivityAt } from '@/lib/statusModel';
import { gitRepoSlug } from '@/services/gitProvider';
import type { IntentDetail, IntentGate, IntentStage } from '@/services/intents';
import { cn } from '@/lib/utils';

export interface IntentOutcomeLinks {
  /** Where "View activity" goes (Overview → Work). */
  details?: string;
  /** Agent output for a failed run ("Open logs"). */
  logs?: string;
  /** DRAFT: the compose page ("Continue composing"). */
  compose?: string;
  /** Per-gate destination when no `onAnswer` is given (validation → /review/:id). */
  gate?: (gate: IntentGate) => string;
}

export interface IntentOutcomeAction {
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}

export interface IntentOutcomeActions {
  /** Rewind to `stageId`; the line, the button and its confirmation name that stage. */
  restartFromStage?: IntentOutcomeAction & { stageId: string };
  /** Run the plan again from the beginning. */
  startAgain?: IntentOutcomeAction;
  /** Re-send a recorded answer whose callback failed (`intent.resumeRequired`). */
  resume?: IntentOutcomeAction;
  /** Inspect or retry publication after success (secondary). */
  checkDelivery?: IntentOutcomeAction;
}

/**
 * One line that says where the run stands, with at most one action: the
 * details (decisions, documents, errors) live on the Work page and in the
 * stage list, not here.
 */
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
  /** Whether the reader may answer the gate; otherwise the line only says what is open. Default: yes. */
  canAnswer?: (gate: IntentGate) => boolean;
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

export const GATE_VERB: Record<IntentGate['kind'], string> = {
  question: 'Answer',
  validation: 'Review',
  approval: 'Decide',
  'review-verdict': 'Decide',
};

export const GATE_NOUN: Record<IntentGate['kind'], string> = {
  question: 'question',
  validation: 'review',
  approval: 'decision',
  'review-verdict': 'decision',
};

export type OpenDecision =
  | { kind: 'gate'; gate: IntentGate; stage: IntentStage | undefined; since: string | null }
  | { kind: 'stage'; stage: IntentStage; since: string | null };

/**
 * What the reader can act on, oldest first; the first item's `since` is the
 * header age. Pending gates when there are any. Only without one do the
 * stages still parked (WAITING_FOR_HUMAN, their gate answered or withdrawn but
 * never resumed) count: next to an open question they are the stage it waits
 * on, not a second decision.
 */
export function openDecisions(detail: Pick<IntentDetail, 'stages' | 'gates'>): OpenDecision[] {
  const { stages, gates } = detail;
  const stageById = new Map(stages.map((s) => [s.stageInstanceId, s]));
  const items: OpenDecision[] = gates
    .filter((gate) => gate.status === 'pending')
    .map((gate) => {
      const stage = gate.stageInstanceId ? stageById.get(gate.stageInstanceId) : undefined;
      return { kind: 'gate', gate, stage, since: gate.createdAt ?? stage?.parkedAt ?? null };
    });
  if (items.length === 0) {
    for (const stage of stages) {
      if (stage.state !== 'WAITING_FOR_HUMAN') continue;
      items.push({
        kind: 'stage',
        stage,
        since: stage.parkedAt ?? stage.updatedAt ?? stage.startedAt ?? null,
      });
    }
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

function ExternalLinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </a>
    </Button>
  );
}

export function IntentOutcomeCallout({
  detail,
  now = Date.now(),
  lastActivityAt,
  stageNameOf,
  onAnswer,
  canAnswer = () => true,
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
  let title: string;
  let action: React.ReactNode = null;
  let pulse = false;

  const currentStageId =
    intent.currentStage ?? stages.find((s) => s.state === 'RUNNING')?.stageId ?? null;

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
  // Restart from the stage when the caller allows it, else the whole workflow.
  const restartStage = actions.restartFromStage;
  const restartAction = () =>
    restartStage ? (
      <ActionButton
        action={restartStage}
        variant="default"
        icon={RotateCcw}
        confirm={restartStageConfirm(restartStage.stageId)}
      >
        Restart from {stageName(restartStage.stageId)}
      </ActionButton>
    ) : actions.startAgain ? (
      <ActionButton
        action={actions.startAgain}
        variant="default"
        icon={Play}
        confirm={restartWorkflowConfirm}
      >
        Restart workflow
      </ActionButton>
    ) : null;
  const pullRequest = pullRequestLinks(detail)[0];
  const pullRequestAction = pullRequest ? (
    <ExternalLinkButton href={pullRequest.href}>{pullRequest.label}</ExternalLinkButton>
  ) : null;

  switch (intent.status) {
    case 'DRAFT': {
      kind = 'draft';
      title = 'Draft — not started yet';
      action = links.compose ? (
        <LinkButton to={links.compose} variant="default">
          Continue composing
        </LinkButton>
      ) : null;
      break;
    }

    case 'CREATED':
    case 'RUNNING': {
      if (derived.stalled) {
        kind = 'stalled';
        const age = ageLabel(derived.since, now, { coarse: true });
        title =
          intent.status !== 'CREATED'
            ? `Stalled${currentStageId ? ` at ${stageName(currentStageId)}` : ''} — no activity for ${age}`
            : intent.orchestratorStartedAt
              ? `Stalled while preparing the workspace — no activity for ${age}`
              : `Stalled before the first stage — never picked up, no activity for ${age}`;
        action = restartAction();
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
      break;
    }

    case 'WAITING': {
      const resumeRequired =
        intentAttention(intent) === 'resume' || gates.some((g) => g.resumeAvailable === true);
      const open = openDecisions(detail);
      const pending = open.filter((d) => d.kind === 'gate');
      const resumeAction = actions.resume ? (
        <ActionButton action={actions.resume} variant="default" icon={Play}>
          Resume run
        </ActionButton>
      ) : null;

      if (pending.length > 0) {
        kind = 'waiting';
        // Only the gates this reader may answer are "yours"; without any, the
        // line says what is open and the action only opens it.
        const mine = pending.filter((d) => canAnswer(d.gate));
        const shown = mine.length > 0 ? mine : pending;
        const nouns = new Set(shown.map((d) => GATE_NOUN[d.gate.kind]));
        const noun = nouns.size === 1 ? [...nouns][0] : 'decision';
        const count = shown.length;
        const asked =
          mine.length === 0
            ? `${plural(count, noun)} waiting for an answer`
            : count === 1
              ? `1 ${noun} needs your answer`
              : `${count} ${noun}s need your answer`;
        // The pill in the header carries the age; here only what is open.
        title = resumeRequired ? `${asked} · a saved answer did not continue` : asked;
        action = resumeRequired
          ? resumeAction
          : gateAction(shown[0], stageName, onAnswer, links, mine.length > 0);
      } else if (resumeRequired) {
        kind = 'resume_required';
        title = 'Your answer was saved but the run did not continue';
        action = resumeAction;
      } else if (open[0]?.kind === 'stage') {
        kind = 'waiting';
        const parked = open[0].stage;
        title = `Parked at ${parked.stageId ? stageName(parked.stageId) : 'a stage'} — nothing to answer`;
        action = links.details ? <LinkButton to={links.details}>View activity</LinkButton> : null;
      } else {
        kind = 'waiting_engine';
        title = 'Waiting on the engine — no action needed from you';
      }
      break;
    }

    case 'FAILED': {
      kind = 'failed';
      const failure = describeFailure(
        intent.failure?.code,
        intent.failure?.message ?? intent.failureReason,
      );
      const failedStageId =
        restartStage?.stageId ??
        stages.find((s) => s.state === 'FAILED')?.stageId ??
        failure.stageId ??
        intent.currentStage ??
        null;
      title = failedStageId
        ? `Failed at ${stageName(failedStageId)} — ${failure.sentence}`
        : `Failed before the first stage — ${failure.sentence}`;
      action =
        restartAction() ?? (links.logs ? <LinkButton to={links.logs}>Open logs</LinkButton> : null);
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
      const completion = detail.unitCompletion;
      if (completion && completion.state !== 'complete' && completion.total > 0) {
        title += ` · ${completion.integrated} of ${completion.total} units integrated`;
      }
      action =
        pullRequestAction ??
        (actions.checkDelivery ? (
          <ActionButton action={actions.checkDelivery} variant="ghost">
            Check delivery
          </ActionButton>
        ) : null);
      break;
    }

    case 'CANCELLED': {
      kind = 'cancelled';
      const when = ageLabel(intent.completedAt ?? intent.updatedAt, now);
      title = when ? `Cancelled ${when} ago` : 'Cancelled';
      const units = detail.units ?? [];
      const integrated =
        detail.unitCompletion?.integrated ?? units.filter((u) => u.state === 'MERGED').length;
      const total = detail.unitCompletion?.total ?? units.length;
      title +=
        integrated > 0
          ? ` · ${integrated} of ${total} units integrated before the run stopped`
          : pullRequest
            ? ' · a pull request was opened before the run stopped'
            : ' · nothing was delivered';
      action = pullRequestAction;
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
      action={action}
      data-slot="intent-outcome"
      data-outcome={kind}
      className={cn(surface.className, className)}
      icon={
        <Icon
          data-pulse={pulse || undefined}
          className={cn(surface.iconClassName, pulse && 'motion-safe:animate-pulse')}
        />
      }
    />
  );
}

// The one action of a waiting run: the oldest open gate, opened in place
// (Work) or through its link (Overview); "View" when the reader cannot answer.
function gateAction(
  decision: Extract<OpenDecision, { kind: 'gate' }>,
  stageName: (stageId: string) => string,
  onAnswer: ((gateId: string) => void) | undefined,
  links: IntentOutcomeLinks,
  answerable: boolean,
): React.ReactNode {
  const { gate, stage } = decision;
  const stageLabel = stage?.stageId ? stageName(stage.stageId) : null;
  const question = gate.kind === 'question' ? gateTabLabel(gate) : gate.prompt;
  const label = question ?? (stageLabel ? `Review of ${stageLabel}` : gateTabLabel(gate));
  const subject = gate.kind === 'question' ? label : (stageLabel ?? label);
  const verb = answerable ? GATE_VERB[gate.kind] : 'View';
  const variant = answerable ? 'default' : 'outline';
  const name = `${verb}: ${subject}`;
  if (onAnswer) {
    return (
      <Button
        type="button"
        size="sm"
        variant={variant}
        aria-label={name}
        onClick={() => onAnswer(gate.humanTaskId)}
      >
        {verb}
      </Button>
    );
  }
  const href = links.gate?.(gate);
  if (!href) return null;
  return (
    <Button asChild size="sm" variant={variant}>
      <Link to={href} aria-label={name}>
        {verb}
      </Link>
    </Button>
  );
}
