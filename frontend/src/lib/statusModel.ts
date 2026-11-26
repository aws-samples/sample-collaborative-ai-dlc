// The single status registry: every status word, tone, icon and help sentence
// the UI shows comes from here, so one backend value reads the same on every
// surface (sidebar, Spaces, Space, Overview, Work, Observability, settings).
//
// Pure functions; clocks are injected (`now`) and `Date.now()` only appears
// as a default parameter. The hooks (`useIntentStatus`, `useIntentStatusReader`)
// only read the shared query cache so list surfaces derive exactly what the
// intent page does.

import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  GitMerge,
  GitPullRequestDraft,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
  PencilLine,
  RefreshCw,
  Settings,
  TriangleAlert,
  Undo2,
  Wifi,
  WifiOff,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useQueryData } from '@/hooks/useQueryData';
import { qk } from '@/lib/queryKeys';
import type { ConnectionStatus } from '@/services/realtime';
import type {
  Intent,
  IntentGate,
  IntentStage,
  IntentStatus,
  StageState,
  UnitState,
} from '@/services/intents';

export type StatusKind = 'intent' | 'stage' | 'gate' | 'unit' | 'connection' | 'config' | 'sensor';

export type StatusTone =
  | 'neutral'
  | 'running'
  | 'waiting'
  | 'success'
  | 'danger'
  | 'warning'
  | 'info';

export interface StatusEntry {
  /** Title-case human label. Never a raw backend value. */
  label: string;
  tone: StatusTone;
  icon: LucideIcon;
  /** One plain sentence explaining the state. */
  help: string;
  /** Work is actively progressing: the only states allowed to animate. */
  live?: boolean;
}

/** `resume_required`: answered, but the run was not woken up (resumeAvailable). */
export type GateStatusKey = IntentGate['status'] | 'resume_required';
/** `TIMED_OUT`: display-only, an agent run that stopped at its time limit. */
export type StageStatusKey = StageState | 'TIMED_OUT';
/** Unit lanes add two display-only states on top of the backend UnitState. */
export type UnitStatusKey = UnitState | 'WAITING_INPUT' | 'NEEDS_RECOVERY';
export type ConfigStatusKey = 'configured' | 'incomplete' | 'error' | 'none' | 'unknown';
export type SensorStatusKey = 'passed' | 'advisory' | 'inconclusive' | 'not_run' | 'blocking';

export interface StatusKeyMap {
  intent: IntentStatus;
  stage: StageStatusKey;
  gate: GateStatusKey;
  unit: UnitStatusKey;
  connection: ConnectionStatus;
  config: ConfigStatusKey;
  sensor: SensorStatusKey;
}

type Registry = { [K in StatusKind]: Record<StatusKeyMap[K], StatusEntry> };

