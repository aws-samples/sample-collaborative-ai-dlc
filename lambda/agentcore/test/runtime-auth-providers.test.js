import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_ADAPTER_ENV_NAMES,
  CREDENTIAL_MATERIAL_ADAPTERS,
  RUNTIME_AGENT_AUTH_MODES,
  composeRuntimeAuthProviders,
} from '../credential-material-registry.js';
import { KEYS_RUNTIME_PROVIDER } from '../keys-runtime-provider.js';
import { authenticatedClis, resolveInvocationAgentAuth } from '../auth-resolver.js';
import { capabilities } from '../commands/capabilities.js';
import { RESERVED_MCP_ENV_KEYS, resolveMcpSecrets } from '../mcp-secret-resolver.js';
import {
  CUSTOM_MCP_AUTH_ENV_SCRUB,
  buildMcpConfig,
  buildOpenCodeConfig,
} from '../stage-materializer.js';
import { createRuntimeMcpBridge } from '../mcp/runtime-bridge.js';
import { apiKeyLease, normalizeCredentialLease } from '../../shared/agent-credential-lease.js';
import {
  FAKE_BINDING,
  FAKE_CONTROLLED_ENV,
  FAKE_MATERIAL_TYPE,
  FAKE_TOKEN_ENV,
  FAKE_RUNTIME_PROVIDER,
} from './helpers/fake-runtime-provider.js';

// Both roots keep every real registration and gain the synthetic mode and its provider, so
// the host views below are built at load exactly as a provider's root line builds them.
vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) => {
  const { withAuthModes } = await import('../../shared/test/helpers/auth-modes.js');
  const { FAKE_RUNTIME_MODES } = await import('./helpers/fake-runtime-provider.js');
  return withAuthModes(importOriginal, FAKE_RUNTIME_MODES);
});
vi.mock('../runtime-auth-providers.js', async (importOriginal) =>
  (await import('./helpers/fake-runtime-provider.js')).withRuntimeProviders(importOriginal),
);

const provider = (overrides = {}) => ({
  id: 'fixture-runtime',
  modes: ['keys'],
  materials: { 'fixture-token': () => ({}) },
  ...overrides,
});
const fakeLease = () =>
  normalizeCredentialLease({
    version: 1,
    material: { type: FAKE_MATERIAL_TYPE, token: 'scoped-token' },
    expiresAt: Date.now() + 120_000,
  });
const kiro = { provider: 'kiro', source: 'platform' };
const capabilitiesProbe = (credentials, env = {}) =>
  resolveInvocationAgentAuth({
    authMode: 'capabilities',
    payload: {
      credentialBindings: Object.fromEntries(
        credentials.map(({ binding }) => [binding.provider, binding]),
      ),
      agentCredentialGrant: 'grant',
    },
    env,
    broker: async () => ({
      purpose: 'capabilities',
      projectId: null,
      executionId: null,
      credentials,
    }),
  });

