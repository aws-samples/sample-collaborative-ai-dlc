import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { createBusyTracker, createServer, dispatchInvocation } from '../http-server.js';
import { authenticationCommandHandlers } from '../authentication-command-registry.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';
import { createCredentialSession } from '../credential-session.js';
import { accountCredentialInvocation } from '../invocation-accounting.js';
import { CONNECTION_VERIFICATION_FAILURES } from '../credential-material-registry.js';
import { capabilities } from '../commands/capabilities.js';
import { apiKeyLease, normalizeCredentialLease } from '../../shared/agent-credential-lease.js';
import {
  FAKE_BINDING,
  FAKE_CONTROLLED_ENV,
  FAKE_MATERIAL_TYPE,
  FAKE_VERIFICATION_DENIED,
} from './helpers/fake-runtime-provider.js';

// The synthetic mode's provider is registered with a spy verifier, so the real host views and
// the real foundation command serve it exactly as a provider's root line would.
const verify = vi.hoisted(() => vi.fn());
vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) => {
  const { withAuthModes } = await import('../../shared/test/helpers/auth-modes.js');
  const { FAKE_RUNTIME_MODES } = await import('./helpers/fake-runtime-provider.js');
  return withAuthModes(importOriginal, FAKE_RUNTIME_MODES);
});
vi.mock('../runtime-auth-providers.js', async (importOriginal) => {
  const { FAKE_RUNTIME_PROVIDER, withRuntimeProviders } =
    await import('./helpers/fake-runtime-provider.js');
  verify.mockImplementation(FAKE_RUNTIME_PROVIDER.verify);
  return withRuntimeProviders(importOriginal, [{ ...FAKE_RUNTIME_PROVIDER, verify }]);
});

const GRANT = 'private-grant-fixture';
const FAILED = 'AGENT_AUTH_VERIFICATION_FAILED';
const UNSUPPORTED = 'AGENT_AUTH_RUNTIME_UNSUPPORTED';
const KEYS_BINDING = Object.freeze({
  version: 2,
  provider: 'bedrock',
  source: 'platform',
  connectionId: 'legacy-platform-bedrock',
  connectionRevision: 1,
  policyRevision: 1,
  mode: 'keys',
  backend: 'bedrock',
  mechanism: 'api-key',
  configuration: {},
});
const fakeLease = (material = { type: FAKE_MATERIAL_TYPE, token: 'private-token' }) =>
  normalizeCredentialLease({ version: 1, material, expiresAt: Date.now() + 120_000 });
const request = (credentialBinding) => ({
  command: 'verify-connection',
  projectId: null,
  ...(credentialBinding ? { credentialBinding } : {}),
  agentCredentialGrant: GRANT,
});
const brokerReturning = (credentials) =>
  vi.fn(async () => ({
    purpose: 'verify-connection',
    projectId: null,
    executionId: null,
    credentials,
  }));
const ambient = {
  PATH: '/usr/bin',
  [FAKE_CONTROLLED_ENV]: 'ambient',
  AWS_BEARER_TOKEN_BEDROCK: 'x',
};
const resolving = (broker) => (payload, authMode) =>
  resolveInvocationAgentAuth({ payload, authMode, env: ambient, broker });
const dispatch = ({ payload, prepareInvocation, handlers = authenticationCommandHandlers() }) =>
  dispatchInvocation({ payload, handlers, prepareInvocation, now: () => 'now' });
const failureBody = (code) => ({
  verified: false,
  code,
  error: CONNECTION_VERIFICATION_FAILURES[code],
  command: 'verify-connection',
  at: 'now',
});

beforeEach(() => {
  verify.mockClear();
});

