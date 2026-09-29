import { defineAuthMode, normalizeConfigurationFields } from '../../agent-auth-mode-registry.js';

// An available non-keys mode for foundation suites. oauth-machine allows platform and space
// connections only, so personal key overrides stay keys-only.
export const TEST_CONNECTION_MODE = defineAuthMode({
  id: 'test-connection-mode',
  label: 'Test connection',
  backend: 'bedrock',
  mechanisms: ['oauth-machine'],
  normalizeConfiguration: (configuration) =>
    normalizeConfigurationFields(configuration, { region: 'string' }),
});

// vi.mock factory for the shared root (agent-auth-modes.js). It keeps every real registration
// and appends `extra`, so hosts built from the root at load see both. vi.mock is hoisted above
// static imports, so load the helper inside the factory:
//   vi.mock('../agent-auth-modes.js', async (importOriginal) =>
//     (await import('./helpers/auth-modes.js')).withAuthModes(importOriginal));
export const withAuthModes = async (importOriginal, extra = [TEST_CONNECTION_MODE]) => {
  const original = await importOriginal();
  return {
    ...original,
    AGENT_AUTH_MODE_DESCRIPTORS: Object.freeze([...original.AGENT_AUTH_MODE_DESCRIPTORS, ...extra]),
  };
};
