import { authorizeAgentCredentialRequest as authorize } from './agent-authentication.js';
import { withBedrockIamWire } from './bedrock-iam-wire.js';

// Compose provider wire compatibility outside the authentication host.
export const authorizeAgentCredentialRequest = withBedrockIamWire(authorize);
