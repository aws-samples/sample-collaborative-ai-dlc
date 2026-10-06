import { TEST_CONNECTION_MODE } from '../../../shared/test/helpers/auth-modes.js';

export const FIXTURE_ADAPTER_KEY = `${TEST_CONNECTION_MODE.backend}:${TEST_CONNECTION_MODE.mechanisms[0]}`;
export const FIXTURE_RENEWAL = Object.freeze({
  action: 'renew-test-credentials',
  audience: 'aidlc-test-renewal',
  ttlSeconds: 3600,
});
export const FIXTURE_DENIED = 'TEST_PROVIDER_DENIED';
export const FIXTURE_MATERIAL_TYPE = 'test-token';

// Deterministic stand-in for a provider SDK client; suites inject spies per request instead.
export const fixtureTokenClient = () => ({
  issue: async ({ connectionId }) => ({ token: `token-${connectionId}`, expiresAt: null }),
});

// Shaped like a real second provider: expiring material from a lazily created client, a renewal
// policy, connection verification, capability isolation and a classifier. The classifier maps
// every AccessDenied, as a careless provider would, so suites can show the host scopes it to
// this provider's adapter. Like a real provider it reads configuration from `connection`, which a
// verification fills with the signed binding of an unsaved connection; the id comes from the
// binding because a binding names it connectionId.
export const createFixtureBrokerProvider = (overrides = {}) => ({
  id: 'test-provider',
  adapters: {
    [FIXTURE_ADAPTER_KEY]: async ({ connection, binding, claims, request, deps }) => {
      const { token, expiresAt } = await deps.tokenClient.issue({
        connectionId: binding.connectionId,
        configuration: connection.configuration,
        grantId: claims.grantId,
        request,
      });
      return { material: { type: FIXTURE_MATERIAL_TYPE, token }, expiresAt };
    },
  },
  renewal: FIXTURE_RENEWAL,
  verification: true,
  isolateCapabilityFailures: true,
  errorCodes: [FIXTURE_DENIED],
  classifyError: (error) =>
    ['AccessDenied', 'AccessDeniedException'].includes(error?.name)
      ? FIXTURE_DENIED
      : error?.name === 'ThrottlingException'
        ? 'TEST_PROVIDER_UNDECLARED'
        : null,
  createDependencies: () => ({ tokenClient: fixtureTokenClient() }),
  ...overrides,
});
export const FIXTURE_BROKER_PROVIDER = createFixtureBrokerProvider();

// vi.mock factory for the broker root (agent-broker-providers.js). It keeps every real
// registration and appends `extra`. Load the helper inside the factory:
//   vi.mock('../agent-broker-providers.js', async (importOriginal) =>
//     (await import('./helpers/fixture-broker-provider.js')).withBrokerProviders(importOriginal));
export const withBrokerProviders = async (importOriginal, extra = [FIXTURE_BROKER_PROVIDER]) => {
  const original = await importOriginal();
  return {
    ...original,
    AGENT_BROKER_PROVIDERS: Object.freeze([...original.AGENT_BROKER_PROVIDERS, ...extra]),
  };
};
