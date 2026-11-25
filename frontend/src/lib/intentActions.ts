import type { Intent } from '@/services/intents';

const RESHAPE_STATUSES: ReadonlySet<Intent['status']> = new Set(['WAITING', 'FAILED']);

/**
 * Why "Reshape remaining stages" is unavailable, undefined when it is offered.
 * One rule for Overview, Work and Audit: reshaping is a decision on a parked or
 * failed run, and an autonomous construction has no stages left to pick.
 */
export function reshapeDisabledReason(
  intent: Pick<Intent, 'status' | 'constructionAutonomyMode'>,
): string | undefined {
  if (intent.constructionAutonomyMode === 'autonomous') {
    return 'Not available for autonomous construction';
  }
  if (!RESHAPE_STATUSES.has(intent.status)) return 'Only while the run is waiting or has failed';
  return undefined;
}
