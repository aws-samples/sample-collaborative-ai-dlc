import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import { authorizeCredentialRequest, handler } from '../index.js';
import { createBrokerProviderRegistry } from '../agent-provider-registry.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { resolveBindingCredential } from '../../shared/source-control-credentials.js';

vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: vi.fn(async () => ({ username: 'test', password: 'inert-test-value' })),
}));

const now = () => Date.parse('2026-10-19T12:00:00Z');
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const foreignKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const scope = { mode: 'execution', projectId: 'p', intentId: 'i', executionId: 'e' };
const request = {
  action: 'source-control',
  projectId: 'p',
  executionId: 'e',
  provider: 'github',
  repository: 'Acme/API',
  requiredAccess: 'identity',
};
const env = { ENGINE_DATA_ENABLED: 'true', V2_PROCESS_TABLE: 'process' };
const signer = {
  sign: async (message) => sign('sha256', message, keys.privateKey),
  keyId: 'trusted',
  now,
};
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    now,
    publicKeyFor: async (id) => (id === 'trusted' ? keys.publicKey : null),
  });
const token = (overrides = {}, options = {}) =>
  issueGatewayGrant({ ...scope, ...overrides }, { ...signer, ...options });

const harness = (overrides = {}) => {
  const execution = {
    projectId: 'p',
    intentId: 'i',
    status: 'RUNNING',
    repos: ['acme/api'],
    gitProvider: 'github',
    ...overrides.execution,
  };
  const binding = {
    status: 'active',
    actorName: 'App',
    actorEmail: 'app@example.test',
    capabilities: { repositoryWrite: true },
    ...overrides.binding,
  };
  const ddbClient = {
    send: vi.fn(async ({ input }) => ({ Item: input.Key.pk ? execution : binding })),
  };
  const ssmClient = {
    send: vi.fn(() => {
      throw new Error('secret read tripwire');
    }),
  };
  return { ddbClient, ssmClient, env, verifyGrant };
};