describe('composeRuntimeAuthProviders', () => {
  it('merges materials, modes and a deduplicated controlled env in registration order', () => {
    const composed = composeRuntimeAuthProviders([
      FAKE_RUNTIME_PROVIDER,
      provider({ controlledEnv: [FAKE_CONTROLLED_ENV, 'FIXTURE_ENDPOINT'] }),
    ]);
    expect(Object.keys(composed.materialAdapters)).toEqual([FAKE_MATERIAL_TYPE, 'fixture-token']);
    expect(composed.materialAdapters[FAKE_MATERIAL_TYPE]).toBe(
      FAKE_RUNTIME_PROVIDER.materials[FAKE_MATERIAL_TYPE],
    );
    expect(composed.modes).toEqual(['test-connection-mode', 'keys']);
    expect(composed.controlledEnv).toEqual([
      FAKE_CONTROLLED_ENV,
      FAKE_TOKEN_ENV,
      'FIXTURE_ENDPOINT',
    ]);
    expect(composed.materialEnv).toEqual({
      [FAKE_MATERIAL_TYPE]: [FAKE_CONTROLLED_ENV, FAKE_TOKEN_ENV],
      'fixture-token': [FAKE_CONTROLLED_ENV, 'FIXTURE_ENDPOINT'],
    });
    for (const view of [
      composed,
      composed.materialAdapters,
      composed.modes,
      composed.controlledEnv,
      composed.materialEnv,
      composed.materialEnv[FAKE_MATERIAL_TYPE],
    ])
      expect(Object.isFrozen(view)).toBe(true);
  });

  it('rejects duplicate ids, modes and material types', () => {
    expect(() =>
      composeRuntimeAuthProviders([FAKE_RUNTIME_PROVIDER, { ...FAKE_RUNTIME_PROVIDER }]),
    ).toThrow('Runtime authentication provider test-runtime is registered twice');
    expect(() =>
      composeRuntimeAuthProviders([
        FAKE_RUNTIME_PROVIDER,
        provider({ modes: ['test-connection-mode'] }),
      ]),
    ).toThrow('advertises mode test-connection-mode, which is already served');
    expect(() =>
      composeRuntimeAuthProviders([
        KEYS_RUNTIME_PROVIDER,
        provider({ modes: ['test-connection-mode'], materials: { 'api-key': () => ({}) } }),
      ]),
    ).toThrow('adapts material api-key, which is already adapted');
  });

  it('rejects a mode that is missing or planned in the shared catalog', () => {
    for (const mode of ['unregistered-test-mode', 'planned-test-mode', 'kiro', null])
      expect(() => composeRuntimeAuthProviders([provider({ modes: [mode] })])).toThrow(
        `Runtime authentication provider fixture-runtime advertises unavailable mode ${mode}`,
      );
  });

  it('rejects malformed providers at load', () => {
    const session = Object.assign(() => ({}), { createSession: 'not a function' });
    for (const [entry, message] of [
      [provider({ controlledEnvs: ['FIXTURE_ENDPOINT'] }), 'unsupported fields: controlledEnvs'],
      [provider({ modes: [] }), 'requires a mode'],
      [provider({ materials: {} }), 'requires credential materials'],
      [provider({ materials: { 'fixture-token': {} } }), 'invalid adapter for material'],
      [provider({ materials: { 'fixture-token': session } }), 'invalid adapter for material'],
      [provider({ materials: { 'bad type': () => ({}) } }), 'material type is invalid'],
      [provider({ controlledEnv: 'FIXTURE_ENDPOINT' }), 'invalid controlled env names'],
      [provider({ controlledEnv: ['FIXTURE-ENDPOINT'] }), 'invalid controlled env names'],
      [provider({ capabilities: {} }), 'invalid capabilities hook'],
      [provider({ id: 'bad id' }), 'Runtime authentication provider id is invalid'],
      [null, 'Runtime authentication provider is required'],
    ])
      expect(() => composeRuntimeAuthProviders([entry])).toThrow(message);
    expect(() => composeRuntimeAuthProviders(KEYS_RUNTIME_PROVIDER)).toThrow('must be a list');
  });
});

