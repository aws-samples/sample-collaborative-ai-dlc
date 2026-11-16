// Bedrock gateway (BEDROCK_GATEWAY_URL): a Bedrock API key becomes a gateway key, which the
// broker leases as gateway-key material. These tests follow one key from the broker response
// through lease preparation to each CLI's child environment, because the contract is about
// where that key can and cannot end up.
import { describe, it, expect, vi } from 'vitest';
import { authenticatedClis, resolveInvocationAgentAuth } from '../auth-resolver.js';
import { AGENT_AUTH_MODES } from '../command-registry.js';
import { capabilities } from '../commands/capabilities.js';
import { claudeDriver, codexDriver, kiroDriver, opencodeDriver } from '../cli/drivers.js';
import { RESERVED_MCP_ENV_KEYS } from '../mcp-secret-resolver.js';
import { CUSTOM_MCP_AUTH_ENV_SCRUB } from '../stage-materializer.js';
import { apiKeyLease, bedrockGatewayKeyLease } from '../../shared/agent-credential-lease.js';

const GATEWAY = 'https://gateway.example.com';
const KEY = 'gateway-test-key';
const installed = ['claude', 'kiro', 'opencode', 'codex'];
const bedrock = { provider: 'bedrock', source: 'platform' };
const kiro = { provider: 'kiro', source: 'space' };
const keyed = (binding, value) => ({ binding, value, lease: apiKeyLease(value) });
// What the broker sends for a Bedrock key in a deployment with a gateway: no `value`.
const gatewayKeyed = (value, endpoint = GATEWAY) => ({
  binding: bedrock,
  lease: bedrockGatewayKeyLease(apiKeyLease(value), endpoint),
});
// The broker of a deployment with a gateway, and of one without.
const brokerCredentials = (env) => [
  env.BEDROCK_GATEWAY_URL ? gatewayKeyed(KEY) : keyed(bedrock, KEY),
  keyed(kiro, 'ksk_kiro'),
];
const exported = (auth) => Object.values(auth.env);

// The capabilities probe resolves both providers, like the control plane does.
const prepare = (env, credentials = brokerCredentials(env), leaseAdapters = undefined) =>
  resolveInvocationAgentAuth({
    authMode: AGENT_AUTH_MODES.CAPABILITIES,
    payload: {
      projectId: 'p-1',
      credentialBindings: Object.fromEntries(
        credentials.map(({ binding }) => [binding.provider, binding]),
      ),
      agentCredentialGrant: 'grant',
    },
    env,
    broker: async () => ({
      purpose: 'capabilities',
      projectId: 'p-1',
      executionId: null,
      credentials,
    }),
    ...(leaseAdapters ? { leaseAdapters } : {}),
  });