beforeEach(() => {
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  vi.mocked(resolveBindingCredential).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('broker source-control security matrix', () => {
  it.each(['identity', 'read', 'write'])(
    'requires a grant for %s access before any data read',
    async (requiredAccess) => {
      const deps = harness();
      await expect(
        authorizeCredentialRequest({ ...request, requiredAccess }, deps),
      ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_INVALID' });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
      expect(deps.ssmClient.send).not.toHaveBeenCalled();
    },
  );

  it.each(['forged', 'expired', 'wrong-key', 'wrong-audience', 'wrong-issuer'])(
    'denies %s tokens',
    async (kind) => {
      let gatewayGrant;
      if (kind === 'forged')
        gatewayGrant = await token(
          {},
          { sign: async (message) => sign('sha256', message, foreignKeys.privateKey) },
        );
      if (kind === 'expired')
        gatewayGrant = await token({}, { now: () => now() - 300_000, ttlSeconds: 300 });
      if (kind === 'wrong-key') gatewayGrant = await token({}, { keyId: 'untrusted' });
      if (kind === 'wrong-audience' || kind === 'wrong-issuer') {
        const [header, encoded] = (await token()).split('.');
        const claims = JSON.parse(Buffer.from(encoded, 'base64url'));
        claims[kind === 'wrong-audience' ? 'aud' : 'iss'] = 'other';
        const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
        gatewayGrant = `${input}.${sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      }
      const deps = harness();
      await expect(
        authorizeCredentialRequest({ ...request, gatewayGrant }, deps),
      ).rejects.toMatchObject({
        code: kind === 'expired' ? 'GATEWAY_GRANT_EXPIRED' : 'GATEWAY_GRANT_INVALID',
      });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([{ projectId: 'foreign' }, { executionId: 'foreign' }, { mode: 'discussion' }])(
    'denies signed scope mismatch %j',
    async (overrides) => {
      const deps = harness();
      await expect(
        authorizeCredentialRequest({ ...request, gatewayGrant: await token(overrides) }, deps),
      ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([{ projectId: 'foreign' }, { intentId: 'foreign' }])(
    'denies META mismatch %j',
    async (execution) => {
      const deps = harness({ execution });
      await expect(
        authorizeCredentialRequest({ ...request, gatewayGrant: await token() }, deps),
      ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
      expect(deps.ddbClient.send).toHaveBeenCalledTimes(1);
      expect(deps.ddbClient.send.mock.calls[0][0].input.ConsistentRead).toBe(true);
      expect(deps.ssmClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ execution: { status: 'SUCCEEDED' } }, 'EXECUTION_NOT_ACTIVE'],
    [{ execution: { repos: ['acme/other'] } }, 'REPOSITORY_NOT_ON_EXECUTION'],
    [{ binding: { status: 'invalid' } }, 'SOURCE_CONTROL_NOT_READY'],
  ])('preserves existing denial checks %j', async (options, code) => {
    await expect(
      authorizeCredentialRequest({ ...request, gatewayGrant: await token() }, harness(options)),
    ).rejects.toMatchObject({ code });
  });

  it('preserves the write capability check after grant verification', async () => {
    const deps = harness({ binding: { capabilities: { repositoryWrite: false } } });
    await expect(
      authorizeCredentialRequest(
        { ...request, requiredAccess: 'write', gatewayGrant: await token() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_ACCESS_REQUIRED' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });

  it.each(['execution', 'stage', 'conflict'])(
    'accepts engine mode %s and canonical attached repository identity',
    async (mode) => {
      await expect(
        authorizeCredentialRequest({ ...request, gatewayGrant: await token({ mode }) }, harness()),
      ).resolves.toEqual({ committer: { name: 'App', email: 'app@example.test' } });
    },
  );

  it.each(['read', 'write'])(
    'forwards authorized %s access through the existing credential resolver',
    async (requiredAccess) => {
      const deps = harness();
      await expect(
        authorizeCredentialRequest(
          { ...request, requiredAccess, gatewayGrant: await token() },
          deps,
        ),
      ).resolves.toEqual({ username: 'test', password: 'inert-test-value' });
      expect(resolveBindingCredential).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requiredAccess,
          executionId: 'e',
          ddb: deps.ddbClient,
          ssm: deps.ssmClient,
          binding: expect.objectContaining({ status: 'active' }),
        }),
      );
    },
  );

  it('denies missing META before checking a binding or resolving credentials', async () => {
    const deps = { ...harness(), ddbClient: { send: vi.fn(async () => ({})) } };
    await expect(
      authorizeCredentialRequest({ ...request, gatewayGrant: await token() }, deps),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
    expect(deps.ddbClient.send).toHaveBeenCalledTimes(1);
    expect(resolveBindingCredential).not.toHaveBeenCalled();
  });

  it('fails closed without a configured public key allowlist', async () => {
    await expect(
      authorizeCredentialRequest(
        { ...request, gatewayGrant: await token() },
        { ...harness(), verifyGrant: undefined },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_INVALID' });
  });

  it('keeps flag-off legacy requests without Gateway authority', async () => {
    const deps = {
      ...harness(),
      env: { ...env, ENGINE_DATA_ENABLED: 'false' },
      verifyGrant: vi.fn(),
    };
    await expect(authorizeCredentialRequest(request, deps)).resolves.toHaveProperty('committer');
    expect(deps.verifyGrant).not.toHaveBeenCalled();
  });
});

describe('broker dispatch security matrix', () => {
  it('preserves Gateway-denial codes and never logs supplied token or repository values', async () => {
    vi.stubEnv('ENGINE_DATA_ENABLED', 'true');
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    expect(
      await handler({ ...request, gatewayGrant: 'secret-sentinel', repository: 'secret-sentinel' }),
    ).toEqual({ ok: false, code: 'GATEWAY_GRANT_INVALID' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-sentinel');
  });
  it.each(['true', 'false'])(
    'denies unknown actions without reads or caller values in logs, enabled=%s',
    async (enabled) => {
      vi.stubEnv('ENGINE_DATA_ENABLED', enabled);
      const ddb = mockClient(DynamoDBDocumentClient);
      const ssm = mockClient(SSMClient);
      const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      try {
        const sentinel = 'caller-controlled-secret-value';
        for (const action of [sentinel, '', null, false, 0, {}, [], 'toString', 'constructor']) {
          expect(
            await handler({
              ...request,
              action,
              repository: sentinel,
              grant: sentinel,
              gatewayGrant: sentinel,
              ticket: sentinel,
            }),
          ).toEqual({ ok: false, code: 'INVALID_ACTION' });
        }
        expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
        expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
        expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
      } finally {
        ddb.restore();
        ssm.restore();
      }
    },
  );

  it.each(['heartbeat-invocation', 'finish-invocation', 'resolve-mcp-secrets'])(
    'reserves %s against provider renewal collisions',
    (action) => {
      expect(() =>
        createBrokerProviderRegistry([
          {
            id: 'test',
            adapters: { 'test:api-key': () => {} },
            renewal: { action, audience: 'test-renewal', ttlSeconds: 300 },
          },
        ]),
      ).toThrow('reserved action');
    },
  );
});
