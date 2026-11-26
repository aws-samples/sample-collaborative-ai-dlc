// The frozen legacy HTTP router imports this default factory. Compatibility
// tests always inject checkWorkspace; never inspect or provision a workspace.
export const createNativeWorkspaceCheck = () => {
  throw new Error('Legacy protocol fixture requires an injected workspace check');
};
