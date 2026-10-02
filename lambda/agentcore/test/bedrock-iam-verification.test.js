import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusyTracker, createServer, dispatchInvocation } from '../http-server.js';
import { authenticationCommandHandlers } from '../authentication-command-registry.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';
import { capabilities } from '../commands/capabilities.js';
import { currentCredentialSession } from '../credential-session.js';
import { normalizeConnection } from '../../shared/agent-auth-catalog.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';

// Discovery is stubbed; everything else is the real IAM session inside the generic command.
const listModels = vi.hoisted(() => vi.fn());
vi.mock('../bedrock-iam.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listIamBedrockModels: (...args) => listModels(...args),
}));

const HOUR = 3600_000;
const binding = connectionBinding(
  normalizeConnection({
    id: 'iam-verification-1',
    revision: 1,
    source: 'platform',
    mode: 'iam',
    backend: 'bedrock',
    mechanism: 'assume-role',
    configuration: { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' },
  }),
  1,
);
const request = {
  command: 'verify-connection',
  credentialBinding: binding,
  agentCredentialGrant: 'private-grant-fixture',
};
// The lease the broker host composes for a 'verify' request: no renewal, ends with the grant.
const verifyLease = () => {
  const now = Date.now();
  return {
    version: 1,
    material: {
      type: 'bedrock-iam',
      credentials: {
        AccessKeyId: 'A',
        SecretAccessKey: 'inert',
        Token: 'inert',
        Expiration: new Date(now + HOUR).toISOString(),
      },
    },
    expiresAt: now + 300_000,
    authorizationExpiresAt: now + 300_000,
    renewal: null,
  };
};
const brokered =
  (lease = verifyLease()) =>
  (payload, authMode) =>
    resolveInvocationAgentAuth({
      payload,
      authMode,
      env: { AWS_REGION: 'us-east-1' },
      broker: async () => ({
        purpose: 'verify-connection',
        projectId: null,
        executionId: null,
        credentials: [{ binding, lease }],
      }),
    });
afterEach(() => listModels.mockReset());

describe('IAM verification failures', () => {
  it('returns broker denial as HTTP 200 JSON before the command handler runs', async () => {
    const verify = vi.fn();
    const busy = createBusyTracker();
    const server = createServer({
      handlers: { verifyConnection: verify },
      busy,
      prepareInvocation: (payload, authMode) =>
        resolveInvocationAgentAuth({
          payload,
          authMode,
          broker: async () => {
            throw Object.assign(new Error('private provider diagnostic'), {
              code: 'BEDROCK_IAM_ACCESS_DENIED',
            });
          },
        }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body).toMatchObject({
        verified: false,
        code: 'BEDROCK_IAM_ACCESS_DENIED',
        error: expect.stringContaining('role trusts this application'),
      });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(verify).not.toHaveBeenCalled();
      expect(busy.status).toBe('Healthy');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([
    ['AGENT_CREDENTIAL_GRANT_EXPIRED', 'expired'],
    ['CREDENTIAL_BROKER_NOT_CONFIGURED', 'no credential broker'],
    ['untrusted-provider-code', 'could not prepare inference credentials'],
  ])('reports %s without exposing raw provider diagnostics', async (code, message) => {
    const result = await dispatchInvocation({
      payload: { command: 'verify-connection' },
      handlers: { verifyConnection: vi.fn() },
      prepareInvocation: async () => {
        throw Object.assign(new Error('private-grant-value'), { code });
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.verified).toBe(false);
    expect(result.body.error).toContain(message);
    expect(JSON.stringify(result.body)).not.toContain('private-grant-value');
    expect(JSON.stringify(result.body)).not.toContain('untrusted-provider-code');
  });

  it('distinguishes discovery denial after credentials were obtained', async () => {
    listModels.mockRejectedValue(
      Object.assign(new Error('private discovery details'), { name: 'AccessDeniedException' }),
    );
    const result = await dispatchInvocation({
      payload: request,
      handlers: authenticationCommandHandlers(),
      prepareInvocation: brokered(),
    });
    expect(result.body).toMatchObject({
      verified: false,
      code: 'BEDROCK_IAM_DISCOVERY_DENIED',
      error: expect.stringContaining('role was assumed'),
    });
    expect(JSON.stringify(result.body)).not.toContain('private');
  });

  it('does not attempt discovery when credentials could not be prepared', async () => {
    const result = await dispatchInvocation({
      payload: request,
      handlers: authenticationCommandHandlers(),
      prepareInvocation: brokered({ version: 1, material: null }),
    });
    expect(result.body).toMatchObject({ verified: false });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reports successful role assumption and model discovery', async () => {
    const models = [{ id: 'test-model' }];
    listModels.mockImplementation(async () => {
      // Discovery signs with the session's credentials, so it must run inside the session.
      expect(currentCredentialSession()?.credentialEnvironment).toHaveProperty(
        'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      );
      return models;
    });
    const result = await dispatchInvocation({
      payload: request,
      handlers: authenticationCommandHandlers(),
      prepareInvocation: brokered(),
      now: () => 'now',
    });
    expect(result.body).toEqual({
      verified: true,
      models,
      region: 'eu-west-1',
      command: 'verify-connection',
      at: 'now',
    });
  });
});

describe('IAM capabilities', () => {
  const probe = (materialTypes) =>
    capabilities({}, { discoverInstalledClis: async () => [], env: {}, materialTypes });

  it('advertises IAM selection and connection verification', async () => {
    const body = await probe([]);
    expect(body.agentAuthModes).toEqual(['keys', 'iam']);
    expect(body.agentAuthVerification).toEqual(['iam']);
  });

  it('reports Bedrock models only for an IAM invocation, and none when discovery fails', async () => {
    const models = [{ id: 'test-model' }];
    listModels.mockResolvedValueOnce(models);
    expect((await probe(['bedrock-iam'])).bedrockModels).toEqual(models);
    listModels.mockRejectedValueOnce(new Error('discovery failed'));
    expect((await probe(['bedrock-iam'])).bedrockModels).toEqual([]);
    expect(await probe(['api-key'])).not.toHaveProperty('bedrockModels');
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});