export const STATUS_REGISTRY: Registry = {
  intent: {
    DRAFT: {
      label: 'Draft',
      tone: 'neutral',
      icon: PencilLine,
      help: 'The intent is being prepared and has not started.',
    },
    CREATED: {
      label: 'Starting',
      tone: 'info',
      icon: Hourglass,
      help: 'The run was requested and is waiting to be picked up.',
    },
    RUNNING: {
      label: 'Running',
      tone: 'running',
      icon: LoaderCircle,
      help: 'An agent is working on the current stage.',
      live: true,
    },
    WAITING: {
      label: 'Waiting for input',
      tone: 'waiting',
      icon: MessageCircleQuestion,
      help: 'The run is paused until someone answers a question or approves a stage.',
    },
    SUCCEEDED: {
      label: 'Completed',
      tone: 'success',
      icon: CircleCheck,
      help: 'Every stage in this run finished.',
    },
    FAILED: {
      label: 'Failed',
      tone: 'danger',
      icon: CircleX,
      help: 'The run stopped because a stage or the platform reported an error.',
    },
    CANCELLED: {
      label: 'Cancelled',
      tone: 'neutral',
      icon: Ban,
      help: 'Someone stopped this run before it finished.',
    },
  },
  stage: {
    PENDING: {
      label: 'Not started',
      tone: 'neutral',
      icon: CircleDashed,
      help: 'This stage runs after the stages before it finish.',
    },
    RUNNING: {
      label: 'Running',
      tone: 'running',
      icon: LoaderCircle,
      help: 'An agent is working on this stage.',
      live: true,
    },
    WAITING_FOR_HUMAN: {
      label: 'Waiting for input',
      tone: 'waiting',
      icon: MessageCircleQuestion,
      help: 'This stage is paused until someone answers or approves.',
    },
    SUCCEEDED: {
      label: 'Completed',
      tone: 'success',
      icon: CircleCheck,
      help: 'This stage finished.',
    },
    FAILED: {
      label: 'Failed',
      tone: 'danger',
      icon: CircleX,
      help: 'This stage reported an error and the run stopped here.',
    },
    SKIPPED: {
      label: 'Skipped',
      tone: 'neutral',
      icon: CircleSlash,
      help: 'This stage was not needed for this run.',
    },
    TIMED_OUT: {
      label: 'Timed out',
      tone: 'warning',
      icon: Clock,
      help: 'The agent stopped because it ran past its time limit.',
    },
  },
  gate: {
    pending: {
      label: 'Waiting for answer',
      tone: 'waiting',
      icon: MessageCircleQuestion,
      help: 'Someone needs to answer before the run continues.',
    },
    answered: {
      label: 'Answered',
      tone: 'success',
      icon: CircleCheck,
      help: 'The answer was recorded and handed back to the run.',
    },
    approved: {
      label: 'Approved',
      tone: 'success',
      icon: CircleCheck,
      help: 'The stage output was approved.',
    },
    rejected: {
      label: 'Changes requested',
      tone: 'warning',
      icon: Undo2,
      help: 'A reviewer asked for changes to the stage output.',
    },
    superseded: {
      label: 'Withdrawn',
      tone: 'neutral',
      icon: CircleMinus,
      help: 'The question was closed unanswered because the run was cancelled or rewound.',
    },
    resume_required: {
      label: 'Needs resume',
      tone: 'warning',
      icon: CirclePause,
      help: 'The answer was saved, but the run did not pick it up and must be resumed.',
    },
  },
  unit: {
    PENDING: {
      label: 'Pending',
      tone: 'neutral',
      icon: CircleDashed,
      help: 'This unit waits for the units it depends on.',
    },
    READY: {
      label: 'Ready',
      tone: 'info',
      icon: Clock,
      help: 'Dependencies are done; this unit starts when a slot is free.',
    },
    RUNNING: {
      label: 'Building',
      tone: 'running',
      icon: LoaderCircle,
      help: 'An agent is building this unit.',
      live: true,
    },
    PR_DRAFT: {
      label: 'Draft review',
      tone: 'info',
      icon: GitPullRequestDraft,
      help: 'A draft pull request is open for this unit.',
    },
    RECONCILING: {
      label: 'Reconciling',
      tone: 'running',
      icon: RefreshCw,
      help: 'The unit branch is being brought up to date with the intent branch.',
      live: true,
    },
    PR_READY: {
      label: 'Ready to merge',
      tone: 'info',
      icon: GitMerge,
      help: 'The pull request is ready to be integrated.',
    },
    ADDRESSING_FEEDBACK: {
      label: 'Fixing feedback',
      tone: 'running',
      icon: Wrench,
      help: 'An agent is addressing review comments on this unit.',
      live: true,
    },
    MERGING: {
      label: 'Merging',
      tone: 'running',
      icon: GitMerge,
      help: 'The unit is being merged into the intent branch.',
      live: true,
    },
    MERGED: {
      label: 'Integrated',
      tone: 'success',
      icon: CircleCheck,
      help: 'The unit is merged into the intent branch.',
    },
    FAILED: {
      label: 'Failed',
      tone: 'danger',
      icon: CircleX,
      help: 'The unit could not be built or merged.',
    },
    BLOCKED: {
      label: 'Blocked',
      tone: 'warning',
      icon: CircleMinus,
      help: 'A unit this one depends on did not finish.',
    },
    WAITING_INPUT: {
      label: 'Waiting for input',
      tone: 'waiting',
      icon: MessageCircleQuestion,
      help: 'This unit is paused until someone answers or approves.',
    },
    NEEDS_RECOVERY: {
      label: 'Needs recovery',
      tone: 'warning',
      icon: TriangleAlert,
      help: 'This unit stopped and needs someone to decide how to continue.',
    },
  },
  connection: {
    idle: {
      label: 'Live updates off',
      tone: 'neutral',
      icon: WifiOff,
      help: 'This page is not subscribed to live updates.',
    },
    connecting: {
      label: 'Connecting',
      tone: 'info',
      icon: LoaderCircle,
      help: 'Connecting to live updates.',
    },
    connected: {
      label: 'Live updates',
      tone: 'success',
      icon: Wifi,
      help: 'Changes from agents and teammates appear as they happen.',
    },
    disconnected: {
      label: 'Live updates paused',
      tone: 'warning',
      icon: WifiOff,
      help: 'The live connection dropped; reconnecting automatically.',
    },
    error: {
      label: 'Live updates unavailable',
      tone: 'danger',
      icon: WifiOff,
      help: 'The live connection failed; reload the page if this persists.',
    },
  },
  config: {
    configured: {
      label: 'Configured',
      tone: 'success',
      icon: CircleCheck,
      help: 'This setting is in place and ready to use.',
    },
    incomplete: {
      label: 'Setup incomplete',
      tone: 'warning',
      icon: Settings,
      help: 'Some required values are still missing.',
    },
    error: {
      label: 'Needs attention',
      tone: 'danger',
      icon: CircleAlert,
      help: 'The saved configuration does not work and needs to be fixed.',
    },
    none: {
      label: 'Not configured',
      tone: 'neutral',
      icon: CircleDashed,
      help: 'Nothing is set up here yet.',
    },
    unknown: {
      label: 'Status unavailable',
      tone: 'warning',
      icon: CircleHelp,
      help: 'The current status could not be loaded; try again.',
    },
  },
  sensor: {
    passed: {
      label: 'Passed',
      tone: 'success',
      icon: CircleCheck,
      help: 'The automated check ran and found no problem.',
    },
    advisory: {
      label: 'Advisory finding',
      tone: 'neutral',
      icon: CircleAlert,
      help: 'The check found something worth reviewing, but it does not block the run.',
    },
    inconclusive: {
      label: 'Inconclusive',
      tone: 'neutral',
      icon: CircleHelp,
      help: 'The check ran but could not reach a verdict; it does not block the run.',
    },
    not_run: {
      label: 'Not run',
      tone: 'neutral',
      icon: CircleMinus,
      help: 'The check could not run; it does not block the run.',
    },
    blocking: {
      label: 'Blocking',
      tone: 'danger',
      icon: CircleX,
      help: 'A required check failed and the run is held until it is resolved.',
    },
  },
};