describe('runtime capability contributions', () => {
  it('calls a provider hook only when this invocation adapted its material', async () => {
    const hook = vi.fn(FAKE_RUNTIME_PROVIDER.capabilities);
    const { capabilityContributions } = composeRuntimeAuthProviders([
      KEYS_RUNTIME_PROVIDER,
      { ...FAKE_RUNTIME_PROVIDER, capabilities: hook },
    ]);
    const env = { [FAKE_CONTROLLED_ENV]: 'eu-west-1' };
    expect(await capabilityContributions({ env, materialTypes: ['api-key'] })).toEqual({});
    expect(await capabilityContributions({ env })).toEqual({});
    expect(hook).not.toHaveBeenCalled();
    expect(
      await capabilityContributions({ env, materialTypes: ['api-key', FAKE_MATERIAL_TYPE] }),
    ).toEqual({ testModels: ['eu-west-1.test-model'] });
    expect(hook).toHaveBeenCalledExactlyOnceWith({ env });
  });

  it('drops reserved fields and isolates a failing hook', async () => {
    const reserved = {
      ok: false,
      clis: [],
      kiroModels: null,
      agentAuthProtocol: 1,
      agentAuthModes: ['forged'],
      agentAuthVerification: ['forged'],
      invocationAccounting: false,
      command: 'forged',
      at: 'forged',
    };
    const { capabilityContributions } = composeRuntimeAuthProviders([
      provider({ capabilities: async () => ({ ...reserved, fixtureModels: ['m'] }) }),
      provider({
        id: 'sync-throw',
        modes: ['test-connection-mode'],
        materials: { 'sync-token': () => ({}) },
        capabilities: () => {
          throw new Error('provider secret text');
        },
      }),
    ]);
    expect(
      await capabilityContributions({ env: {}, materialTypes: ['fixture-token', 'sync-token'] }),
    ).toEqual({ fixtureModels: ['m'] });
    const rejecting = composeRuntimeAuthProviders([
      provider({ capabilities: async () => Promise.reject(new Error('unavailable')) }),
    ]);
    expect(
      await rejecting.capabilityContributions({ env: {}, materialTypes: ['fixture-token'] }),
    ).toEqual({});
  });

  it('keeps the foundation capability fields when a contribution tries to replace them', async () => {
    const composed = composeRuntimeAuthProviders([
      KEYS_RUNTIME_PROVIDER,
      provider({
        id: 'hostile',
        modes: ['test-connection-mode'],
        capabilities: async () => ({ agentAuthModes: ['forged'], clis: [], fixtureModels: [] }),
      }),
    ]);
    const body = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude'],
        env: {},
        authenticatedProviders: ['bedrock'],
        materialTypes: ['fixture-token'],
        agentAuthModes: composed.modes,
        capabilityContributions: composed.capabilityContributions,
      },
    );
    expect(body.agentAuthModes).toEqual(['keys', 'test-connection-mode']);
    expect(body.clis.find(({ cli }) => cli === 'claude')).toMatchObject({ available: true });
    expect(body.fixtureModels).toEqual([]);
  });
});

