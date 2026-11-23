import type { NativeIntent, NativeRecovery } from '@/services/nativeIntents';
import type { ExecutionCapability, Intent, IntentGate } from '@/services/intents';

// Platform gate controls stay closed on native routes. Native member replies
// and recovery use the protected native detail and their own request contracts.
export type UiExecutionCapability = ExecutionCapability | 'questionAnswer' | 'gateApproval';
type Execution = Pick<Intent, 'executionBackend'> & {
  executionCapabilities?: Partial<Record<UiExecutionCapability, boolean>>;
};

/** Capability checks supplement the existing role, stage and status guards. */
export function executionCapabilityReason(
  intent: Execution | null | undefined,
  capability: UiExecutionCapability,
): string | null {
  if (intent?.executionBackend === 'native') {
    if (capability === 'questionAnswer') return 'Answering native questions is not available yet';
    if (capability === 'gateApproval') return 'Native approvals are not available yet';
    return 'Unavailable in the native execution pilot';
  }
  if (intent?.executionBackend !== undefined && intent.executionBackend !== 'platform') {
    return 'Unavailable for this execution backend';
  }
  return intent?.executionCapabilities?.[capability] === false
    ? 'Disabled for this execution'
    : null;
}

export function executionGateResponseReason(
  intent: Execution | null | undefined,
  gate: Pick<IntentGate, 'kind'>,
): string | null {
  return executionCapabilityReason(
    intent,
    gate.kind === 'question' ? 'questionAnswer' : 'gateApproval',
  );
}

export const imageBlocked = (intent: NativeIntent) =>
  ['revoked', 'unapproved', 'unavailable'].includes(intent.execution?.imageStatus ?? '');
export const workspaceRecoveryBlocked = (reason: NativeRecovery['reason']) =>
  ['INTAKE_UNAVAILABLE', 'WORKFLOW_STATE_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE'].includes(reason);
export const canRecover = (intent: NativeIntent) =>
  !imageBlocked(intent) &&
  intent.executionAvailable === true &&
  intent.execution?.status === 'RECOVERY_REQUIRED' &&
  intent.execution.revision !== undefined &&
  intent.execution.recovery?.canRecover === true &&
  intent.execution.recoveryMode === 'efs-workspace-v1' &&
  intent.execution.stopStatus?.state === 'confirmed' &&
  intent.execution.recovery.workflowResumeState === 'created' &&
  !workspaceRecoveryBlocked(intent.execution.recovery.reason);

export function canCreateFreshNativeIntent({ execution }: NativeIntent): boolean {
  if (execution?.stopStatus?.state !== 'confirmed') return false;
  if (execution.status === 'CANCELLED' || execution.status === 'FAILED') return true;
  const recovery = execution.recovery;
  return (
    execution.status === 'RECOVERY_REQUIRED' &&
    recovery?.canRecover === false &&
    workspaceRecoveryBlocked(recovery.reason) &&
    // Older responses also project this reason when the workflow observation is missing.
    (recovery.reason !== 'WORKFLOW_STATE_UNAVAILABLE' || recovery.workflowResumeState !== undefined)
  );
}
