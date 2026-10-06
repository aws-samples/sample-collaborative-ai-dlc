// Test helper: settings providers for the synthetic shared modes. Suites install them through
// vi.mock of the settings root (together with the shared root mock that registers the modes):
//   vi.mock('../authentication-settings-providers.js', async () => ({
//     AUTHENTICATION_SETTINGS_PROVIDERS: (await import('./helpers/fake-settings-providers.js'))
//       .FAKE_SETTINGS_PROVIDERS,
//   }));
// Only pure modules here: the shared root mock loads this file while the root is resolving.
import { authError } from '../../../shared/agent-auth-protocol.js';
import { TEST_CONNECTION_MODE } from '../../../shared/test/helpers/auth-modes.js';

// Available, with setup steps but no connection draft.
export const DRAFTLESS_TEST_MODE = Object.freeze({
  ...TEST_CONNECTION_MODE,
  id: 'draftless-test-mode',
  label: 'Draftless test',
});

export const TEST_SETTINGS_PROVIDER = Object.freeze({
  mode: TEST_CONNECTION_MODE.id,
  draft: Object.freeze({
    mechanism: 'oauth-machine',
    // Proves the provider, not the browser, has the last word on stored configuration.
    prepare: (configuration) => ({
      ...configuration,
      region: String(configuration?.region ?? '').toLowerCase(),
    }),
  }),
  actions: Object.freeze({
    echo: async (input, ctx) => ({
      statusCode: 201,
      body: {
        input,
        projectId: ctx.projectId,
        runtimeTarget: ctx.runtimeTarget,
        region: ctx.env.AWS_REGION,
      },
    }),
    invalid: async () => {
      throw authError('AGENT_AUTH_INVALID', 'The fixture region is required');
    },
    broken: async () => {
      throw new Error('private provider diagnostics');
    },
    verify: (input, ctx) =>
      ctx.verifyConnection({ mechanism: 'oauth-machine', configuration: input.configuration }),
  }),
});

export const DRAFTLESS_SETTINGS_PROVIDER = Object.freeze({
  mode: DRAFTLESS_TEST_MODE.id,
  actions: Object.freeze({ defaults: async () => ({ statusCode: 200, body: {} }) }),
});

export const FAKE_SETTINGS_PROVIDERS = Object.freeze([
  TEST_SETTINGS_PROVIDER,
  DRAFTLESS_SETTINGS_PROVIDER,
]);
