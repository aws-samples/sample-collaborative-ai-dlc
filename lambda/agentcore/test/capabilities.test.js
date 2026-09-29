import { describe, it, expect, vi } from 'vitest';
import { capabilities } from '../commands/capabilities.js';
import { parseKiroModels } from '../cli/drivers.js';
import {
  RUNTIME_AGENT_AUTH_MODES,
  composeRuntimeAuthProviders,
} from '../credential-material-registry.js';
import { KEYS_RUNTIME_PROVIDER } from '../keys-runtime-provider.js';
import { AGENT_AUTH_MODES_CATALOG } from '../../shared/agent-auth-providers.js';

// A trimmed real `kiro-cli chat --list-models --format json` payload.
const KIRO_LIST_JSON = JSON.stringify({
  models: [
    { model_name: 'auto', model_id: 'auto', description: 'Auto mode' },
    {
      model_name: 'claude-sonnet-4.6',
      model_id: 'claude-sonnet-4.6',
      description: 'Latest Sonnet',
    },
  ],
  default_model: 'auto',
});

describe('parseKiroModels', () => {
  it('maps the kiro list payload to {id,name,description} + default', () => {
    expect(parseKiroModels(KIRO_LIST_JSON)).toEqual({
      models: [
        { id: 'auto', name: 'auto', description: 'Auto mode' },
        { id: 'claude-sonnet-4.6', name: 'claude-sonnet-4.6', description: 'Latest Sonnet' },
      ],
      default: 'auto',
    });
  });
  it('returns an empty list for unparseable stdout', () => {
    expect(parseKiroModels('not json')).toEqual({ models: [], default: null });
  });
});

describe('capabilities command', () => {
  it('marks a CLI available only when installed AND authed', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro', 'opencode'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        env: { KIRO_API_KEY: 'k' }, // claude has NO bearer token → not authed
      },
    );
    expect(res.ok).toBe(true);
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.claude).toMatchObject({ installed: true, authed: false, available: false });
    expect(byCli.kiro).toMatchObject({ installed: true, authed: true, available: true });
    expect(byCli.opencode).toMatchObject({ installed: true, authed: false, available: false });
    expect(res.kiroModels.models.map((m) => m.id)).toContain('claude-sonnet-4.6');
  });

  it('uses the same Bedrock bearer token as Claude for OpenCode and Codex auth', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['opencode', 'codex'],
        env: { AWS_BEARER_TOKEN_BEDROCK: 'token' },
      },
    );
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.opencode).toMatchObject({ installed: true, authed: true, available: true });
    expect(byCli.codex).toMatchObject({ installed: true, authed: true, available: true });
  });

  it('does not probe kiro models when kiro is not installed', async () => {
    const capture = vi.fn(async () => ({ stdout: '' }));
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude'],
        captureChild: capture,
        env: { AWS_BEARER_TOKEN_BEDROCK: 't' },
      },
    );
    expect(capture).not.toHaveBeenCalled();
    expect(res.kiroModels).toEqual({ models: [], default: null });
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.claude).toMatchObject({ available: true });
    expect(byCli.kiro).toMatchObject({ installed: false, available: false });
  });

  it('degrades to no CLIs when discovery throws', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => {
          throw new Error('probe failed');
        },
        env: {},
      },
    );
    expect(res.ok).toBe(true);
    expect(res.clis.every((c) => !c.installed && !c.available)).toBe(true);
  });
});

describe('capabilities authentication and advertisement', () => {
  const byCli = (res) => Object.fromEntries(res.clis.map((c) => [c.cli, c]));
  const ambient = {
    AWS_BEARER_TOKEN_BEDROCK: 'ambient',
    KIRO_API_KEY: 'ambient',
    BEDROCK_AUTH_MODE: 'iam',
  };

  it('authenticates CLIs from the invocation providers, not from env', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro', 'opencode', 'codex'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        env: ambient,
        authenticatedProviders: ['kiro'],
      },
    );
    expect(byCli(res).kiro).toMatchObject({ authed: true, available: true });
    for (const cli of ['claude', 'opencode', 'codex'])
      expect(byCli(res)[cli]).toMatchObject({ installed: true, authed: false, available: false });
  });

  it('never falls back to env when the invocation resolved no provider', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro'],
        captureChild: async () => ({ stdout: '' }),
        env: ambient,
        authenticatedProviders: [],
      },
    );
    expect(res.clis.every((c) => !c.authed && !c.available)).toBe(true);
  });

  it('keeps the keys-only body byte-for-byte', async () => {
    const keysOnly = composeRuntimeAuthProviders([KEYS_RUNTIME_PROVIDER]);
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        env: { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key', KIRO_API_KEY: 'kiro-key' },
        authenticatedProviders: ['bedrock', 'kiro'],
        materialTypes: ['api-key'],
        agentAuthModes: keysOnly.modes,
        capabilityContributions: keysOnly.capabilityContributions,
      },
    );
    // The body a keys-only image published before runtime providers were composed.
    expect(JSON.stringify(res)).toBe(
      JSON.stringify({
        ok: true,
        clis: [
          { cli: 'claude', installed: true, authed: true, available: true },
          { cli: 'kiro', installed: true, authed: true, available: true },
          { cli: 'opencode', installed: false, authed: true, available: false },
          { cli: 'codex', installed: false, authed: true, available: false },
        ],
        kiroModels: parseKiroModels(KIRO_LIST_JSON),
        agentAuthProtocol: 2,
        agentAuthModes: ['keys'],
        invocationAccounting: true,
      }),
    );
  });

  it('advertises the composed runtime modes, keys included', async () => {
    const res = await capabilities({}, { discoverInstalledClis: async () => [], env: {} });
    expect(res.agentAuthModes).toEqual([...RUNTIME_AGENT_AUTH_MODES]);
    expect(res.agentAuthModes).toContain('keys');
  });

  it('advertises exactly the available shared modes (registration invariant)', () => {
    const available = AGENT_AUTH_MODES_CATALOG.filter((mode) => mode.available).map(({ id }) => id);
    expect(RUNTIME_AGENT_AUTH_MODES.filter((mode) => !available.includes(mode))).toEqual([]);
    expect(available.filter((mode) => !RUNTIME_AGENT_AUTH_MODES.includes(mode))).toEqual([]);
  });
});