describe('Bedrock gateway key delivery', () => {
  it('delivers a Bedrock key as the gateway token and never under the AWS name', async () => {
    const auth = await prepare({ BEDROCK_GATEWAY_URL: GATEWAY });

    expect(auth.env.AIDLC_BEDROCK_GATEWAY_TOKEN).toBe(KEY);
    expect(auth.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(auth.env.KIRO_API_KEY).toBe('ksk_kiro');
    expect(auth.resolvedProviders).toEqual(['bedrock', 'kiro']);
  });

  it('keeps delivering the key under the AWS name without a gateway', async () => {
    const auth = await prepare({ AWS_REGION: 'eu-central-1' });

    expect(auth.env.AWS_BEARER_TOKEN_BEDROCK).toBe(KEY);
    expect(auth.env.AIDLC_BEDROCK_GATEWAY_TOKEN).toBeUndefined();
    expect(
      authenticatedClis({ installed, providers: auth.resolvedProviders, env: auth.env }),
    ).toEqual(installed);
  });

  it('refuses an invalid gateway URL instead of sending the key to AWS', async () => {
    for (const credentials of [[keyed(bedrock, KEY)], [gatewayKeyed(KEY)]])
      await expect(
        prepare({ BEDROCK_GATEWAY_URL: 'http://gateway.example.com' }, credentials),
      ).rejects.toMatchObject({ code: 'AGENT_AUTH_INVALID' });
  });

  it('ignores an ambient gateway token: only a lease supplies one', async () => {
    const auth = await prepare(
      { BEDROCK_GATEWAY_URL: GATEWAY, AIDLC_BEDROCK_GATEWAY_TOKEN: 'ambient' },
      [keyed(kiro, 'ksk_kiro')],
    );

    expect(auth.env.AIDLC_BEDROCK_GATEWAY_TOKEN).toBeUndefined();
    expect(claudeDriver.envForAuth(auth.env).ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
  });

  it('keeps the gateway token out of custom MCP servers and MCP secret references', () => {
    for (const name of ['AIDLC_BEDROCK_GATEWAY_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(CUSTOM_MCP_AUTH_ENV_SCRUB[name], name).toBe('');
      expect(RESERVED_MCP_ENV_KEYS.has(name), name).toBe(true);
    }
  });

  it('reserves every name the Claude driver sets for a gateway run from MCP secret references', async () => {
    // A custom MCP secret is injected into the same child environment. One named like a
    // routing variable could otherwise send the key to another endpoint.
    const { env } = await prepare({
      BEDROCK_GATEWAY_URL: GATEWAY,
      BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD: 'true',
      AIDLC_MODEL_ALIASES: '{"opus":"a.opus","sonnet":"a.sonnet","haiku":"a.haiku"}',
    });

    const names = Object.keys(claudeDriver.envForAuth(env));

    expect(names).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_BEDROCK_BASE_URL',
        'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
        'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ]),
    );
    for (const name of names) expect(RESERVED_MCP_ENV_KEYS.has(name), name).toBe(true);
  });
});

// The broker decides what a Bedrock key is for, and a runtime whose code or configuration is
// from before a gateway change must refuse the key rather than send it where it used to go.
describe('Bedrock gateway and runtimes from before a gateway change', () => {
  it('a runtime that predates the gateway refuses gateway-key material', async () => {
    // The released Keys adapter: every API key goes into the provider's env name.
    const released = {
      'api-key': ({ material }) => ({ env: { AWS_BEARER_TOKEN_BEDROCK: material.value } }),
    };

    await expect(
      prepare({ AWS_REGION: 'eu-central-1' }, [gatewayKeyed(KEY)], released),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
  });

  it('refuses a gateway key on a runtime without the gateway setting', async () => {
    await expect(
      prepare({ AWS_REGION: 'eu-central-1' }, [gatewayKeyed(KEY)]),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
  });

  it('refuses a gateway key on a runtime configured for another gateway', async () => {
    await expect(
      prepare({ BEDROCK_GATEWAY_URL: 'https://former.example.com' }, [gatewayKeyed(KEY)]),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
  });

  it('refuses an Amazon Bedrock API key on a runtime still configured for a gateway', async () => {
    // The gateway was removed from the deployment; this runtime would send the key to it.
    await expect(
      prepare({ BEDROCK_GATEWAY_URL: GATEWAY }, [keyed(bedrock, KEY)]),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
  });

  it('accepts the gateway key when the lease and the runtime name the same gateway', async () => {
    // Both sides normalize the URL, so a trailing slash in the setting does not matter.
    const auth = await prepare({ BEDROCK_GATEWAY_URL: `${GATEWAY}/` });

    expect(exported(auth).filter((value) => value === KEY)).toHaveLength(1);
    expect(auth.env.AIDLC_BEDROCK_GATEWAY_TOKEN).toBe(KEY);
  });

  it('keeps a Kiro key out of the gateway rules', async () => {
    const auth = await prepare({ BEDROCK_GATEWAY_URL: GATEWAY }, [keyed(kiro, 'ksk_kiro')]);

    expect(auth.env.KIRO_API_KEY).toBe('ksk_kiro');
  });

  it('refuses gateway-key material bound to another provider', async () => {
    await expect(
      prepare({ BEDROCK_GATEWAY_URL: GATEWAY }, [
        { binding: kiro, lease: bedrockGatewayKeyLease(apiKeyLease(KEY), GATEWAY) },
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_LEASE_INVALID' });
  });
});

describe('Bedrock gateway CLI environments', () => {
  it('points Claude Code at the gateway with the key as its bearer token', async () => {
    const { env } = await prepare({
      BEDROCK_GATEWAY_URL: `${GATEWAY}/`,
      BEDROCK_REGION: 'eu-central-1',
    });

    const child = claudeDriver.envForAuth(env);

    expect(child).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'eu-central-1',
      ANTHROPIC_BEDROCK_BASE_URL: GATEWAY,
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      ANTHROPIC_AUTH_TOKEN: KEY,
    });
    // Claude Code prefers the AWS name when both are set and would call AWS with it.
    expect(child.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(child.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD).toBeUndefined();
  });

  it('turns off the stream content-type check only when the deployment asks for it', async () => {
    const { env } = await prepare({
      BEDROCK_GATEWAY_URL: GATEWAY,
      BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD: 'true',
    });
    expect(claudeDriver.envForAuth(env).CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD).toBe('1');

    // The switch belongs to the gateway; direct Bedrock keeps the check.
    const direct = await prepare({ BEDROCK_GATEWAY_DISABLE_CONTENT_TYPE_GUARD: 'true' });
    expect(
      claudeDriver.envForAuth(direct.env).CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD,
    ).toBeUndefined();
  });

  it('never hands the gateway key to OpenCode, Codex or Kiro', async () => {
    const { env } = await prepare({ BEDROCK_GATEWAY_URL: GATEWAY });

    for (const driver of [opencodeDriver, codexDriver, kiroDriver])
      expect(Object.values(driver.envForAuth(env)), driver.name).not.toContain(KEY);
  });

  it('leaves an invocation without an API key on AWS, gateway configured or not', () => {
    // IAM mode prepares session credentials and no key, so no gateway token exists.
    const child = claudeDriver.envForAuth({
      BEDROCK_GATEWAY_URL: GATEWAY,
      BEDROCK_REGION: 'eu-central-1',
    });

    expect(child.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(child.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
    expect(child.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe('Bedrock gateway CLI availability', () => {
  it('authenticates only the CLIs that can reach the gateway', async () => {
    const auth = await prepare({ BEDROCK_GATEWAY_URL: GATEWAY });

    expect(
      authenticatedClis({ installed, providers: auth.resolvedProviders, env: auth.env }),
    ).toEqual(['claude', 'kiro']);
  });

  it('reports OpenCode and Codex unavailable with the reason, and looks up no Codex models', async () => {
    const auth = await prepare({ BEDROCK_GATEWAY_URL: GATEWAY, BEDROCK_REGION: 'eu-central-1' });
    // The Codex catalogue lookup would present the key to bedrock-mantle.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    try {
      const result = await capabilities(
        {},
        {
          discoverInstalledClis: async () => installed,
          captureChild: async () => ({ stdout: '{"models":[]}' }),
          env: auth.env,
          authenticatedProviders: auth.resolvedProviders,
          materialTypes: auth.materialTypes,
        },
      );

      const byCli = Object.fromEntries(result.clis.map((cli) => [cli.cli, cli]));
      expect(byCli.claude).toEqual({
        cli: 'claude',
        installed: true,
        authed: true,
        available: true,
      });
      expect(byCli.kiro.available).toBe(true);
      for (const cli of ['opencode', 'codex'])
        expect(byCli[cli]).toEqual({
          cli,
          installed: true,
          authed: true,
          available: false,
          unavailableReason: 'bedrock-gateway',
        });
      expect(result.codexModels).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps every Bedrock CLI available when no gateway is configured', async () => {
    const auth = await prepare({ AWS_REGION: 'eu-central-1' }, [keyed(bedrock, KEY)]);

    const result = await capabilities(
      {},
      {
        discoverInstalledClis: async () => installed,
        captureChild: async () => ({ stdout: '{"models":[]}' }),
        env: auth.env,
        authenticatedProviders: auth.resolvedProviders,
        capabilityContributions: async () => ({}),
      },
    );

    expect(result.clis.filter((cli) => cli.available).map((cli) => cli.cli)).toEqual([
      'claude',
      'opencode',
      'codex',
    ]);
    expect(result.clis.some((cli) => 'unavailableReason' in cli)).toBe(false);
  });
});
