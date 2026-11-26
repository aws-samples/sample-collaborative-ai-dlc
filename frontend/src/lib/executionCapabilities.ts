import type { ExecutionCapability, Intent, IntentGate } from '@/services/intents';

// Native responses stay closed independently of the existing API capability
// fields until protected native response delivery is available.
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
