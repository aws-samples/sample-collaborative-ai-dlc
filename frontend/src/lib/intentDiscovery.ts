import { canRecover } from './executionCapabilities';
import type { Intent } from '@/services/intents';
import type { NativeExecution, NativeIntent, NativeIntentSummary } from '@/services/nativeIntents';

// Protected detail reads enrich the in-memory discovery cache, without retaining
// prompts, repository configuration, or reply/recovery authority.
export type NativeDiscoveredIntent = NativeIntentSummary & {
  executionStatusUnavailable?: boolean;
  freshSessionRecovery?: true;
  execution?: Pick<
    NativeExecution,
    'status' | 'revision' | 'updatedAt' | 'responsePending' | 'turnSequence'
  > | null;
};

// Discovery never supplies native records to the platform execution context.
export type DiscoveredIntent =
  | { backend: 'platform'; intent: Intent }
  | { backend: 'native'; intent: NativeDiscoveredIntent };

export const nativePreparationLabels: Record<NativeIntentSummary['status'], string> = {
  DRAFT: 'Draft',
  PREPARING: 'Preparing workspace',
  READY: 'Workspace ready',
  FAILED: 'Preparation failed',
};

export const nativeExecutionLabels: Record<NativeExecution['status'], string> = {
  REQUESTED: 'Start requested',
  UPGRADING: 'Preparing agent execution',
  DISPATCHING: 'Starting agent',
  RUNNING: 'Agent running',
  RECOVERY_REQUIRED: 'Session recovery required',
  RECOVERING: 'Resuming in a fresh session',
  WAITING_FOR_INPUT: 'Waiting for input',
  AWAITING_USER: 'Awaiting member reply',
  STOPPED: 'Agent stopped',
  FAILED: 'Execution failed',
  CANCEL_REQUESTED: 'Cancellation requested',
  CANCELLED: 'Execution cancelled',
};

export function nativeIntentStatusLabel(
  intent: Pick<
    NativeDiscoveredIntent,
    'status' | 'execution' | 'executionStatusUnavailable' | 'freshSessionRecovery'
  >,
): string {
  if (intent.executionStatusUnavailable && !intent.execution) return 'Execution status unavailable';
  let label = intent.execution
    ? nativeExecutionLabels[intent.execution.status]
    : nativePreparationLabels[intent.status];
  if (intent.execution?.status === 'RECOVERY_REQUIRED' && intent.freshSessionRecovery)
    label = 'Awaiting fresh-session recovery';
  if (
    intent.execution?.status === 'DISPATCHING' &&
    (intent.execution.responsePending === true || (intent.execution.turnSequence ?? 0) > 1)
  )
    label = 'Continuing agent';
  return intent.executionStatusUnavailable ? `${label} (status outdated)` : label;
}

export function nativeDetailStatusLabel(intent: NativeIntent): string {
  return nativeIntentStatusLabel({
    ...intent,
    freshSessionRecovery: canRecover(intent) || undefined,
  });
}

// A navigation cue from the loaded, protected summary. WAITING_FOR_INPUT is a
// legacy read-only question. Reply and recovery requests belong to the detail.
export function nativeWaitingStatus(intent: NativeDiscoveredIntent) {
  if (intent.executionStatusUnavailable) return null;
  switch (intent.execution?.status) {
    case 'AWAITING_USER':
      return intent.execution.responsePending ? null : 'AWAITING_USER';
    case 'WAITING_FOR_INPUT':
      return 'WAITING_FOR_INPUT';
    case 'RECOVERY_REQUIRED':
      return intent.freshSessionRecovery ? 'RECOVERY_REQUIRED' : null;
    default:
      return null;
  }
}

export function isPlatformIntent(intent: Intent): boolean {
  return intent.executionBackend === undefined || intent.executionBackend === 'platform';
}

export function isNativeIntentRoute(pathname: string): boolean {
  return /^\/space\/[^/]+\/native-intent(?:\/|$)/.test(pathname);
}

export function nativeIntentTitle(intent: Pick<NativeIntentSummary, 'title'>): string {
  return intent.title.trim() || 'Untitled native intent';
}

export function discoveryKey(projectId: string, item: DiscoveredIntent): string {
  return JSON.stringify([item.backend, projectId, item.intent.id]);
}

export function discoveryPath(projectId: string, item: DiscoveredIntent): string {
  // An agent-writable platform META flag cannot promote a record to native.
  if (item.backend === 'platform' && !isPlatformIntent(item.intent)) {
    return `/space/${encodeURIComponent(projectId)}`;
  }
  return `/space/${encodeURIComponent(projectId)}/${item.backend === 'native' ? 'native-intent' : 'intent'}/${encodeURIComponent(item.intent.id)}`;
}

export function canDeleteDiscoveredIntent(item: DiscoveredIntent): boolean {
  return (
    item.backend === 'platform' && isPlatformIntent(item.intent) && item.intent.status !== 'RUNNING'
  );
}
