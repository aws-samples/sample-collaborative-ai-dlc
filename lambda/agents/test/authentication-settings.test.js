import { describe, expect, it } from 'vitest';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { AUTHENTICATION_SETTINGS_PROVIDERS } from '../authentication-settings-providers.js';
import { authModeDescriptor } from '../../shared/agent-auth-providers.js';
import {
  addSpace,
  invoke,
  mocks,
  scopeStatuses,
  useSettingsHarness,
} from './helpers/settings-harness.js';

useSettingsHarness();
const { ssm } = mocks;
const view = async (options) =>
  (await invoke({}, { method: 'GET', ...options })).data.authentication;

describe('reviewed credential settings API', () => {
  it('requires platform authorization and a reviewed update before writing secrets', async () => {
    expect((await invoke({ bedrockBearerToken: 'fixture-key' }, { admin: false })).status).toBe(
      403,
    );
    expect(await invoke({ bedrockBearerToken: 'fixture-key' })).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_REVIEW_REQUIRED' },
    });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
  it('previews without a secret write, rejects edited input and applies the exact review once', async () => {
    const input = { bedrockBearerToken: 'fixture-key' };
    const preview = await invoke({ ...input, reviewAction: 'preview' });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.data)).not.toContain('fixture-key');
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(
      await invoke({ bedrockBearerToken: 'different', reviewId: preview.data.id }),
    ).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_REVIEW_STALE' },
    });
    const apply = { ...input, reviewId: preview.data.id };
    expect(await invoke(apply)).toMatchObject({ status: 200, data: { saved: true, revision: 1 } });
    expect(await invoke(apply)).toMatchObject({ status: 200, data: { saved: true, revision: 1 } });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/test/bedrock-bearer-token',
      Type: 'SecureString',
      Value: 'fixture-key',
    });
  });
  it('binds a personal review and write to the authenticated caller', async () => {
    const input = { bedrockBearerToken: 'personal-fixture' };
    // A caller-chosen user id is not a key field, so it is refused rather than ignored.
    expect(
      await invoke(
        { ...input, userId: 'someone-else', reviewAction: 'preview' },
        { admin: false, personal: true },
      ),
    ).toMatchObject({ status: 400, data: { code: 'AGENT_AUTH_INVALID' } });
    const preview = await invoke(
      { ...input, reviewAction: 'preview' },
      { admin: false, personal: true },
    );
    expect(preview.status).toBe(200);
    expect(preview.data.candidate.userId).toBe('reviewer');
    expect(
      (await invoke({ ...input, reviewId: preview.data.id }, { admin: false, personal: true }))
        .status,
    ).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input.Name).toBe(
      '/collab/test/users/reviewer/agent-credentials/bedrock-bearer-token',
    );
  });
  it('keeps unregistered modes gated and reports missing inherited credentials', async () => {
    expect(
      await invoke({
        authenticationChange: {
          action: 'preview',
          candidate: { mode: 'unregistered-test-mode', defaultConnectionId: 'future' },
        },
      }),
    ).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_MODE_UNAVAILABLE' },
    });
    expect(await view()).toMatchObject({
      policy: { mode: 'keys', revision: 0 },
      reviewRequired: true,
      connection: { id: 'legacy-platform-bedrock', state: 'missing' },
    });
  });
  it('accepts only key fields on the personal and space key routes', async () => {
    await addSpace('p1');
    for (const scope of [{ personal: true }, { projectId: 'p1' }]) {
      for (const extra of [
        { bedrockIam: { region: 'eu-west-1' } },
        { authenticationChange: { action: 'preview' } },
        { cliModels: {} },
      ]) {
        expect(
          await invoke({ kiroApiKey: 'kiro-fixture', ...extra, reviewAction: 'preview' }, scope),
        ).toMatchObject({ status: 400, data: { code: 'AGENT_AUTH_INVALID' } });
      }
      expect(
        (await invoke({ kiroApiKey: 'kiro-fixture', reviewAction: 'preview' }, scope)).data
          .candidate,
      ).toMatchObject({ kind: 'credential-update', changes: [{ provider: 'kiro' }] });
    }
    // The platform body mixes keys with model settings and stays open.
    expect(
      await invoke({
        cliModels: { claude: 'model-fixture' },
        bedrockBearerToken: 'platform-fixture',
        reviewAction: 'preview',
      }),
    ).toMatchObject({ status: 200, data: { candidate: { kind: 'credential-update' } } });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('keys authentication view', () => {
  it('describes the platform scope with the keys default and the caller’s permission', async () => {
    const admin = await view();
    expect(admin).toMatchObject({
      hasOverride: false,
      canManageConnections: true,
      personalMechanisms: ['api-key'],
    });
    expect(admin.modes.find((mode) => mode.id === 'keys')).toMatchObject({
      available: true,
      defaultConnectionId: 'legacy-platform-bedrock',
    });
    expect((await view({ admin: false })).canManageConnections).toBe(false);
  });
  it('reports the caller’s permission on the personal and space scopes too', async () => {
    await addSpace('p1');
    await addSpace('owned', { callerRole: 'owner' });
    for (const scope of [{ personal: true }, { projectId: 'p1' }, { projectId: 'owned' }])
      expect((await view(scope)).canManageConnections, JSON.stringify(scope)).toBe(true);
    // A space owner reads the space view but manages only its keys, not its connections.
    for (const scope of [{ personal: true }, { projectId: 'owned' }])
      expect(
        (await view({ ...scope, admin: false })).canManageConnections,
        JSON.stringify(scope),
      ).toBe(false);
  });
  it('keeps personal and space key overrides ahead of the platform key', async () => {
    await addSpace('p1');
    scopeStatuses.platform = { bedrockBearerTokenSet: true, kiroApiKeySet: false };
    expect(await view({ personal: true, admin: false })).toMatchObject({
      hasOverride: false,
      canManageConnections: false,
      connection: { id: 'legacy-platform-bedrock', state: 'ready' },
    });
    expect(await view({ projectId: 'p1' })).toMatchObject({
      hasOverride: false,
      connection: { id: 'legacy-platform-bedrock', state: 'ready' },
    });
    scopeStatuses.user = { bedrockBearerTokenSet: true, kiroApiKeySet: false };
    scopeStatuses.space = { bedrockBearerTokenSet: true, kiroApiKeySet: false };
    expect(await view({ personal: true })).toMatchObject({
      hasOverride: true,
      connection: { id: 'legacy-user-bedrock-reviewer', source: 'user', state: 'ready' },
    });
    expect(await view({ projectId: 'p1' })).toMatchObject({
      hasOverride: true,
      connection: { id: 'legacy-space-bedrock-p1', source: 'space', state: 'ready' },
    });
  });
});

describe('authentication settings provider registration', () => {
  it('registers only available modes, each once, with drafts of their own mechanisms', () => {
    const modes = AUTHENTICATION_SETTINGS_PROVIDERS.map((provider) => provider.mode);
    expect(new Set(modes).size).toBe(modes.length);
    // Keys flows are the built-in credential routes.
    expect(modes).not.toContain('keys');
    for (const provider of AUTHENTICATION_SETTINGS_PROVIDERS) {
      const descriptor = authModeDescriptor(provider.mode);
      expect(descriptor?.planned, provider.mode).toBe(false);
      if (provider.draft) expect(descriptor.mechanisms).toContain(provider.draft.mechanism);
      for (const action of Object.values(provider.actions ?? {}))
        expect(typeof action).toBe('function');
    }
  });
  it('serves the setup route to platform administrators only', async () => {
    const post = (admin) =>
      invoke(
        { mode: 'keys', action: 'defaults' },
        { admin, method: 'POST', path: '/agents/authentication-setup' },
      );
    expect(await post(false)).toMatchObject({
      status: 403,
      data: { code: 'PLATFORM_ADMIN_REQUIRED' },
    });
    // Keys registers no setup steps.
    expect((await post(true)).status).toBe(404);
  });
});
