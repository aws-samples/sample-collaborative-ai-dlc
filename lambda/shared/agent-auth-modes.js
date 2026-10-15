// Composition root for shared authentication modes: static imports and one list, read only
// by agent-auth-providers.js. Every Lambda and the AgentCore image bundle these descriptors.
import { KEYS_MODE, PLANNED_LITELLM_MODE } from './agent-auth-builtin-modes.js';
import { BEDROCK_IAM_MODE } from './agent-auth-bedrock-iam-schema.js';

export const AGENT_AUTH_MODE_DESCRIPTORS = Object.freeze([
  KEYS_MODE,
  BEDROCK_IAM_MODE,
  PLANNED_LITELLM_MODE,
]);
