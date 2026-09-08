import { describe, it, expect, vi } from 'vitest';
import { capabilities } from '../commands/capabilities.js';
import { parseKiroModels } from '../cli/drivers.js';

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
  it('marks a CLI available only when installed AND its provider binding resolved', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro', 'opencode'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        env: { KIRO_API_KEY: 'k' },
        resolvedProviders: ['kiro'], // bedrock binding unresolved
      },
    );
    expect(res.ok).toBe(true);
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.claude).toMatchObject({ installed: true, authed: false, available: false });
    expect(byCli.kiro).toMatchObject({ installed: true, authed: true, available: true });
    expect(byCli.opencode).toMatchObject({ installed: true, authed: false, available: false });
    expect(res.kiroModels.models.map((m) => m.id)).toContain('claude-sonnet-4.6');
  });

  it('uses the same Bedrock binding for Claude, OpenCode and Codex auth', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['opencode', 'codex'],
        env: { AWS_BEARER_TOKEN_BEDROCK: 'token' },
        resolvedProviders: ['bedrock'],
      },
    );
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.opencode).toMatchObject({ installed: true, authed: true, available: true });
    expect(byCli.codex).toMatchObject({ installed: true, authed: true, available: true });
  });

  // req-capabilities-authed: the whole point of the Phase 0 fix. A role binding
  // deliberately sets no AWS_BEARER_TOKEN_BEDROCK, so an env-var probe reported
  // the three Bedrock CLIs unavailable — exactly the set role mode enables.
  it('reports the three Bedrock CLIs available on the role path, with no bearer token in env', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'opencode', 'codex', 'kiro'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        // Role mode: temporary STS credentials, no bearer token anywhere.
        env: {
          AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE',
          AWS_SECRET_ACCESS_KEY: 'secret',
          AWS_SESSION_TOKEN: 'session',
        },
        resolvedProviders: ['bedrock'],
      },
    );
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.claude).toMatchObject({ authed: true, available: true });
    expect(byCli.opencode).toMatchObject({ authed: true, available: true });
    expect(byCli.codex).toMatchObject({ authed: true, available: true });
    // Kiro is unaffected: its own provider did not resolve, so it stays down
    // even though it is installed.
    expect(byCli.kiro).toMatchObject({ installed: true, authed: false, available: false });
  });

  it('fails closed when no resolved providers are supplied', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude', 'kiro', 'opencode', 'codex'],
        captureChild: async () => ({ stdout: KIRO_LIST_JSON }),
        // A stale bearer token left in the environment must not authorize anything.
        env: { AWS_BEARER_TOKEN_BEDROCK: 'stale', KIRO_API_KEY: 'stale' },
      },
    );
    expect(res.clis.every((c) => c.installed && !c.authed && !c.available)).toBe(true);
  });

  it('does not probe kiro models when kiro is not installed', async () => {
    const capture = vi.fn(async () => ({ stdout: '' }));
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['claude'],
        captureChild: capture,
        env: {},
        resolvedProviders: ['bedrock'],
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
        resolvedProviders: ['bedrock', 'kiro'],
      },
    );
    expect(res.ok).toBe(true);
    expect(res.clis.every((c) => !c.installed && !c.available)).toBe(true);
  });
});
