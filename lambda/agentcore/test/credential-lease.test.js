import { describe, expect, it, vi } from 'vitest';
import { normalizeCredentialLease } from '../../shared/agent-credential-lease.js';
import { prepareCredentialLeases } from '../credential-lease-adapters.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';

const binding = { provider: 'bedrock', source: 'platform' };
const lease = (material, extras = {}) =>
  normalizeCredentialLease({ version: 1, material, ...extras });
describe('provider-neutral credential leases', () => {
  it('accepts a registered material adapter without changing grant matching or invocation ownership', async () => {
    const adapter = vi.fn(({ material }) => ({ env: { TEST_INFERENCE_TOKEN: material.token } }));
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
    expect(result.env.TEST_INFERENCE_TOKEN).toBe('scoped');
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
    const state = prepareCredentialLeases({
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
    const state = prepareCredentialLeases({
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

  it('rejects expired leases, unsupported material, and unbounded renewal', () => {
    const prepare = (value) =>
      prepareCredentialLeases({ credentials: [{ binding, lease: value }], baseEnv: {} });
    expect(() => prepare(lease({ type: 'api-key', value: 'key' }, { expiresAt: 1 }))).toThrow(
      'expired',
    );
    expect(() => prepare(lease({ type: 'unsupported' }))).toThrow('unsupported');
    expect(() => lease({ type: 'api-key', value: 'key' }, { renewal: { grant: 'token' } })).toThrow(
      'invalid',
    );
  });
});