describe('verify-connection', () => {
  it("hands the single normalized binding and its prepared env to the mode's verifier", async () => {
    const broker = brokerReturning([{ binding: FAKE_BINDING, lease: fakeLease() }]);
    const result = await dispatch({
      // Fields outside the binding contract never reach the verifier.
      payload: request({ ...FAKE_BINDING, state: 'draft' }),
      prepareInvocation: resolving(broker),
    });

    expect(result).toEqual({
      statusCode: 200,
      body: {
        verified: true,
        connectionId: FAKE_BINDING.connectionId,
        region: 'eu-west-1',
        command: 'verify-connection',
        at: 'now',
      },
    });
    expect(broker).toHaveBeenCalledExactlyOnceWith({
      action: 'resolve-agent-credentials',
      grant: GRANT,
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith({
      binding: { ...FAKE_BINDING },
      env: { PATH: '/usr/bin', [FAKE_CONTROLLED_ENV]: 'eu-west-1' },
    });
  });

  it.each([
    [
      'inactive material',
      FAKE_BINDING,
      [{ binding: FAKE_BINDING, lease: fakeLease(null) }],
      FAILED,
    ],
    [
      'a v1 binding',
      { provider: 'bedrock', source: 'platform' },
      [{ binding: { provider: 'bedrock', source: 'platform' }, lease: apiKeyLease('private-key') }],
      FAILED,
    ],
    ['no binding', null, [], FAILED],
    [
      'a mode without a verifier',
      KEYS_BINDING,
      [{ binding: KEYS_BINDING, lease: apiKeyLease('private-key') }],
      UNSUPPORTED,
    ],
  ])('answers %s with a structured foundation failure', async (_, binding, credentials, code) => {
    const result = await dispatch({
      payload: request(binding),
      prepareInvocation: resolving(brokerReturning(credentials)),
    });
    expect(result).toEqual({ statusCode: 200, body: failureBody(code) });
    expect(JSON.stringify(result.body)).not.toContain('private');
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ['AGENT_CREDENTIAL_GRANT_EXPIRED', 'AGENT_CREDENTIAL_GRANT_EXPIRED', 'expired'],
    ['AGENT_CREDENTIAL_GRANT_INVALID', 'AGENT_CREDENTIAL_GRANT_INVALID', 'rejected'],
    ['AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED', 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED', 'missing'],
    [
      'CREDENTIAL_BROKER_NOT_CONFIGURED',
      'CREDENTIAL_BROKER_NOT_CONFIGURED',
      'no credential broker',
    ],
    [FAKE_VERIFICATION_DENIED, FAKE_VERIFICATION_DENIED, 'test provider refused'],
    ['untrusted-provider-code', FAILED, 'could not prepare inference credentials'],
    ['credential_grant_mismatch', FAILED, 'could not prepare inference credentials'],
  ])('reports a pre-handler %s without its diagnostics', async (thrown, code, message) => {
    const handler = vi.fn();
    const result = await dispatch({
      payload: request(FAKE_BINDING),
      handlers: { verifyConnection: handler },
      prepareInvocation: async () => {
        throw Object.assign(new Error('private provider diagnostic'), { code: thrown });
      },
    });
    expect(result).toEqual({ statusCode: 200, body: failureBody(code) });
    expect(result.body.error).toContain(message);
    expect(JSON.stringify(result.body)).not.toMatch(/private|untrusted/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers a failing or malformed verifier without provider text', async () => {
    const prepareInvocation = resolving(
      brokerReturning([{ binding: FAKE_BINDING, lease: fakeLease() }]),
    );
    verify.mockRejectedValueOnce(
      Object.assign(new Error('private provider diagnostic'), { name: 'AccessDeniedException' }),
    );
    verify.mockResolvedValueOnce({ models: ['private-model'] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await dispatch({ payload: request(FAKE_BINDING), prepareInvocation });
      expect(result).toEqual({ statusCode: 200, body: failureBody(FAILED) });
    }
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('returns a broker denial over HTTP as 200 JSON before the verifier runs', async () => {
    const busy = createBusyTracker();
    const server = createServer({
      handlers: authenticationCommandHandlers(),
      busy,
      prepareInvocation: resolving(async () => {
        throw Object.assign(new Error('private provider diagnostic'), {
          code: FAKE_VERIFICATION_DENIED,
        });
      }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request(FAKE_BINDING)),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        verified: false,
        code: FAKE_VERIFICATION_DENIED,
        error: CONNECTION_VERIFICATION_FAILURES[FAKE_VERIFICATION_DENIED],
      });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(verify).not.toHaveBeenCalled();
      expect(busy.status).toBe('Healthy');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps the pending-change guard ahead of the handler', async () => {
    // A reviewed platform key rotation is waiting for its secret write.
    const ddb = {
      send: vi.fn(async (command) => {
        expect(command).toBeInstanceOf(GetCommand);
        const { pk } = command.input.Key;
        if (pk === 'AGENTAUTH#POLICY') return { Item: { revision: 2, pendingReview: 'r-1' } };
        if (pk === 'AGENTAUTH#REVIEW#r-1')
          return {
            Item: {
              candidate: {
                kind: 'credential-update',
                source: 'platform',
                changes: [{ provider: 'bedrock', action: 'set', digest: 'd' }],
              },
            },
          };
        return {};
      }),
    };
    const broker = brokerReturning([{ binding: KEYS_BINDING, lease: apiKeyLease('private-key') }]);
    const released = vi.fn();
    // The container's invocation context: resolve, then account before any handler runs.
    const prepareInvocation = async (payload, authMode) => {
      const auth = await resolving(broker)(payload, authMode);
      const session = createCredentialSession({ env: auth.env });
      session.own(released);
      try {
        await accountCredentialInvocation({
          ddb,
          tableName: 'process',
          session,
          payload: { ...payload, projectId: auth.projectId },
          bindings: auth.bindings,
        });
      } catch (error) {
        await session.release();
        throw error;
      }
      return { ...auth, credentialSession: session };
    };
    const handler = vi.fn(authenticationCommandHandlers().verifyConnection);

    const result = await dispatch({
      payload: request(KEYS_BINDING),
      handlers: { verifyConnection: handler },
      prepareInvocation,
    });
    expect(result).toEqual({ statusCode: 200, body: failureBody(FAILED) });
    expect(handler).not.toHaveBeenCalled();
    expect(ddb.send).toHaveBeenCalledTimes(2);
    expect(released).toHaveBeenCalledOnce();
  });

  it('advertises the modes it can verify', async () => {
    const body = await capabilities({}, { discoverInstalledClis: async () => [], env: {} });
    expect(body.agentAuthVerification).toContain(FAKE_BINDING.mode);
    expect(body.agentAuthVerification).not.toContain('keys');
    expect(body.agentAuthModes).toEqual(expect.arrayContaining(body.agentAuthVerification));
  });
});
