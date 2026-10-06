import { AGENT_AUTH_MODES_CATALOG } from './agent-auth-providers.js';
export const discoverAgentModels = async ({
  credentialBindings,
  withModels = true,
  loadKeyModels,
  loadRuntimeCapabilities,
}) => {
  const mode = AGENT_AUTH_MODES_CATALOG.find(
    ({ id }) => id === (credentialBindings.bedrock?.mode ?? 'keys'),
  );
  const runtimeModels = mode?.modelDiscovery === 'runtime';
  const [keyModels, runtimeCaps] = await Promise.all([
    withModels && !runtimeModels ? loadKeyModels() : [],
    loadRuntimeCapabilities(),
  ]);
  return {
    claudeModels: runtimeModels ? (runtimeCaps?.bedrockModels ?? []) : keyModels,
    runtimeCaps,
  };
};
