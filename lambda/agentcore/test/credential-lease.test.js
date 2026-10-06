import { describe, expect, it, vi } from 'vitest';
import { normalizeCredentialLease } from '../../shared/agent-credential-lease.js';
import {
  credentialLeaseFromResponse,
  prepareCredentialLeases,
} from '../credential-lease-adapters.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';

const binding = { provider: 'bedrock', source: 'platform' };
const lease = (material, extras = {}) =>
  normalizeCredentialLease({ version: 1, material, ...extras });
describe('provider-neutral credential leases', () => {
  it('accepts a registered material adapter without changing grant matching or invocation ownership', async () => {
    const adapter = vi.fn(({ material }) => ({ env: { AIDLC_GATEWAY_TOKEN: material.token } }));
    const result = await resolveInvocationAgentAuth({
      payload: {
        requestedCli: 'claude',
        credentialBinding: binding,
        agentCredentialGrant: 'grant',
      },
      authMode: 'compose',
      env: { PATH: '/usr/bin', AWS_BEARER_TOKEN_BEDROCK: 'ambient' },
      broker: async () => ({
        purpose: 'compose',
        projectId: null,
        executionId: null,
        credentials: [
          {
            binding,
            lease: lease(
              { type: 'test-provider', token: 'scoped' },
              { expiresAt: Date.now() + 120000 },
            ),
          },
        ],
      }),
      leaseAdapters: { 'test-provider': adapter },
    });
    expect(result.env.AIDLC_GATEWAY_TOKEN).toBe('scoped');
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(result.resolvedProviders).toEqual(['bedrock']);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('renews through the broker and preserves the original authorization deadline', async () => {
    const now = Date.now();
    const ceiling = now + 300000;
    const broker = vi.fn(async () => ({
      purpose: 'execution',
      projectId: 'p1',
      executionId: 'e1',
      credentials: [
        {
          binding,
          lease: lease(
            { type: 'api-key', value: 'second' },
            {
              expiresAt: now + 180000,
              authorizationExpiresAt: ceiling + 300000,
              renewal: { grant: 'next' },
            },
          ),
        },
      ],
    }));
    const state = await prepareCredentialLeases({
      credentials: [
        {
          binding,
          lease: lease(
            { type: 'api-key', value: 'first' },
            {
              expiresAt: now + 120000,
              authorizationExpiresAt: ceiling,
              renewal: { grant: 'renew' },
            },
          ),
        },
      ],
      baseEnv: {},
      broker,
      context: { purpose: 'execution', projectId: 'p1', executionId: 'e1' },
    });
    const refreshed = await state.refresh();
    expect(broker).toHaveBeenCalledWith({ action: 'resolve-agent-credentials', grant: 'renew' });
    expect(refreshed.env.AWS_BEARER_TOKEN_BEDROCK).toBe('second');
    expect(refreshed.authorizationExpiresAt).toBe(ceiling);
  });

  it('rejects a renewal for a different execution or identity', async () => {
    const now = Date.now();
    const state = await prepareCredentialLeases({
      credentials: [
        {
          binding,
          lease: lease(
            { type: 'api-key', value: 'first' },
            {
              expiresAt: now + 120000,
              authorizationExpiresAt: now + 300000,
              renewal: { grant: 'renew' },
            },
          ),
        },
      ],
      baseEnv: {},
      context: { purpose: 'execution', projectId: 'p1', executionId: 'e1' },
      broker: async () => ({
        purpose: 'execution',
        projectId: 'p1',
        executionId: 'other',
        credentials: [],
      }),
    });
    await expect(state.refresh()).rejects.toMatchObject({ code: 'AGENT_AUTH_LEASE_INVALID' });
  });

  it('rejects expired leases, unsupported material, and unbounded renewal', async () => {
    const prepare = (value) =>
      prepareCredentialLeases({ credentials: [{ binding, lease: value }], baseEnv: {} });
    await expect(
      prepare(lease({ type: 'api-key', value: 'key' }, { expiresAt: 1 })),
    ).rejects.toThrow('expired');
    await expect(prepare(lease({ type: 'unsupported' }))).rejects.toThrow('unsupported');
    expect(() => lease({ type: 'api-key', value: 'key' }, { renewal: { grant: 'token' } })).toThrow(
      'invalid',
    );
  });
});

describe('runtime lease reading and preparation', () => {
  it('reads the lease first and the published key `value` last', () => {
    const material = { type: 'test-provider', token: 'scoped' };
    expect(credentialLeaseFromResponse({ lease: lease(material), value: 'stale-key' })).toEqual(
      lease(material),
    );
    expect(credentialLeaseFromResponse({ value: 'key' }).material).toEqual({
      type: 'api-key',
      value: 'key',
    });
    for (const value of [null, '', undefined, { value: 'key' }])
      expect(credentialLeaseFromResponse({ value }).material).toBeNull();
  });

  it('reports each adapted material type once and skips empty leases', async () => {
    const kiro = { provider: 'kiro', source: 'platform' };
    const state = await prepareCredentialLeases({
      credentials: [
        { binding, lease: lease({ type: 'api-key', value: 'bedrock-key' }) },
        { binding: kiro, lease: lease({ type: 'api-key', value: 'kiro-key' }) },
        { binding: { ...kiro, source: 'space' }, lease: lease(null) },
      ],
      baseEnv: {},
    });
    expect(state.materialTypes).toEqual(['api-key']);
    const empty = await prepareCredentialLeases({
      credentials: [{ binding, lease: lease(null) }],
      baseEnv: {},
    });
    expect(empty.materialTypes).toEqual([]);
  });

  it('accepts only credential names or env its provider controls from an adapter', async () => {
    const prepare = (prepared, controlledEnv = { 'test-a': ['TEST_A_REGION'] }) =>
      prepareCredentialLeases({
        credentials: [{ binding, lease: lease({ type: 'test-a' }) }],
        baseEnv: { PATH: '/usr/bin' },
        adapters: { 'test-a': () => prepared },
        controlledEnv,
      });
    const state = await prepare({
      env: { TEST_A_REGION: 'eu-west-1', AIDLC_GATEWAY_TOKEN: 'token' },
      credentialEnvironment: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:1/c' },
    });
    expect(state.env).toEqual({
      PATH: '/usr/bin',
      TEST_A_REGION: 'eu-west-1',
      AIDLC_GATEWAY_TOKEN: 'token',
    });
    for (const prepared of [
      { env: { TEST_A_TOKEN: 'leaked' } },
      { credentialEnvironment: { TEST_A_TOKEN: 'leaked' } },
      { env: { TEST_A_REGION: 'eu-west-1' } },
    ])
      await expect(
        prepare(
          prepared,
          prepared.env?.TEST_A_REGION ? { 'test-b': ['TEST_A_REGION'] } : undefined,
        ),
      ).rejects.toMatchObject({
        code: 'AGENT_AUTH_LEASE_INVALID',
        message: 'Credential adapter wrote an environment variable its provider does not control',
      });
  });

  it('releases a session whose env names are not its provider’s', async () => {
    const release = vi.fn(async () => {});
    const adapter = Object.assign(() => ({ env: { TEST_A_REGION: 'eu-west-1' } }), {
      createSession: async ({ env }) => ({
        env: { ...env, TEST_A_TOKEN: 'leaked' },
        credentialEnvironment: {},
        release,
      }),
    });
    await expect(
      prepareCredentialLeases({
        credentials: [{ binding, lease: lease({ type: 'test-a' }) }],
        baseEnv: { PATH: '/usr/bin' },
        adapters: { 'test-a': adapter },
        controlledEnv: { 'test-a': ['TEST_A_REGION'] },
      }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_LEASE_INVALID' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('allows one session-owning adapter per invocation', async () => {
    const owning = () =>
      Object.assign(() => ({}), { createSession: vi.fn(async ({ env }) => ({ env })) });
    const adapters = { 'test-a': owning(), 'test-b': owning() };
    const kiro = { provider: 'kiro', source: 'platform' };
    await expect(
      prepareCredentialLeases({
        credentials: [
          { binding, lease: lease({ type: 'test-a' }) },
          { binding: kiro, lease: lease({ type: 'test-b' }) },
        ],
        baseEnv: {},
        adapters,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_RUNTIME_UNSUPPORTED' });
    expect(adapters['test-a'].createSession).not.toHaveBeenCalled();
    const state = await prepareCredentialLeases({
      credentials: [{ binding, lease: lease({ type: 'test-a' }) }],
      baseEnv: { PATH: '/usr/bin' },
      adapters,
    });
    expect(adapters['test-a'].createSession).toHaveBeenCalledOnce();
    expect(state.credentialSession).toEqual({ env: { PATH: '/usr/bin' } });
  });
});
