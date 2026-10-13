import type { Intent } from '@/services/intents';
import type { NativeExecution, NativeIntentSummary } from '@/services/nativeIntents';

// Protected detail reads enrich the in-memory discovery cache, without retaining
// prompts, repository configuration, or reply/recovery authority.
export type NativeDiscoveredIntent = NativeIntentSummary & {
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
  RECOVERING: 'Restoring session',
  WAITING_FOR_INPUT: 'Waiting for input',
  AWAITING_USER: 'Awaiting your reply',
  STOPPED: 'Agent stopped',
  FAILED: 'Execution failed',
  CANCEL_REQUESTED: 'Cancellation requested',
  CANCELLED: 'Execution cancelled',
};

export function nativeIntentStatusLabel(
  intent: Pick<NativeDiscoveredIntent, 'status' | 'execution'>,
): string {
  if (
    intent.execution?.status === 'DISPATCHING' &&
    (intent.execution.responsePending === true || (intent.execution.turnSequence ?? 0) > 1)
  )
    return 'Continuing agent';
  return intent.execution
    ? nativeExecutionLabels[intent.execution.status]
    : nativePreparationLabels[intent.status];
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
