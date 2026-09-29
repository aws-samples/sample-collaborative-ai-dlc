import type { AgentAuthProviderUi } from './contract';
import { bedrockIamUi } from './bedrock-iam';

export const AGENT_AUTH_PROVIDER_UIS: readonly AgentAuthProviderUi[] = Object.freeze([
  bedrockIamUi,
]);

export const agentAuthProviderUi = (mode?: string | null): AgentAuthProviderUi | undefined =>
  AGENT_AUTH_PROVIDER_UIS.find((ui) => ui.mode === mode);
