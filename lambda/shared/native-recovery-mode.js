// Recovery is an explicit immutable execution pin. Missing or unknown modes
// never select another protocol or acquire permission to launch a CLI.
export const NATIVE_WORKSPACE_RECOVERY = 'efs-workspace-v1';
export const nativeWorkspaceRecovery = (configuration) =>
  configuration?.recoveryMode === NATIVE_WORKSPACE_RECOVERY;
