import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { prepareCredentialInvocation } from '../invocation-context.js';
import { createCredentialSession } from '../credential-session.js';
import { currentGatewayGrant, runWithGatewayGrant } from '../mcp/gateway-context.js';
import { dispatchInvocation } from '../http-server.js';
import { apiKeyLease, normalizeCredentialLease } from '../../shared/agent-credential-lease.js';

const start = Date.parse('2026-10-19T12:00:00Z');
const binding = { provider: 'kiro', source: 'space' };
const accounting = { invocationId: 'a'.repeat(64), ticket: 'inert-accounting-ticket' };
let sdk;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  sdk = mockClient(DynamoDBDocumentClient);
  sdk.callsFake(() => {
    throw new Error('Direct DynamoDB tripwire');
  });
});
afterEach(() => {
  expect(sdk.calls()).toHaveLength(0);
  sdk.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const harness = (overrides = {}) => {
  const response = {
    purpose: 'execution',
    projectId: 'p',
    executionId: 'e',
    credentials: [{ binding, lease: apiKeyLease('inert-key') }],
    accounting,
    ...overrides.response,
  };
  const scopes = [];
  const broker = vi.fn(async (request) => {
    scopes.push(currentGatewayGrant());
    return request.action === 'resolve-agent-credentials' ? response : { ok: true };
  });
  const ddb = {
    send: vi.fn(() => {
      throw new Error('Injected DynamoDB tripwire');
    }),
  };
  const store = {
    getExecution: vi.fn(async () => ({
      projectId: 'p',
      agentCli: 'kiro',
      credentialBinding: binding,
    })),
  };
  const options = {
    payload: {
      command: 'run-stage',
      projectId: 'p',
      executionId: 'e',
      requestedCli: 'kiro',
      agentCredentialGrant: 'credential-grant',
      gatewayGrant: 'gateway-grant',
    },
    authMode: 'execution',
    env: { ENGINE_DATA_FUNCTION: 'engine-data', V2_PROCESS_TABLE: 'unused-runtime-table' },
    installedClis: ['kiro'],
    store,
    ddb,
    broker,
    ...overrides.options,
  };
  return {
    response,
    broker,
    ddb,
    store,
    scopes,
    options,
    prepare: () => runWithGatewayGrant('gateway-grant', () => prepareCredentialInvocation(options)),
  };
};
const calls = (h, action) => h.broker.mock.calls.filter(([request]) => request.action === action);

describe('runtime broker invocation lifetime', () => {
  it('waits for an in-flight heartbeat before finishing on final release', async () => {
    const h = harness();
    const heartbeat = Promise.withResolvers();
    h.broker.mockImplementation(async ({ action }) => {
      if (action === 'resolve-agent-credentials') return h.response;
      if (action === 'heartbeat-invocation') return heartbeat.promise;
      return { ok: true };
    });
    const context = await h.prepare();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls(h, 'heartbeat-invocation')).toHaveLength(1);
    const release = context.credentialSession.release();
    await Promise.resolve();
    expect(calls(h, 'finish-invocation')).toHaveLength(0);
    heartbeat.resolve({ ok: true });
    await release;
    expect(calls(h, 'finish-invocation')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains detached work, heartbeats every 30s, then finishes once outside Gateway ALS', async () => {
    const h = harness();
    let releaseJob;
    let context;
    const result = await dispatchInvocation({
      payload: h.options.payload,
      prepareInvocation: (payload, authMode) =>
        prepareCredentialInvocation({ ...h.options, payload, authMode }),
      handlers: {
        runStage: async (payload, prepared) => {
          context = prepared;
          expect(payload).not.toHaveProperty('agentCredentialGrant');
          expect(payload).not.toHaveProperty('gatewayGrant');
          expect(prepared).not.toHaveProperty('accounting');
          releaseJob = prepared.credentialSession.retain();
          return { ok: true };
        },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(context.availableClis).toEqual(['kiro']);
    expect(h.broker.mock.calls[0][0]).toEqual({
      action: 'resolve-agent-credentials',
      grant: 'credential-grant',
      gatewayGrant: 'gateway-grant',
      command: 'run-stage',
      invocationNonce: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(calls(h, 'finish-invocation')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls(h, 'heartbeat-invocation')).toEqual([
      [{ action: 'heartbeat-invocation', ticket: accounting.ticket }],
      [{ action: 'heartbeat-invocation', ticket: accounting.ticket }],
    ]);
    expect(currentGatewayGrant()).toBeNull();
    await releaseJob();
    await releaseJob();
    await context.credentialSession.release();
    expect(calls(h, 'finish-invocation')).toEqual([
      [{ action: 'finish-invocation', ticket: accounting.ticket }],
    ]);
    expect(h.scopes.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls(h, 'heartbeat-invocation')).toHaveLength(2);
    expect(h.ddb.send).not.toHaveBeenCalled();
  });

  it('keeps the original invocation through credential renewals and authorization expiry', async () => {
    const ceiling = start + 300_000;
    const lease = (value, expiresAt, authorizationExpiresAt) =>
      normalizeCredentialLease({
        version: 1,
        material: { type: 'api-key', value },
        expiresAt,
        authorizationExpiresAt,
        renewal: { action: 'renew-test-credentials', grant: 'renewal-grant' },
      });
    const h = harness({
      response: { credentials: [{ binding, lease: lease('first', start + 120_000, ceiling) }] },
    });
    h.broker.mockImplementation(async ({ action }) => {
      if (action === 'resolve-agent-credentials') return h.response;
      if (action === 'renew-test-credentials')
        return {
          ...h.response,
          accounting: undefined,
          credentials: [{ binding, lease: lease('second', start + 240_000, ceiling + 600_000) }],
        };
      return { ok: true };
    });
    const context = await h.prepare();
    await context.credentialSession.renew();
    expect(context.credentialSession.env.KIRO_API_KEY).toBe('second');
    expect(calls(h, 'resolve-agent-credentials')).toHaveLength(1);
    expect(calls(h, 'renew-test-credentials')).toEqual([
      [{ action: 'renew-test-credentials', grant: 'renewal-grant' }],
    ]);
    vi.setSystemTime(ceiling + 1);
    expect(() => context.credentialSession.env).toThrow();
    await context.credentialSession.release();
    expect(calls(h, 'finish-invocation')).toEqual([
      [{ action: 'finish-invocation', ticket: accounting.ticket }],
    ]);
    expect(h.ddb.send).not.toHaveBeenCalled();
  });

  it.each(['scope', 'binding', 'duplicate', 'expired-lease', 'adapter'])(
    'finishes exactly once after %s setup failure',
    async (failure) => {
      const h = harness();
      if (failure === 'scope') h.response.executionId = 'other';
      if (failure === 'binding')
        h.response.credentials[0].binding = { ...binding, source: 'platform' };
      if (failure === 'duplicate') h.response.credentials.push(h.response.credentials[0]);
      if (failure === 'expired-lease')
        h.response.credentials[0].lease = { ...apiKeyLease('inert-key'), expiresAt: start - 1 };
      if (failure === 'adapter')
        h.options.leaseAdapters = {
          'api-key': () => {
            throw new Error('adapter setup failed');
          },
        };
      await expect(h.prepare()).rejects.toThrow();
      expect(calls(h, 'finish-invocation')).toEqual([
        [{ action: 'finish-invocation', ticket: accounting.ticket }],
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls(h, 'heartbeat-invocation')).toHaveLength(0);
      expect(h.ddb.send).not.toHaveBeenCalled();
    },
  );

  it('finishes when an adapter-owned session rejects ownership and disposes its resources', async () => {
    const h = harness();
    const session = createCredentialSession();
    const cleanup = vi.fn();
    session.own(cleanup);
    const own = vi.spyOn(session, 'own').mockImplementation(() => {
      throw new Error('credential expired during setup');
    });
    const adapter = () => ({ env: {} });
    adapter.createSession = async () => session;
    h.options.leaseAdapters = { 'api-key': adapter };
    await expect(h.prepare()).rejects.toThrow('credential expired during setup');
    expect(own).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(calls(h, 'finish-invocation')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['capabilities', 'verify-connection'])(
    'keeps %s grant-only, never reads supplied execution IDs',
    async (purpose) => {
      const h = harness({
        response: { purpose, executionId: null },
        options: { authMode: purpose },
      });
      h.options.payload = {
        ...h.options.payload,
        command: purpose,
        credentialBinding: binding,
        credentialBindings: { kiro: binding },
      };
      const context = await h.prepare();
      expect(h.store.getExecution).not.toHaveBeenCalled();
      expect(h.broker.mock.calls[0][0]).not.toHaveProperty('gatewayGrant');
      await context.credentialSession.release();
      expect(calls(h, 'finish-invocation')).toHaveLength(1);
    },
  );

  it('empty binding probes do no broker or DDB accounting', async () => {
    const h = harness({ options: { authMode: 'capabilities' } });
    h.options.payload = { command: 'capabilities' };
    const context = await h.prepare();
    await context.credentialSession.release();
    expect(h.broker).not.toHaveBeenCalled();
    expect(h.ddb.send).not.toHaveBeenCalled();
  });

  it('fails closed when the broker omits accounting, without a local fallback', async () => {
    const h = harness({ response: { accounting: undefined } });
    await expect(h.prepare()).rejects.toMatchObject({ code: 'INVOCATION_ACCOUNTING_INVALID' });
    expect(h.ddb.send).not.toHaveBeenCalled();
  });

  it('does not infer completion after failed heartbeats, and makes one finish attempt', async () => {
    const h = harness();
    h.broker.mockImplementation(async ({ action }) => {
      if (action === 'resolve-agent-credentials') return h.response;
      throw new Error('broker unavailable');
    });
    const context = await h.prepare();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls(h, 'heartbeat-invocation')).toHaveLength(3);
    expect(calls(h, 'finish-invocation')).toHaveLength(0);
    await context.credentialSession.release();
    await context.credentialSession.release();
    expect(calls(h, 'finish-invocation')).toHaveLength(1);
    expect(h.ddb.send).not.toHaveBeenCalled();
  });

  it('preserves the setup error when finish itself fails', async () => {
    const h = harness({ response: { executionId: 'foreign' } });
    h.broker.mockImplementation(async ({ action }) => {
      if (action === 'resolve-agent-credentials') return h.response;
      throw new Error('completion unavailable');
    });
    await expect(h.prepare()).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
    expect(calls(h, 'finish-invocation')).toHaveLength(1);
  });
});
