import { ApiError } from '@/services/api';
import type { Intent } from '@/services/intents';

const RESHAPE_STATUSES: ReadonlySet<Intent['status']> = new Set(['WAITING', 'FAILED']);

/** Why a Viewer's intent action is disabled: they read the run but change nothing (#777). */
export const VIEW_ONLY_REASON = 'You have view-only access to this space.';

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

export interface ResumeNotice {
  kind: 'expired' | 'retryable';
  title: string;
  message: string;
}

/**
 * "Resume run" for every page that offers it. The resume endpoint has three
 * outcomes, and collapsing them into one error toast offered the human a button
 * that could never work. 409 `durable_execution_expired` is TERMINAL: the
 * durable execution is gone and the API already failed the run and cleared the
 * marker, so the intent is re-read (which drops the affordance) and the human is
 * told to rewind. 503 is retryable and the button must stay. Any other error is
 * rethrown as an ordinary failure.
 */
export async function resumeOrExplain(
  resume: () => Promise<void>,
  reload: () => Promise<void>,
): Promise<ResumeNotice | null> {
  try {
    await resume();
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await reload();
      return {
        kind: 'expired',
        title: 'This run can no longer be resumed',
        message:
          'The durable execution expired before your answer could resume the run. The run is now failed — rewind to the stage you want to re-run; your answer is still on the record.',
      };
    }
    if (err instanceof ApiError && err.status === 503) {
      return {
        kind: 'retryable',
        title: 'Resume did not go through',
        message:
          'The durable callback could not be reached just now. Nothing was lost — try Resume again in a moment.',
      };
    }
    throw err;
  }
}
