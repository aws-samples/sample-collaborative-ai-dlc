import type { Sprint } from '@/services/sprints';

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

export function isAttentionStatus(status: EffectiveSprintStatus): boolean {
  return status === 'waiting' || status === 'failed';
}

export function isActiveStatus(status: EffectiveSprintStatus): boolean {
  return status === 'running' || status === 'waiting';
}
