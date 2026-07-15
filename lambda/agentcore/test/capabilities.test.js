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

  it('uses the same Bedrock bearer token as Claude for OpenCode auth', async () => {
    const res = await capabilities(
      {},
      {
        discoverInstalledClis: async () => ['opencode'],
        env: { AWS_BEARER_TOKEN_BEDROCK: 'token' },
      },
    );
    const byCli = Object.fromEntries(res.clis.map((c) => [c.cli, c]));
    expect(byCli.opencode).toMatchObject({ installed: true, authed: true, available: true });
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
