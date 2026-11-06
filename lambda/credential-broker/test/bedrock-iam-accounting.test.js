// Bedrock IAM through the broker entry point with engine data on: the IAM wire
// wrapper must keep the invocation accounting the host begins before any STS
// call, and a renewal (neutral or legacy renewalToken shape) must neither need
// a Gateway grant nor begin a second invocation. It does end with the handoff's
// authority: the execution's cancellation or the retirement of the Gateway
// grant the handoff was authorized by refuses it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { PutCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { makeDdb, createV2Table, deleteV2Table } from '../../agentcore/test/helpers/v2-table.js';
import { normalizeConnection } from '../../shared/agent-auth-catalog.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
import { signAgentCredentialGrant } from '../../shared/agent-credential-grants.js';
import { createAgentConnectionRepository } from '../../shared/agent-connection-repository.js';
import { BEDROCK_IAM_RENEWAL } from '../bedrock-iam-provider.js';
import { signRenewal } from '../agent-credential-renewal.js';
import { authorizeAgentCredentialRequest } from '../agent-authentication-entry.js';
import { authorizeInvocationAccountingRequest } from '../invocation-accounting.js';

const secret = 'inert-iam-accounting-secret-'.repeat(2);
const tableName = `iam-accounting-${randomUUID()}`;
const { client, doc: ddb } = makeDdb();
const connection = normalizeConnection({
  id: 'iam-accounting',
  revision: 1,
  mode: 'iam',
  backend: 'bedrock',
  mechanism: 'assume-role',
  source: 'space',
  projectId: 'p',
  configuration: {
    roleArn: 'arn:aws:iam::222222222222:role/Inference',
    region: 'eu-west-1',
    externalId: 'external-fixture',
  },
});
const binding = connectionBinding(connection, 0);
const repository = createAgentConnectionRepository({ ddb, tableName, base: '/test' });

const putExecution = (executionId, fields = {}) =>
  ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `EXEC#${executionId}`,
        sk: 'META',
        projectId: 'p',
        status: 'RUNNING',
        credentialBinding: binding,
        ...fields,
      },
    }),
  );

