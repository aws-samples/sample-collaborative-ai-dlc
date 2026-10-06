import { describe, expect, it, vi } from 'vitest';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { createAuthenticationSettingsService } from '../authentication-settings-service.js';
import { verifyAgentCredentialGrant } from '../../shared/agent-credential-grants.js';
import { TEST_CONNECTION_MODE } from '../../shared/test/helpers/auth-modes.js';
import { DRAFTLESS_TEST_MODE, TEST_SETTINGS_PROVIDER } from './helpers/fake-settings-providers.js';
import {
  GRANT_SECRET,
  RUNTIME_ARN,
  addSpace,
  invoke,
  mocks,
  useSettingsHarness,
} from './helpers/settings-harness.js';

// Synthetic modes and their settings providers stand in for any real provider.
vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) => {
  const { withAuthModes, TEST_CONNECTION_MODE: mode } =
    await import('../../shared/test/helpers/auth-modes.js');
  const { DRAFTLESS_TEST_MODE: draftless } = await import('./helpers/fake-settings-providers.js');
  return withAuthModes(importOriginal, [
    mode,
    draftless,
    { ...mode, id: 'planned-test-mode', planned: true },
  ]);
});
vi.mock('../authentication-settings-providers.js', async () => ({
  AUTHENTICATION_SETTINGS_PROVIDERS: (await import('./helpers/fake-settings-providers.js'))
    .FAKE_SETTINGS_PROVIDERS,
}));

useSettingsHarness();
const MODE = TEST_CONNECTION_MODE.id;
const SETUP = { method: 'POST', path: '/agents/authentication-setup' };
const change = (candidate) => invoke({ authenticationChange: { action: 'preview', candidate } });
const apply = async (candidate) => {
  const preview = await change(candidate);
  expect(preview.status, JSON.stringify(preview.data)).toBe(200);
  const applied = await invoke({
    authenticationChange: { action: 'apply', reviewId: preview.data.id },
  });
  expect(applied.status).toBe(200);
  return preview.data.candidate;
};
const draft = (extra = {}) => ({
  kind: 'connection-draft',
  mode: MODE,
  configuration: { region: 'EU-WEST-1' },
  ...extra,
});
const view = async (options) =>
  (await invoke({}, { method: 'GET', ...options })).data.authentication;
// An AgentCore runtime that can verify MODE connections and accepts every check.
const verifyingRuntime = async (input) => {
  const { command } = JSON.parse(Buffer.from(input.payload).toString());
  const body =
    command === 'capabilities'
      ? {
          ok: true,
          agentAuthProtocol: 2,
          agentAuthModes: ['keys', MODE],
          agentAuthVerification: [MODE],
        }
      : { verified: true };
  return { response: { transformToString: async () => JSON.stringify(body) } };
};