describe('a registered runtime provider through the host views', () => {
  it('strips every controlled env name from ambient env and reserves it from MCP refs', async () => {
    expect(CREDENTIAL_ADAPTER_ENV_NAMES).toContain(FAKE_CONTROLLED_ENV);
    for (const name of CREDENTIAL_ADAPTER_ENV_NAMES) {
      const auth = await resolveInvocationAgentAuth({
        authMode: 'capabilities',
        payload: {},
        env: { PATH: '/usr/bin', [name]: 'ambient' },
      });
      expect(auth.env).toEqual({ PATH: '/usr/bin' });
      expect(RESERVED_MCP_ENV_KEYS.has(name)).toBe(true);
      await expect(
        resolveMcpSecrets({
          survivingProject: { p: { command: 'npx', env: { X: `\${${name}}` } } },
          globalPath: (v) => `/g/${v}`,
          projectPath: (v) => `/p/${v}`,
          getParam: async () => 'value',
        }),
      ).rejects.toThrow(/reserved/);
    }
  });

  it('blanks every controlled env name in custom stdio MCP servers and keeps it reserved', () => {
    expect(CREDENTIAL_ADAPTER_ENV_NAMES).toContain(FAKE_TOKEN_ENV);
    const hostile = Object.fromEntries(CREDENTIAL_ADAPTER_ENV_NAMES.map((name) => [name, 'kept']));
    const customServers = { hostile: { command: 'node', args: ['hostile.js'], env: hostile } };
    const scope = { executionId: 'e', intentId: 'i' };
    const claude = buildMcpConfig({ mcpEntry: 'x', scope, customServers }).mcpServers.hostile.env;
    const opencode = buildOpenCodeConfig({ mcpEntry: 'x', scope, customServers }).mcp.hostile
      .environment;
    for (const name of CREDENTIAL_ADAPTER_ENV_NAMES) {
      expect(claude[name], name).toBe('');
      expect(opencode[name], name).toBe('');
    }
    for (const [name, value] of Object.entries(CUSTOM_MCP_AUTH_ENV_SCRUB))
      if (value === '') expect(RESERVED_MCP_ENV_KEYS.has(name), name).toBe(true);
  });

  it('drops controlled env names from the runtime MCP bridge but keeps its trusted scope', async () => {
    let serverEnv;
    const spawnFn = vi.fn((_command, _args, { env }) => {
      serverEnv = env;
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: () => {},
      });
    });
    const bridge = await createRuntimeMcpBridge({
      entry: 'server.js',
      runtimeEnv: { PATH: '/usr/bin', [FAKE_TOKEN_ENV]: 'ambient', [FAKE_CONTROLLED_ENV]: 'x' },
      trustedEnv: { V2_EXECUTION_ID: 'e1', [FAKE_CONTROLLED_ENV]: 'trusted' },
      spawnFn,
    });
    try {
      await new Promise((resolve, reject) => {
        const socket = connect(bridge.socketPath, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
      });
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
      expect(serverEnv).toEqual({
        PATH: '/usr/bin',
        V2_EXECUTION_ID: 'e1',
        [FAKE_CONTROLLED_ENV]: 'trusted',
      });
    } finally {
      await bridge.dispose();
    }
  });

  it('authenticates the CLI and contributes capabilities from an adapted lease', async () => {
    expect(CREDENTIAL_MATERIAL_ADAPTERS[FAKE_MATERIAL_TYPE]).toBe(
      FAKE_RUNTIME_PROVIDER.materials[FAKE_MATERIAL_TYPE],
    );
    const auth = await capabilitiesProbe(
      [
        { binding: FAKE_BINDING, lease: fakeLease() },
        { binding: kiro, value: 'kiro-key', lease: apiKeyLease('kiro-key') },
      ],
      { [FAKE_CONTROLLED_ENV]: 'ambient', AWS_BEARER_TOKEN_BEDROCK: 'ambient' },
    );
    expect(auth.materialTypes).toEqual([FAKE_MATERIAL_TYPE, 'api-key']);
    expect(auth.resolvedProviders).toEqual(['bedrock', 'kiro']);
    expect(auth.env).toEqual({ [FAKE_CONTROLLED_ENV]: 'eu-west-1', KIRO_API_KEY: 'kiro-key' });
    expect(auth.credentialEnvironment).toEqual({ [FAKE_TOKEN_ENV]: 'scoped-token' });
    // No key env var exists for the bedrock slot, yet claude is authenticated.
    expect(
      authenticatedClis({ installed: ['claude', 'kiro'], providers: auth.resolvedProviders }),
    ).toEqual(['claude', 'kiro']);
    const body = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude'],
        env: auth.env,
        authenticatedProviders: auth.resolvedProviders,
        materialTypes: auth.materialTypes,
      },
    );
    expect(body.testModels).toEqual(['eu-west-1.test-model']);
    expect(body.agentAuthModes).toEqual([...RUNTIME_AGENT_AUTH_MODES]);
    expect(body.agentAuthModes).toEqual(expect.arrayContaining(['keys', 'test-connection-mode']));
    expect(body.clis.find(({ cli }) => cli === 'claude')).toMatchObject({ available: true });
  });

  it('adds no contribution to a keys-only invocation', async () => {
    const auth = await capabilitiesProbe([
      { binding: kiro, value: 'kiro-key', lease: apiKeyLease('kiro-key') },
    ]);
    expect(auth.materialTypes).toEqual(['api-key']);
    const body = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro'],
        captureChild: async () => ({ stdout: '' }),
        env: auth.env,
        authenticatedProviders: auth.resolvedProviders,
        materialTypes: auth.materialTypes,
      },
    );
    expect(body).not.toHaveProperty('testModels');
    expect(body.clis.find(({ cli }) => cli === 'claude')).toMatchObject({ authed: false });
  });
});
