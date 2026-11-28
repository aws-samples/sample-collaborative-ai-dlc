import { intentAttention } from '@/lib/sprintStatus';
import { deriveIntentStatus, type ResolvedIntentStatus } from '@/lib/statusModel';
import type { ProjectIntentSummary } from '@/hooks/useProjectsCache';

/** The status a row's pill shows for an intent (useIntentStatusReader). */
export type IntentStatusOf = (intent: ProjectIntentSummary) => ResolvedIntentStatus;

// One count per thing a space row can say about its work. The Spaces table
// renders the counts as pills, the sidebar as a tooltip line; the stall rule
// is the one the pills use (`statusOf`, by default the summary's own
// `deriveIntentStatus`), so a run with no progress is never "running".
export interface SpaceSignals {
  questions: number;
  failed: number;
  running: number;
  stalled: number;
}

export function deriveSpaceSignals(
  intents: readonly ProjectIntentSummary[],
  now: number,
  statusOf: IntentStatusOf = (intent) => ({
    status: deriveIntentStatus(intent, { now }),
    intent,
  }),
): SpaceSignals {
  const signals: SpaceSignals = { questions: 0, failed: 0, running: 0, stalled: 0 };
  for (const summary of intents) {
    const { status, intent } = statusOf(summary);
    const attention = intentAttention(intent);
    if (attention === 'failed') signals.failed++;
    else if (attention) signals.questions++;
    else if (status.key === 'RUNNING' || status.key === 'CREATED') {
      if (status.stalled) signals.stalled++;
      else signals.running++;
    }
  }
  return signals;
}

export function hasOpenWork(signals: SpaceSignals): boolean {
  return signals.questions + signals.failed + signals.running + signals.stalled > 0;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 questions", "1 failed", "1 stalled", "3 running" — in that order, zeros omitted. */
export function spaceSignalParts(signals: SpaceSignals): string[] {
  const parts: string[] = [];
  if (signals.questions) parts.push(plural(signals.questions, 'question'));
  if (signals.failed) parts.push(plural(signals.failed, 'failed', 'failed'));
  if (signals.stalled) parts.push(plural(signals.stalled, 'stalled', 'stalled'));
  if (signals.running) parts.push(plural(signals.running, 'running', 'running'));
  return parts;
}
