import { KEY_REDEMPTION_ADAPTERS } from '../shared/agent-auth-redemption.js';

// Stored API keys carry no renewal authority, so their leases compose to apiKeyLease(value).
export const KEY_BROKER_PROVIDER = Object.freeze({
  id: 'keys',
  adapters: KEY_REDEMPTION_ADAPTERS,
});