beforeAll(async () => {
  await createV2Table(client, tableName);
  await repository.putConnection(connection);
  await putExecution('e');
});
afterAll(async () => {
  await deleteV2Table(client, tableName);
  client.destroy();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const STRICT = { ENGINE_DATA_ENABLED: 'true', RUNTIME_GRANTS_ENFORCED: 'true' };
const TRANSITION = { ENGINE_DATA_ENABLED: 'true' };

const harness = ({ executionId = 'e', flags = STRICT } = {}) => {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const now = () => time;
  const stsClient = {
    send: vi.fn(async () => ({
      Credentials: {
        AccessKeyId: 'TARGET',
        SecretAccessKey: 'inert-secret',
        SessionToken: 'inert-session',
        Expiration: new Date(time + 3600_000),
      },
    })),
  };
  const ddbClient = { send: vi.fn((command) => ddb.send(command)) };
  const gatewayGrant = { grantId: `gw-${randomUUID()}`, issuedAt: Math.floor(time / 1000) - 5 };
  const verifyGrant = vi.fn(async () => ({
    mode: 'stage',
    projectId: 'p',
    executionId,
    ...gatewayGrant,
  }));
  const isGrantRetired = vi.fn(async () => false);
  const env = { ...flags, V2_PROCESS_TABLE: tableName };
  const deps = {
    secret,
    now,
    ddbClient,
    stsClient,
    ssmClient: {
      send: vi.fn(() => {
        throw new Error('SSM tripwire');
      }),
    },
    env,
    verifyGrant,
    isGrantRetired,
  };
  const handoff = () =>
    signAgentCredentialGrant(
      { purpose: 'execution', projectId: 'p', executionId, bindings: [binding] },
      secret,
      { now },
    );
  return {
    deps,
    env,
    now,
    stsClient,
    ddbClient,
    verifyGrant,
    isGrantRetired,
    origin: { ...gatewayGrant, executionId },
    advance: (ms) => {
      time += ms;
    },
    request: () => ({
      action: 'resolve-agent-credentials',
      command: 'run-stage',
      invocationNonce: randomUUID(),
      gatewayGrant: 'injected-gateway-grant',
      grant: handoff(),
    }),
    // A runtime started before engine data: no command, nonce or Gateway grant.
    legacyRequest: () => ({ action: 'resolve-agent-credentials', grant: handoff() }),
    renew: (token) => ({ action: BEDROCK_IAM_RENEWAL.action, grant: token }),
    resolve: (event) => authorizeAgentCredentialRequest(event, deps),
    finish: (ticket) =>
      authorizeInvocationAccountingRequest({ action: 'finish-invocation', ticket }, deps),
  };
};

const invocationRows = async (id) =>
  (await ddb.send(new ScanCommand({ TableName: tableName }))).Items.filter((row) => row.id === id);

describe('Bedrock IAM with broker invocation accounting', () => {
  it('begins accounting before STS and keeps it beside the IAM wire fields', async () => {
    const h = harness();
    const order = [];
    h.ddbClient.send.mockImplementation((command) => {
      if (command instanceof TransactWriteCommand) order.push('begin');
      return ddb.send(command);
    });
    h.stsClient.send.mockImplementationOnce(async () => {
      order.push('sts');
      return {
        Credentials: {
          AccessKeyId: 'TARGET',
          SecretAccessKey: 'inert-secret',
          SessionToken: 'inert-session',
          Expiration: new Date(Date.parse('2026-10-19T13:00:00Z')),
        },
      };
    });

    const result = await h.resolve(h.request());

    expect(order).toEqual(['begin', 'sts']);
    expect(h.verifyGrant).toHaveBeenCalledWith('injected-gateway-grant');
    expect(result.accounting).toEqual({
      invocationId: expect.any(String),
      ticket: expect.any(String),
    });
    expect(result.credentials[0]).toMatchObject({
      binding,
      iamCredentials: expect.objectContaining({ AccessKeyId: 'TARGET' }),
      renewalToken: expect.any(String),
    });
    expect(await invocationRows(result.accounting.invocationId)).toHaveLength(1);
    expect(await h.finish(result.accounting.ticket)).toEqual({ ok: true });
  });

  it('denies the IAM handoff without a Gateway grant once grants are enforced', async () => {
    const h = harness();
    const { gatewayGrant: _omitted, ...request } = h.request();
    h.verifyGrant.mockRejectedValueOnce(
      Object.assign(new Error('no grant'), { code: 'GATEWAY_GRANT_INVALID' }),
    );

    await expect(h.resolve(request)).rejects.toMatchObject({ code: 'GATEWAY_GRANT_INVALID' });
    expect(h.stsClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['neutral', (token) => ({ action: BEDROCK_IAM_RENEWAL.action, grant: token })],
    ['legacy', (token) => ({ action: BEDROCK_IAM_RENEWAL.action, renewalToken: token })],
  ])(
    'renews a %s request without a second invocation while its Gateway grant is live',
    async (_shape, shape) => {
      const h = harness();
      const result = await h.resolve(h.request());
      h.advance(3600_000);
      h.verifyGrant.mockClear();
      h.ddbClient.send.mockClear();

      const renewal = await h.resolve(shape(result.credentials[0].renewalToken));

      expect(renewal).not.toHaveProperty('accounting');
      expect(renewal.credentials[0].iamCredentials.AccessKeyId).toBe('TARGET');
      // The renewal re-checks the handoff's own Gateway grant, never a new one.
      expect(h.verifyGrant).not.toHaveBeenCalled();
      expect(h.isGrantRetired).toHaveBeenCalledExactlyOnceWith(h.origin);
      expect(
        h.ddbClient.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand),
      ).toBe(false);
      expect(await invocationRows(result.accounting.invocationId)).toHaveLength(1);
      expect(await h.finish(result.accounting.ticket)).toEqual({ ok: true });
    },
  );

  it('refuses a renewal once the Gateway grant of the handoff is retired', async () => {
    const h = harness();
    const { credentials } = await h.resolve(h.request());
    h.advance(3600_000);
    h.stsClient.send.mockClear();
    h.isGrantRetired.mockResolvedValueOnce(true);

    await expect(h.resolve(h.renew(credentials[0].renewalToken))).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
    expect(h.isGrantRetired).toHaveBeenCalledWith(h.origin);
    expect(h.stsClient.send).not.toHaveBeenCalled();
  });

  it('fails closed, retryably, when the retirement cannot be checked', async () => {
    const h = harness();
    const { credentials } = await h.resolve(h.request());
    h.stsClient.send.mockClear();
    h.isGrantRetired.mockRejectedValueOnce(new Error('ThrottlingException'));

    const error = await h.resolve(h.renew(credentials[0].renewalToken)).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    // Uncoded: the runtime's session retries the refresh instead of ending it.
    expect(error.code).toBeUndefined();
    expect(h.stsClient.send).not.toHaveBeenCalled();
  });

  it('refuses a renewal once the execution was cancelled after the handoff', async () => {
    const executionId = `e-${randomUUID()}`;
    await putExecution(executionId);
    const h = harness({ executionId });
    const { credentials } = await h.resolve(h.request());
    h.advance(60_000);
    await putExecution(executionId, {
      status: 'CANCELLED',
      completedAt: new Date(h.now()).toISOString(),
    });
    h.advance(3600_000);
    h.stsClient.send.mockClear();

    await expect(h.resolve(h.renew(credentials[0].renewalToken))).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
    expect(h.stsClient.send).not.toHaveBeenCalled();
  });

  it('keeps renewing a handoff authorized after the cancellation (a later discussion)', async () => {
    const executionId = `e-${randomUUID()}`;
    const h = harness({ executionId });
    await putExecution(executionId, {
      status: 'CANCELLED',
      completedAt: new Date(h.now() - 60_000).toISOString(),
    });
    const { credentials } = await h.resolve(h.request());
    h.advance(3600_000);

    const renewal = await h.resolve(h.renew(credentials[0].renewalToken));
    expect(renewal.credentials[0].iamCredentials.AccessKeyId).toBe('TARGET');
  });

  it('refuses a cancelled execution whose cancellation time is unreadable', async () => {
    const executionId = `e-${randomUUID()}`;
    await putExecution(executionId);
    const h = harness({ executionId });
    const { credentials } = await h.resolve(h.request());
    await putExecution(executionId, { status: 'CANCELLED' });

    await expect(h.resolve(h.renew(credentials[0].renewalToken))).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
  });

  describe('a renewal token that names no Gateway grant (issued before the binding)', () => {
    const legacyToken = async () => {
      const h = harness({ flags: TRANSITION });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { credentials } = await h.resolve(h.legacyRequest());
      expect(h.verifyGrant).not.toHaveBeenCalled();
      return { h, token: credentials[0].renewalToken };
    };

    it('is renewed the legacy way in transition, and logged', async () => {
      const { h, token } = await legacyToken();
      const warn = vi.mocked(Logger.prototype.warn);
      warn.mockClear();

      const renewal = await h.resolve(h.renew(token));

      expect(renewal.credentials[0].iamCredentials.AccessKeyId).toBe('TARGET');
      expect(h.isGrantRetired).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('legacy renewal token', {
        code: 'LEGACY_RENEWAL_TOKEN',
        action: BEDROCK_IAM_RENEWAL.action,
      });
    });

    it('is refused once runtime grants are enforced', async () => {
      const { h, token } = await legacyToken();
      Object.assign(h.env, STRICT);
      h.stsClient.send.mockClear();

      await expect(h.resolve(h.renew(token))).rejects.toMatchObject({
        code: 'AGENT_CREDENTIAL_GRANT_INVALID',
      });
      expect(h.stsClient.send).not.toHaveBeenCalled();
    });
  });

  it('cannot name the Gateway grant of another execution', () => {
    const h = harness();
    const claims = {
      version: 2,
      grantId: 'handoff',
      purpose: 'execution',
      projectId: 'p',
      executionId: 'e',
      bindings: [binding],
      issuedAt: Math.floor(h.now() / 1000),
      expiresAt: Math.floor(h.now() / 1000) + 300,
    };
    expect(() =>
      signRenewal({
        claims,
        binding,
        policy: BEDROCK_IAM_RENEWAL,
        key: secret,
        gatewayGrant: { ...h.origin, executionId: 'other' },
      }),
    ).toThrow(expect.objectContaining({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' }));
  });
});
