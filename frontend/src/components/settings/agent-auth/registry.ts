import type { AgentAuthProviderUi } from './contract';

export const AGENT_AUTH_PROVIDER_UIS: readonly AgentAuthProviderUi[] = Object.freeze([]);

export const agentAuthProviderUi = (mode?: string | null): AgentAuthProviderUi | undefined =>
  AGENT_AUTH_PROVIDER_UIS.find((ui) => ui.mode === mode);
