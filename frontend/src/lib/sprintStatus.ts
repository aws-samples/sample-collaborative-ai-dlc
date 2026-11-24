import type { Sprint } from '@/services/sprints';
import type { Intent } from '@/services/intents';
import { deriveIntentStatus } from '@/lib/statusModel';

export type EffectiveSprintStatus =
  | 'passed'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'idle';

// A sprint whose phase reached COMPLETED is "passed" regardless of
// currentAgentStatus: that field keeps the LAST agent run's outcome forever
// (e.g. a failed review retry), which must not be shown as a red failure on
// an iteration that ultimately shipped.
export function effectiveSprintStatus(sprint: Sprint | null | undefined): EffectiveSprintStatus {
  if (!sprint) return 'idle';
  if (sprint.phase === 'COMPLETED') return 'passed';
  const s = sprint.currentAgentStatus;
  if (s === 'running' || s === 'waiting' || s === 'completed' || s === 'failed') return s;
  return 'idle';
}

export function intentAttention(intent: {
  status: Intent['status'];
  pendingHumanTaskId?: string | null;
  resumeRequired?: Intent['resumeRequired'] | boolean;
}): 'resume' | 'input' | 'failed' | null {
  if (intent.status === 'FAILED') return 'failed';
  if (intent.status !== 'WAITING') return null;
  if (intent.resumeRequired) return 'resume';
  return intent.pendingHumanTaskId ? 'input' : null;
}

/**
 * "Needs attention": a human must act — answer, resume, deal with a failure,
 * or unstick a stalled run. The one rule behind the Spaces inbox, the sidebar
 * filter and its count, and the space badges.
 */
export function needsAttention(
  intent: Parameters<typeof intentAttention>[0] & Pick<Intent, 'updatedAt' | 'createdAt'>,
  now: number = Date.now(),
): boolean {
  if (intentAttention(intent) !== null) return true;
  return deriveIntentStatus(intent, { now }).stalled;
}

export function isActiveStatus(status: EffectiveSprintStatus): boolean {
  return status === 'running' || status === 'waiting';
}

export function effectiveIntentStatus(
  intent: Pick<Intent, 'status'> | null,
): EffectiveSprintStatus {
  if (!intent) return 'idle';
  switch (intent.status) {
    case 'RUNNING':
      return 'running';
    case 'WAITING':
      return 'waiting';
    case 'FAILED':
      return 'failed';
    case 'SUCCEEDED':
      return 'passed';
    default:
      return 'idle';
  }
}
