// A runtime auth provider for foundation suites, served for the shared synthetic mode. Keep
// this module free of host imports (agent-auth-contracts.js, credential-material-registry.js):
// vi.mock factories load it while the roots it extends are still being mocked.
import { authError } from '../../../shared/agent-auth-protocol.js';
import { TEST_CONNECTION_MODE } from '../../../shared/test/helpers/auth-modes.js';

// Planned stays planned whichever real modes providers make available.
export const TEST_PLANNED_MODE = Object.freeze({
  ...TEST_CONNECTION_MODE,
  id: 'planned-test-mode',
  planned: true,
});
export const FAKE_RUNTIME_MODES = Object.freeze([TEST_CONNECTION_MODE, TEST_PLANNED_MODE]);

export const FAKE_MATERIAL_TYPE = 'test-token';
export const FAKE_CONTROLLED_ENV = 'TEST_PROVIDER_REGION';
export const FAKE_TOKEN_ENV = 'TEST_PROVIDER_TOKEN';

// Delivers its token only through credentialEnvironment, like a session endpoint would, so
// no key env var exists that an env-based authentication check could observe.
export const FAKE_RUNTIME_PROVIDER = Object.freeze({
  id: 'test-runtime',
  modes: Object.freeze([TEST_CONNECTION_MODE.id]),
  materials: Object.freeze({
    [FAKE_MATERIAL_TYPE]: ({ binding, material }) => {
      if (binding.mode !== TEST_CONNECTION_MODE.id)
        throw authError('AGENT_AUTH_LEASE_INVALID', 'Test material does not match its mode');
      return {
        env: { [FAKE_CONTROLLED_ENV]: binding.configuration.region },
        credentialEnvironment: { [FAKE_TOKEN_ENV]: material.token },
      };
    },
  }),
  controlledEnv: Object.freeze([FAKE_CONTROLLED_ENV, FAKE_TOKEN_ENV]),
  capabilities: async ({ env }) => ({ testModels: [`${env[FAKE_CONTROLLED_ENV]}.test-model`] }),
});

// A v2 platform binding of the synthetic mode, as the broker returns it.
export const FAKE_BINDING = Object.freeze({
  version: 2,
  provider: 'bedrock',
  source: 'platform',
  connectionId: 'test-platform',
  connectionRevision: 1,
  policyRevision: 1,
  mode: TEST_CONNECTION_MODE.id,
  backend: 'bedrock',
  mechanism: 'oauth-machine',
  configuration: Object.freeze({ region: 'eu-west-1' }),
});

// vi.mock factory for the runtime root (runtime-auth-providers.js). It keeps every real
// registration and appends `extra`; the synthetic shared modes must be mocked in too:
//   vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) => {
//     const { withAuthModes } = await import('../../shared/test/helpers/auth-modes.js');
//     const { FAKE_RUNTIME_MODES } = await import('./helpers/fake-runtime-provider.js');
//     return withAuthModes(importOriginal, FAKE_RUNTIME_MODES);
//   });
//   vi.mock('../runtime-auth-providers.js', async (importOriginal) =>
//     (await import('./helpers/fake-runtime-provider.js')).withRuntimeProviders(importOriginal));
export const withRuntimeProviders = async (importOriginal, extra = [FAKE_RUNTIME_PROVIDER]) => {
  const original = await importOriginal();
  return {
    ...original,
    RUNTIME_AUTH_PROVIDERS: Object.freeze([...original.RUNTIME_AUTH_PROVIDERS, ...extra]),
  };
};
