// Absence belongs to retained executions. A deployment must never reinterpret
// their checkpoint or admission contract using its current default.
export const NATIVE_WORKSPACE_RECOVERY = 'efs-workspace-v1';
export const nativeWorkspaceRecovery = (configuration) =>
  configuration?.recoveryMode === NATIVE_WORKSPACE_RECOVERY;
export const nativeRecoveryModeValid = (configuration) =>
  configuration?.recoveryMode === undefined || nativeWorkspaceRecovery(configuration);
export const nativeCommandSchema = (configuration) =>
  nativeWorkspaceRecovery(configuration) ? 2 : 1;
