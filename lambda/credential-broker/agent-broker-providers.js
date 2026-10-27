// Composition root for credential-broker providers: static imports and one list, read only
// by agent-provider-registry.js.
import { KEY_BROKER_PROVIDER } from './key-broker-provider.js';
import { BEDROCK_IAM_BROKER_PROVIDER } from './bedrock-iam-provider.js';

export const AGENT_BROKER_PROVIDERS = Object.freeze([
  KEY_BROKER_PROVIDER,
  BEDROCK_IAM_BROKER_PROVIDER,
]);
