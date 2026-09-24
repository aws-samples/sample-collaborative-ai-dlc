import { describe, expect, it, vi } from 'vitest';
import { createBusyTracker, createServer, dispatchInvocation } from '../http-server.js';
import { verifyBedrockIam } from '../commands/verify-bedrock-iam.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';

describe('IAM verification failures', () => {
  it('returns broker denial as HTTP 200 JSON before the command handler runs', async () => {
    const verify = vi.fn();
    const busy = createBusyTracker();
    const server = createServer({
      handlers: { verifyBedrockIam: verify },
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
        body: JSON.stringify({
          command: 'verify-bedrock-iam',
          credentialBindings: { bedrock: { provider: 'bedrock', source: 'platform' } },
          agentCredentialGrant: 'private-grant-fixture',
        }),
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
      payload: { command: 'verify-bedrock-iam' },
      handlers: { verifyBedrockIam: vi.fn() },
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
    const result = await verifyBedrockIam(
      {},
      {
        env: { BEDROCK_AUTH_MODE: 'iam', BEDROCK_REGION: 'eu-west-1' },
        listModels: async () => {
          throw Object.assign(new Error('private discovery details'), {
            name: 'AccessDeniedException',
          });
        },
      },
    );
    expect(result).toMatchObject({
      verified: false,
      code: 'BEDROCK_IAM_DISCOVERY_DENIED',
      error: expect.stringContaining('role was assumed'),
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not attempt discovery when credentials could not be prepared', async () => {
    const listModels = vi.fn();
    expect(await verifyBedrockIam({}, { listModels })).toMatchObject({ verified: false });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reports successful role assumption and model discovery', async () => {
    const models = [{ id: 'test-model' }];
    expect(
      await verifyBedrockIam(
        {},
        {
          env: { BEDROCK_AUTH_MODE: 'iam', BEDROCK_REGION: 'eu-west-1' },
          listModels: async () => models,
        },
      ),
    ).toEqual({ verified: true, models, region: 'eu-west-1' });
  });
});