describe('connection drafts', () => {
  it('stores a server-minted connection and activates it through review', async () => {
    const preview = await change(
      draft({ id: 'chosen-id', revision: 7, source: 'user', mechanism: 'api-key' }),
    );
    expect(preview.status).toBe(200);
    const { candidate } = preview.data;
    expect(candidate).toEqual({
      kind: 'connection-create',
      source: 'platform',
      select: true,
      storage: {},
      connection: {
        id: expect.stringMatching(new RegExp(`^${MODE}-[0-9a-f-]{36}$`)),
        revision: 1,
        mode: MODE,
        backend: 'bedrock',
        mechanism: 'oauth-machine',
        source: 'platform',
        state: 'ready',
        configuration: { region: 'eu-west-1' },
      },
    });
    expect((await view()).policy.mode).toBe('keys');
    await invoke({ authenticationChange: { action: 'apply', reviewId: preview.data.id } });
    expect(await view()).toMatchObject({
      policy: { mode: MODE, defaultConnectionId: candidate.connection.id },
      connection: candidate.connection,
      hasOverride: false,
      canManageConnections: true,
      personalMechanisms: [],
    });
    expect((await view({ admin: false })).canManageConnections).toBe(false);
  });

  it('overrides a space in the active mode and restores inheritance', async () => {
    await addSpace('p1');
    const platform = await apply(draft());
    const space = await apply(draft({ projectId: 'p1', configuration: { region: 'US-EAST-1' } }));
    expect(space).toMatchObject({
      source: 'space',
      projectId: 'p1',
      connection: { source: 'space', projectId: 'p1', configuration: { region: 'us-east-1' } },
    });
    expect(await view({ projectId: 'p1' })).toMatchObject({
      hasOverride: true,
      connection: { id: space.connection.id },
    });
    // Personal and platform views keep the platform default.
    expect(await view({ personal: true })).toMatchObject({
      hasOverride: false,
      connection: { id: platform.connection.id },
    });
    expect(await apply({ kind: 'space-selection', projectId: 'p1', connectionId: null })).toEqual({
      kind: 'space-selection',
      source: 'space',
      projectId: 'p1',
      connectionId: null,
    });
    expect(await view({ projectId: 'p1' })).toMatchObject({
      hasOverride: false,
      connection: { id: platform.connection.id },
    });
  });

  it('refuses drafts without provider support, dormant space selections and unknown spaces', async () => {
    await addSpace('p1');
    for (const mode of [DRAFTLESS_TEST_MODE.id, 'keys', 'planned-test-mode', 'unregistered']) {
      expect(await change(draft({ mode }))).toMatchObject({
        status: 409,
        data: { code: 'AGENT_AUTH_MODE_UNAVAILABLE' },
      });
    }
    expect(await change(draft({ projectId: 'p1' }))).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_MODE_MISMATCH' },
    });
    expect(await change(draft({ projectId: 'missing-space' }))).toMatchObject({
      status: 400,
      data: { error: 'Space not found', code: 'AGENT_AUTH_INVALID' },
    });
    expect(
      await change({ kind: 'space-selection', projectId: 'missing-space', connectionId: null }),
    ).toMatchObject({ status: 400, data: { error: 'Space not found' } });
  });

  it('accepts only policy changes, inheritance and drafts from the browser', async () => {
    await addSpace('p1');
    const platform = await apply(draft());
    const connection = { ...platform.connection, id: `${MODE}-chosen` };
    for (const candidate of [
      { kind: 'connection-create', select: true, connection },
      {
        kind: 'credential-update',
        source: 'platform',
        changes: [{ provider: 'bedrock', action: 'clear', digest: 'a'.repeat(64) }],
      },
      { kind: 'space-selection', projectId: 'p1', connectionId: platform.connection.id },
      { kind: 'space-inherit', projectId: 'p1' },
      null,
      [],
    ]) {
      expect(await change(candidate), JSON.stringify(candidate)).toMatchObject({
        status: 400,
        data: { code: 'AGENT_AUTH_INVALID' },
      });
    }
    // The kind-less and 'policy' aliases still switch modes.
    expect(
      await apply({ kind: 'policy', mode: 'keys', defaultConnectionId: 'legacy-platform-bedrock' }),
    ).toEqual({
      kind: 'policy-change',
      mode: 'keys',
      defaultConnectionId: 'legacy-platform-bedrock',
    });
    expect(await apply({ mode: MODE, defaultConnectionId: platform.connection.id })).toEqual({
      kind: 'policy-change',
      mode: MODE,
      defaultConnectionId: platform.connection.id,
    });
    expect(mocks.ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('keeps Bedrock keys to keys mode while Kiro keys stay writable', async () => {
    await apply(draft());
    expect(await invoke({ bedrockBearerToken: 'disabled', reviewAction: 'preview' })).toMatchObject(
      { status: 409, data: { code: 'AGENT_AUTH_MODE_MISMATCH' } },
    );
    expect(
      await invoke({ bedrockBearerToken: 'disabled', reviewAction: 'preview' }, { personal: true }),
    ).toMatchObject({ status: 409, data: { code: 'AGENT_AUTH_MODE_MISMATCH' } });
    expect(
      (await invoke({ kiroApiKey: 'independent', reviewAction: 'preview' })).data.candidate,
    ).toMatchObject({ kind: 'credential-update', changes: [{ provider: 'kiro' }] });
  });
});

describe('authentication setup route', () => {
  it('guards the request before any provider runs', async () => {
    expect(await invoke({ mode: MODE, action: 'echo' }, { ...SETUP, admin: false })).toMatchObject({
      status: 403,
      data: { code: 'PLATFORM_ADMIN_REQUIRED' },
    });
    expect(await invoke('{not json', SETUP)).toMatchObject({
      status: 400,
      data: { error: 'Invalid JSON body' },
    });
    for (const body of [[], 'null', '"echo"']) expect((await invoke(body, SETUP)).status).toBe(400);
    for (const mode of ['unregistered-test-mode', 'keys', 'planned-test-mode', undefined])
      expect((await invoke({ mode, action: 'echo' }, SETUP)).status).toBe(404);
    for (const action of ['missing', 'constructor', 'toString', undefined])
      expect(await invoke({ mode: MODE, action }, SETUP)).toMatchObject({
        status: 400,
        data: { error: 'Unsupported authentication setup action' },
      });
    expect(await invoke({ mode: MODE, action: 'echo', projectId: 'missing-space' }, SETUP)).toEqual(
      { status: 404, data: { error: 'Space not found' } },
    );
  });

  it('passes the provider’s response through with a server-built context', async () => {
    await addSpace('p1');
    expect(
      await invoke({ mode: MODE, action: 'echo', config: { region: 'eu-west-1' } }, SETUP),
    ).toEqual({
      status: 201,
      data: {
        input: { config: { region: 'eu-west-1' } },
        projectId: null,
        runtimeTarget: { agentRuntimeArn: RUNTIME_ARN },
        region: 'us-east-1',
      },
    });
    expect(
      (await invoke({ mode: MODE, action: 'echo', projectId: 'p1', extra: 1 }, SETUP)).data,
    ).toMatchObject({
      input: { extra: 1 },
      projectId: 'p1',
      runtimeTarget: { agentRuntimeArn: RUNTIME_ARN },
    });
    expect(await invoke({ mode: DRAFTLESS_TEST_MODE.id, action: 'defaults' }, SETUP)).toEqual({
      status: 200,
      data: {},
    });
  });

  it('maps provider failures without leaking diagnostics', async () => {
    expect(await invoke({ mode: MODE, action: 'invalid' }, SETUP)).toEqual({
      status: 400,
      data: { error: 'The fixture region is required' },
    });
    const broken = await invoke({ mode: MODE, action: 'broken' }, SETUP);
    expect(broken.status).toBe(502);
    expect(JSON.stringify(broken.data)).not.toContain('private');
  });

  it('verifies an unsaved connection for the provider’s mode and scope', async () => {
    await addSpace('p1');
    mocks.agentcore.on(InvokeAgentRuntimeCommand).callsFake(verifyingRuntime);
    const result = await invoke(
      { mode: MODE, action: 'verify', projectId: 'p1', configuration: { region: 'eu-west-1' } },
      SETUP,
    );
    expect(result).toEqual({ status: 200, data: { verified: true } });
    const calls = mocks.agentcore.commandCalls(InvokeAgentRuntimeCommand);
    expect(calls).toHaveLength(2);
    const check = JSON.parse(Buffer.from(calls[1].args[0].input.payload).toString());
    expect(check).toMatchObject({
      command: 'verify-connection',
      projectId: 'p1',
      credentialBinding: {
        mode: MODE,
        mechanism: 'oauth-machine',
        source: 'space',
        projectId: 'p1',
        policyRevision: 0,
        configuration: { region: 'eu-west-1' },
      },
    });
    expect(verifyAgentCredentialGrant(check.agentCredentialGrant, GRANT_SECRET).purpose).toBe(
      'verify-connection',
    );
  });

  it('runs space steps and checks against the space’s runtime, not the platform’s', async () => {
    // The harness resolves every space to the platform runtime, so resolve one elsewhere here.
    const spaceTarget = Object.freeze({
      agentRuntimeArn: `${RUNTIME_ARN}-space`,
      qualifier: 'revision_r_2',
    });
    const settings = createAuthenticationSettingsService({
      env: { AGENTCORE_RUNTIME_ARN: RUNTIME_ARN },
      agentcore: new BedrockAgentCoreClient({ region: 'us-east-1' }),
      logger: { error: vi.fn() },
      providers: [TEST_SETTINGS_PROVIDER],
      resolveTarget: async (projectId) => (projectId === 'p1' ? spaceTarget : null),
    });
    const run = (body) => settings.providerAction({ mode: MODE, ...body }, { platformAdmin: true });
    expect((await run({ action: 'echo' })).body.runtimeTarget).toEqual({
      agentRuntimeArn: RUNTIME_ARN,
    });
    expect((await run({ action: 'echo', projectId: 'p1' })).body.runtimeTarget).toEqual(
      spaceTarget,
    );
    mocks.agentcore.on(InvokeAgentRuntimeCommand).callsFake(verifyingRuntime);
    expect(
      await run({ action: 'verify', projectId: 'p1', configuration: { region: 'eu-west-1' } }),
    ).toEqual({ statusCode: 200, body: { verified: true } });
    const inputs = mocks.agentcore
      .commandCalls(InvokeAgentRuntimeCommand)
      .map((call) => call.args[0].input);
    expect(
      inputs.map((input) => JSON.parse(Buffer.from(input.payload).toString()).command),
    ).toEqual(['capabilities', 'verify-connection']);
    for (const input of inputs) expect(input).toMatchObject(spaceTarget);
  });
});

describe('settings provider composition', () => {
  const compose = (providers) =>
    createAuthenticationSettingsService({ env: {}, providers, resolveTarget: async () => null });
  it('accepts valid providers and rejects misregistrations at construction', () => {
    expect(() => compose([TEST_SETTINGS_PROVIDER, { mode: DRAFTLESS_TEST_MODE.id }])).not.toThrow();
    const unavailable = 'must name an available authentication mode';
    for (const [providers, message] of [
      [[{ mode: 'planned-test-mode' }], `planned-test-mode ${unavailable}`],
      [[{ mode: 'unregistered-test-mode' }], `unregistered-test-mode ${unavailable}`],
      [[{}], `undefined ${unavailable}`],
      [[null], `undefined ${unavailable}`],
      [[TEST_SETTINGS_PROVIDER, { mode: MODE }], `${MODE} is registered twice`],
      [
        [{ mode: MODE, draft: { mechanism: 'api-key' } }],
        `${MODE} declares a draft whose mechanism is not one of its mode`,
      ],
      [[{ mode: MODE, draft: 'oauth-machine' }], `${MODE} declares a draft that is not an object`],
      [
        [{ mode: MODE, draft: { mechanism: 'oauth-machine', prepare: 'lowercase' } }],
        `${MODE} declares a draft prepare that is not a function`,
      ],
      [
        [{ mode: MODE, draft: { mechanism: 'oauth-machine', normalize: () => ({}) } }],
        `${MODE} declares unsupported draft fields: normalize`,
      ],
      [
        [{ mode: MODE, actions: { setup: 'not a function' } }],
        `${MODE} declares actions that are not functions`,
      ],
      [[{ mode: MODE, drafts: {} }], `${MODE} declares unsupported fields: drafts`],
      [{ mode: MODE }, 'Authentication settings providers must be a list'],
    ]) {
      expect(() => compose(providers), JSON.stringify(providers)).toThrow(
        new TypeError(
          message.startsWith('Authentication')
            ? message
            : `Authentication settings provider ${message}`,
        ),
      );
    }
  });
  it('dispatches drafts only for the injected providers', async () => {
    const settings = compose([
      { mode: DRAFTLESS_TEST_MODE.id, draft: { mechanism: 'oauth-machine' } },
    ]);
    await expect(
      settings.changeCandidate({ kind: 'connection-draft', mode: MODE, configuration: {} }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_MODE_UNAVAILABLE' });
    await expect(
      settings.changeCandidate({
        kind: 'connection-draft',
        mode: DRAFTLESS_TEST_MODE.id,
        configuration: { region: 'eu-west-1' },
      }),
    ).resolves.toMatchObject({
      kind: 'connection-create',
      connection: {
        mode: DRAFTLESS_TEST_MODE.id,
        source: 'platform',
        configuration: { region: 'eu-west-1' },
      },
    });
  });
});
