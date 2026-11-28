import type { Intent, IntentGate } from '@/services/intents';
import { ageLabel, deriveIntentStatus, type DerivedIntentStatus } from '@/lib/statusModel';
import { describeFailure } from '@/lib/failureReasons';
import { displayStageName } from '@/lib/displayNames';
import { intentAttention } from '@/lib/sprintStatus';

export type RowMetaIntent = Pick<
  Intent,
  'status' | 'createdAt' | 'updatedAt' | 'completedAt' | 'currentStage' | 'failureReason'
> &
  Partial<Pick<Intent, 'failure' | 'pendingHumanTaskId'>> & {
    resumeRequired?: Intent['resumeRequired'] | boolean;
  };

/**
 * The line under an intent title; one builder for the Space rows and the Spaces
 * inbox. The pill beside it says the status only: the age always lives here
 * (R5-8), as a duration while the run is open and as a moment once it ended.
 */
export interface IntentRowMeta {
  /** "2 questions · Feasibility · waiting 138 days", "Failed at Deployment Pipeline". */
  parts: string[];
  /** Timestamp rendered after `parts` ("Failed 56 days ago"). */
  time: { value: string; prefix: string } | null;
}

type GateLike = Pick<IntentGate, 'status' | 'kind'>;

const GATE_NOUN: Record<IntentGate['kind'], string> = {
  question: 'question',
  approval: 'approval',
  validation: 'approval',
  'review-verdict': 'review',
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * "2 questions · 1 approval" from the known gates; null while the gates are
 * unknown (the list has no count to show — a guessed "1 decision" contradicted
 * the detail, review R3-5); "1 decision" when the gates are known but the
 * pending task is not among them yet.
 */
export function describePendingGates(gates: readonly GateLike[] | undefined | null): string | null {
  if (!gates) return null;
  const counts = new Map<string, number>();
  for (const gate of gates) {
    if (gate.status !== 'pending') continue;
    const noun = GATE_NOUN[gate.kind] ?? 'decision';
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  if (counts.size === 0) return '1 decision';
  return [...counts.entries()].map(([noun, count]) => plural(count, noun)).join(' · ');
}

function failedStageId(intent: RowMetaIntent): string | null {
  const described = describeFailure(intent.failure?.code, intent.failureReason);
  return described.stageId ?? intent.currentStage ?? null;
}

export interface IntentRowMetaOptions {
  now?: number;
  gates?: readonly GateLike[] | null;
  /** The wait's start when the caller knows it better (oldest open gate). */
  since?: string | null;
  /** The status the row's pill shows, when the caller read it from the cache. */
  derived?: DerivedIntentStatus;
}

const compact = (parts: (string | null)[]) => parts.filter(Boolean) as string[];

export function intentRowMeta(
  intent: RowMetaIntent,
  {
    now = Date.now(),
    gates,
    since,
    derived = deriveIntentStatus(intent, { now }),
  }: IntentRowMetaOptions = {},
): IntentRowMeta {
  const attention = intentAttention(intent);
  const stage = intent.currentStage ? displayStageName(intent.currentStage) : null;
  const updated = intent.updatedAt ?? intent.createdAt ?? null;
  const waiting = ageLabel(since ?? derived.since, now);
  const waitingFor = waiting ? `waiting ${waiting}` : null;

  switch (intent.status) {
    case 'FAILED': {
      const stageId = failedStageId(intent);
      return {
        parts: compact([stageId ? `Failed at ${displayStageName(stageId)}` : null]),
        time: updated ? { value: updated, prefix: stageId ? '' : 'Failed' } : null,
      };
    }
    case 'SUCCEEDED': {
      const at = intent.completedAt ?? updated;
      return { parts: [], time: at ? { value: at, prefix: 'Completed' } : null };
    }
    case 'CANCELLED': {
      const at = intent.completedAt ?? updated;
      return { parts: [], time: at ? { value: at, prefix: 'Cancelled' } : null };
    }
    case 'WAITING': {
      if (attention === 'resume') {
        // The answer was recorded at the last update; that is how long it has waited.
        const resumeWait = ageLabel(since ?? updated, now);
        return {
          parts: compact(['Resume needed', stage, resumeWait ? `waiting ${resumeWait}` : null]),
          time: null,
        };
      }
      if (attention === 'input') {
        return { parts: compact([describePendingGates(gates), stage, waitingFor]), time: null };
      }
      return {
        parts: compact([stage, waitingFor]),
        time: waitingFor || !updated ? null : { value: updated, prefix: 'Updated' },
      };
    }
    case 'RUNNING':
    case 'CREATED': {
      if (derived.stalled) {
        return {
          parts: [stage ? `Stalled at ${stage}` : 'Stalled'],
          time: derived.since ? { value: derived.since, prefix: 'Last activity' } : null,
        };
      }
      return {
        parts: compact([stage]),
        time: updated ? { value: updated, prefix: 'Updated' } : null,
      };
    }
    default:
      return { parts: [], time: updated ? { value: updated, prefix: 'Updated' } : null };
  }
}

/** The same meta as plain text, the time rendered as an age ("Failed 56 days ago"). */
export function intentRowMetaText(
  intent: RowMetaIntent,
  options: IntentRowMetaOptions = {},
): string[] {
  const meta = intentRowMeta(intent, options);
  const age = meta.time ? ageLabel(meta.time.value, options.now) : null;
  if (!age) return meta.parts;
  return [...meta.parts, compact([meta.time?.prefix ?? null, `${age} ago`]).join(' ')];
}