/** Tone → class names. Token utilities are defined in index.css. */
export const TONE_CLASSES: Record<StatusTone, { pill: string; text: string }> = {
  neutral: { pill: 'bg-muted text-muted-foreground', text: 'text-muted-foreground' },
  running: { pill: 'bg-agent-running/15 text-agent-running-fg', text: 'text-agent-running-fg' },
  waiting: { pill: 'bg-agent-waiting/15 text-agent-waiting-fg', text: 'text-agent-waiting-fg' },
  success: { pill: 'bg-agent-success/15 text-agent-success-fg', text: 'text-agent-success-fg' },
  danger: { pill: 'bg-agent-error/15 text-agent-error-fg', text: 'text-agent-error-fg' },
  warning: { pill: 'bg-warning/15 text-warning-fg', text: 'text-warning-fg' },
  info: { pill: 'bg-agent-idle/15 text-agent-idle-fg', text: 'text-agent-idle-fg' },
};

function humanize(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

/** Registry lookup; an unknown value degrades to a neutral, humanized entry. */
export function getStatus<K extends StatusKind>(kind: K, key: string): StatusEntry {
  const entry = (STATUS_REGISTRY[kind] as Record<string, StatusEntry>)[key];
  if (entry) return entry;
  return {
    label: humanize(key),
    tone: 'neutral',
    icon: CircleHelp,
    help: 'This status is not recognised by this version of the app.',
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** A RUNNING/CREATED run with no recorded activity for this long is stalled. */
const STALL_AFTER_MS = 30 * 60 * 1000;

type Clock = number | Date;

const toMs = (clock: Clock) => (typeof clock === 'number' ? clock : clock.getTime());

function parseMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The newest (or oldest) parseable timestamp, as given. */
function pickTimestamp(
  timestamps: readonly (string | null | undefined)[],
  oldest = false,
): string | undefined {
  let best: { ms: number; value: string } | undefined;
  for (const value of timestamps) {
    const ms = parseMs(value);
    if (ms === null || !value) continue;
    if (!best || (oldest ? ms < best.ms : ms > best.ms)) best = { ms, value };
  }
  return best?.value;
}

export const latestActivityAt = (timestamps: readonly (string | null | undefined)[]) =>
  pickTimestamp(timestamps);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Elapsed time as a short phrase: "2 min", "3 h", "108 days". `coarse` rolls
 * 60+ days into months and 365+ days into years ("4 months"). `compact` uses
 * unit abbreviations for dense lists ("108 d", "4 mo", "1 y"). Empty string
 * for a missing or unparseable timestamp.
 */
export function ageLabel(
  since: string | number | null | undefined,
  now: Clock = Date.now(),
  { coarse = false, compact = false }: { coarse?: boolean; compact?: boolean } = {},
): string {
  const start = parseMs(since);
  if (start === null) return '';
  const diff = toMs(now) - start;
  if (diff < MINUTE) return compact ? '<1 min' : 'under 1 min';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
  const days = Math.floor(diff / DAY);
  if (coarse && days >= 365) {
    const years = Math.floor(days / 365);
    return compact ? `${years} y` : plural(years, 'year');
  }
  if (coarse && days >= 60) {
    const months = Math.floor(days / 30);
    return compact ? `${months} mo` : plural(months, 'month');
  }
  return compact ? `${days} d` : plural(days, 'day');
}

// ── Derivations ──────────────────────────────────────────────────────────────

export interface DerivedIntentStatus {
  key: IntentStatus;
  /** RUNNING/CREATED with no activity for STALL_AFTER_MS. Never animate. */
  stalled: boolean;
  /** Stalled: last activity. WAITING: when the oldest open gate opened. */
  since?: string;
}

type GateLike = Pick<IntentGate, 'humanTaskId' | 'status' | 'createdAt'> & {
  updatedAt?: string | null;
};

type StageLike = Pick<IntentStage, 'state'> &
  Partial<Pick<IntentStage, 'parkedAt' | 'startedAt' | 'completedAt' | 'updatedAt'>>;

type IntentLike = Pick<Intent, 'status' | 'updatedAt' | 'createdAt'> & {
  pendingHumanTaskId?: string | null;
};

/**
 * When the wait began: the OLDEST open decision (pending gate or stage parked
 * for a human), whichever one is "current". Every surface that knows the
 * gates shows the same age. Without them the age is unknown — the intent's
 * updatedAt is the newest gate, not the oldest, so a list row would read a
 * different number from the header until the detail arrives (review R3-5).
 * Known-but-empty gates fall back to updatedAt.
 */
function waitingSince(
  intent: IntentLike,
  gates: readonly GateLike[] | undefined,
  stages: readonly StageLike[] | undefined,
): string | undefined {
  if (!gates && !stages) return undefined;
  const starts = [
    ...(gates ?? []).filter((g) => g.status === 'pending').map((g) => g.createdAt ?? g.updatedAt),
    ...(stages ?? [])
      .filter((s) => s.state === 'WAITING_FOR_HUMAN')
      .map((s) => s.parkedAt ?? s.updatedAt),
  ];
  return pickTimestamp(starts, true) ?? intent.updatedAt ?? undefined;
}

/**
 * The status to display for an intent. `lastActivityAt` is the newest event,
 * stage or output timestamp the caller knows (see `latestActivityAt`); without
 * it the intent's own updatedAt/createdAt is used. Pass `gates`/`stages` when
 * known so a WAITING intent reports its oldest open decision.
 */
export function deriveIntentStatus(
  intent: IntentLike,
  {
    now = Date.now(),
    lastActivityAt,
    gates,
    stages,
  }: {
    now?: Clock;
    lastActivityAt?: string | null;
    gates?: readonly GateLike[];
    stages?: readonly StageLike[];
  } = {},
): DerivedIntentStatus {
  const key = intent.status;
  if (key === 'RUNNING' || key === 'CREATED') {
    const last = latestActivityAt([lastActivityAt, intent.updatedAt, intent.createdAt]);
    if (last && toMs(now) - Date.parse(last) > STALL_AFTER_MS) {
      return { key, stalled: true, since: last };
    }
    return { key, stalled: false };
  }
  if (key === 'WAITING') {
    const since = waitingSince(intent, gates, stages);
    return since ? { key, stalled: false, since } : { key, stalled: false };
  }
  return { key, stalled: false };
}

export interface DetailLike {
  intent: IntentLike;
  gates?: readonly GateLike[] | null;
  stages?: readonly StageLike[] | null;
  events?: readonly { timestamp?: string | null }[] | null;
}

/**
 * The status derived from a full intent detail — what the intent page header
 * shows. Activity is the newest of the intent, its events and its stages.
 */
export function statusFromDetail(
  detail: DetailLike,
  { now = Date.now(), lastActivityAt }: { now?: Clock; lastActivityAt?: string | null } = {},
): DerivedIntentStatus {
  const stamps = [lastActivityAt, detail.intent.updatedAt];
  for (const event of detail.events ?? []) stamps.push(event.timestamp);
  for (const stage of detail.stages ?? []) {
    stamps.push(stage.startedAt, stage.completedAt, stage.updatedAt);
  }
  return deriveIntentStatus(detail.intent, {
    now,
    lastActivityAt: latestActivityAt(stamps),
    gates: detail.gates ?? undefined,
    stages: detail.stages ?? undefined,
  });
}

const STALLED_LABEL = 'Stalled';

const TERMINAL_INTENT_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** Statuses that ended: their age is a point in time ("ago"), never a duration. */
const TERMINAL_STATUSES: Partial<Record<StatusKind, ReadonlySet<string>>> = {
  intent: TERMINAL_INTENT_STATUSES,
  stage: new Set<StageState>(['SUCCEEDED', 'FAILED', 'SKIPPED']),
  gate: new Set<GateStatusKey>(['answered', 'approved', 'rejected', 'superseded']),
  unit: new Set<UnitStatusKey>(['MERGED', 'FAILED']),
};

const COMPACT_LABELS: Partial<Record<string, string>> = {
  'intent:WAITING': 'Waiting',
  'stage:WAITING_FOR_HUMAN': 'Waiting',
  'unit:WAITING_INPUT': 'Waiting',
};

/**
 * The pill text for a status. Open states carry a duration:
 * "Waiting for input · 108 days", "Stalled · no activity for 4 months";
 * compact (dense lists) "Waiting · 108 d", "Stalled · 4 mo". Ended states
 * carry a point in time: "Failed 59 days ago", compact "Failed 59 d ago".
 */
export function statusLabel<K extends StatusKind>(
  kind: K,
  status: string,
  {
    since,
    stalled = false,
    now = Date.now(),
    compact = false,
  }: { since?: string | null; stalled?: boolean; now?: Clock; compact?: boolean } = {},
): string {
  const age = since ? ageLabel(since, now, { coarse: stalled, compact }) : '';
  if (stalled) {
    if (!age) return STALLED_LABEL;
    return compact ? `${STALLED_LABEL} · ${age}` : `${STALLED_LABEL} · no activity for ${age}`;
  }
  const label = (compact && COMPACT_LABELS[`${kind}:${status}`]) || getStatus(kind, status).label;
  if (!age) return label;
  return TERMINAL_STATUSES[kind]?.has(status) ? `${label} ${age} ago` : `${label} · ${age}`;
}

// ── One status per intent, on every surface ──────────────────────────────────

type IntentSummaryLike = IntentLike & {
  id?: string;
  resumeRequired?: Intent['resumeRequired'] | boolean;
};

/** A detail older than the summary is ignored: the summary is the newer truth. */
function isCurrentDetail(
  intent: IntentSummaryLike,
  detail: DetailLike | null | undefined,
): detail is DetailLike {
  return (
    Boolean(detail?.intent) &&
    (parseMs(detail!.intent.updatedAt) ?? 0) >= (parseMs(intent.updatedAt) ?? 0)
  );
}

const WATCHED: ReadonlySet<IntentStatus> = new Set(['WAITING', 'RUNNING', 'CREATED']);

/**
 * The status every surface shows for an intent: exactly what the intent header
 * shows when the shared `qk.intentDetail` entry is cached (peeked: this never
 * fetches and never keeps the entry from being evicted), else the summary.
 * Only active intents are watched: a terminal status reads the same from the
 * summary.
 */
export function useIntentStatus(
  projectId: string | null | undefined,
  intent: IntentSummaryLike | null | undefined,
  {
    now,
    fallback,
  }: {
    now?: Clock;
    /** What the caller derived without the detail (e.g. with extra activity evidence). */
    fallback?: DerivedIntentStatus;
  } = {},
): DerivedIntentStatus {
  const detailKey =
    projectId && intent?.id && WATCHED.has(intent.status)
      ? qk.intentDetail(projectId, intent.id)
      : null;
  const detail = useQueryData<DetailLike>(detailKey);
  if (!intent) return fallback ?? { key: 'DRAFT', stalled: false };
  return resolveIntentStatus(intent, detail, { now, fallback }).status;
}

export interface ResolvedIntentStatus<T extends IntentSummaryLike = IntentSummaryLike> {
  status: DerivedIntentStatus;
  /** The intent the status was read from: the current cached detail's, else the summary. */
  intent: T | (IntentSummaryLike & DetailLike['intent']);
}

function resolveIntentStatus<T extends IntentSummaryLike>(
  intent: T,
  detail: DetailLike | null | undefined,
  { now, fallback }: { now?: Clock; fallback?: DerivedIntentStatus },
): ResolvedIntentStatus<T> {
  if (isCurrentDetail(intent, detail)) {
    return { status: statusFromDetail(detail, { now }), intent: { ...intent, ...detail.intent } };
  }
  return { status: fallback ?? deriveIntentStatus(intent, { now }), intent };
}

const isIntentDetailKey = (key: readonly unknown[]) => key[0] === 'intent' && key[3] === 'detail';

/**
 * `useIntentStatus` for a whole list: a reader returning what each intent's
 * pill shows (and the intent it was read from), re-rendering the caller when
 * any cached intent detail changes. For filters and counts that must agree
 * with the pills.
 */
export function useIntentStatusReader(): <T extends IntentSummaryLike>(
  projectId: string,
  intent: T,
  options?: { now?: Clock },
) => ResolvedIntentStatus<T> {
  const client = useQueryClient();
  const version = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe(({ query }) => {
        if (!isIntentDetailKey(query.queryKey)) return;
        version.current += 1;
        notify();
      }),
    [client],
  );
  const current = useSyncExternalStore(subscribe, () => version.current);
  return useCallback(
    <T extends IntentSummaryLike>(projectId: string, intent: T, { now }: { now?: Clock } = {}) => {
      void current;
      const detail =
        intent.id && WATCHED.has(intent.status)
          ? client.getQueryData<DetailLike>(qk.intentDetail(projectId, intent.id))
          : undefined;
      return resolveIntentStatus(intent, detail, { now });
    },
    [client, current],
  );
}
