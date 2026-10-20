import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { makeDdb, createV2Table, deleteV2Table } from '../../agentcore/test/helpers/v2-table.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../../shared/agent-credential-grants.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { inventoryReferenceWrites } from '../../shared/agent-auth-inventory.js';
import { verifyInvocationAccountingTicket } from '../../shared/invocation-accounting-ticket.js';
import { authorizeAgentCredentialRequest } from '../agent-authentication.js';
import {
  authorizeInvocationAccountingRequest,
  MAX_INVOCATIONS_PER_GRANT,
} from '../invocation-accounting.js';
import { handler } from '../index.js';
import { createBrokerProviderRegistry } from '../agent-provider-registry.js';

const secret = 'inert-accounting-test-secret-'.repeat(3);
const start = Date.parse('2026-10-19T12:00:00Z');
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const tableName = `broker-accounting-${randomUUID()}`;
const { client, doc: ddb } = makeDdb();
const env = {
  ENGINE_DATA_ENABLED: 'true',
  V2_PROCESS_TABLE: tableName,
  AGENT_SETTINGS_SSM_PREFIX: '/test',
};
const binding = { provider: 'kiro', source: 'user', userId: 'accounting-user' };
const policyKey = { pk: 'AGENTAUTH#POLICY', sk: 'META' };
beforeAll(async () => createV2Table(client, tableName));
afterAll(async () => {
  await deleteV2Table(client, tableName);
  client.destroy();
});
beforeEach(async () =>
  ddb.send(
    new PutCommand({ TableName: tableName, Item: { ...policyKey, revision: 0, mode: 'keys' } }),
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const harness = () => {
  let time = start;
  const now = () => time;
  const ddbClient = { send: vi.fn((command) => ddb.send(command)) };
  const ssmClient = {
    send: vi.fn(async () => ({ Parameter: { Value: 'inert-provider-material' } })),
  };
  const verifyGrant = vi.fn((token) =>
    verifyGatewayGrant(token, {
      now,
      publicKeyFor: async (id) => (id === 'test-key' ? keys.publicKey : null),
    }),
  );
  const deps = { secret, now, env, ddbClient, ssmClient, verifyGrant };
  const request = async ({
    purpose = 'execution',
    command = 'run-stage',
    mode = 'stage',
    projectId = 'p',
    executionId = 'e',
    bindings = [binding],
  } = {}) => ({
    action: 'resolve-agent-credentials',
    command,
    invocationNonce: randomUUID(),
    grant: signAgentCredentialGrant({ purpose, projectId, executionId, bindings }, secret, { now }),
    ...(mode
      ? {
          gatewayGrant: await issueGatewayGrant(
            { mode, projectId, executionId, intentId: 'i' },
            {
              now,
              ttlSeconds: 300,
              keyId: 'test-key',
              sign: async (bytes) => sign('sha256', bytes, keys.privateKey),
            },
          ),
        }
      : {}),
  });
  return {
    ...deps,
    request,
    advance: (ms) => {
      time += ms;
    },
    resolve: (event, overrides = {}) =>
      authorizeAgentCredentialRequest(event, { ...deps, ...overrides }),
    act: (action, ticket, extra = {}) =>
      authorizeInvocationAccountingRequest({ action, ticket, ...extra }, deps),
  };
};
const read = async (id) =>
  (
    await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `AGENTAUTH#INVOCATION#${id}`, sk: 'META' },
        ConsistentRead: true,
      }),
    )
  ).Item;
const rawTicket = (claims) => {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
};

describe('broker accounting begin authority', () => {
  it('commits accounting before credential reads and ignores caller-supplied scope/bindings', async () => {
    const h = harness();
    h.ssmClient.send.mockImplementation(async () => {
      const writes = h.ddbClient.send.mock.calls
        .map(([c]) => c)
        .filter((c) => c instanceof TransactWriteCommand);
      expect(writes).toHaveLength(1);
      const invocation = writes[0].input.TransactItems.find(
        (item) => item.Put?.Item.type === 'AgentInvocation',
      ).Put.Item;
      expect(await read(invocation.id)).toMatchObject({
        state: 'ACTIVE',
        projectId: 'p',
        executionId: 'e',
        credentialBindings: [binding],
      });
      return { Parameter: { Value: 'inert-provider-material' } };
    });
    const result = await h.resolve({
      ...(await h.request()),
      projectId: 'forged',
      executionId: 'forged',
      bindings: [{ ...binding, userId: 'other' }],
    });
    expect(result.credentials[0].value).toBe('inert-provider-material');
    const invocation = await read(result.accounting.invocationId);
    expect(invocation.agentAuthTtl).toBeUndefined();
    for (const { Put } of inventoryReferenceWrites(tableName, invocation)) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: { pk: Put.Item.pk, sk: Put.Item.sk } }),
      );
      expect(Item).toEqual(Put.Item);
    }
  });

  it('reuses one invocation and activity increment for concurrent and lost-response retries', async () => {
    const h = harness();
    const request = await h.request();
    const entered = Promise.withResolvers();
    const material = Promise.withResolvers();
    h.ssmClient.send.mockImplementationOnce(() => {
      entered.resolve();
      return material.promise;
    });
    const first = h.resolve(request);
    await entered.promise;
    await expect(h.resolve(request)).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_CONFLICT',
    });
    expect(h.ssmClient.send).toHaveBeenCalledTimes(1);
    material.resolve({ Parameter: { Value: 'inert-provider-material' } });
    const one = await first;
    const two = await h.resolve(request);
    const three = await h.resolve(request);
    expect(one.accounting).toEqual(two.accounting);
    expect(three.accounting).toEqual(one.accounting);
    const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: policyKey }));
    expect(Item.activityRevision).toBe(1);
    const next = await h.resolve({ ...request, invocationNonce: randomUUID() });
    expect(next.accounting.invocationId).not.toBe(one.accounting.invocationId);
    const otherGrant = await h.resolve({
      ...(await h.request()),
      invocationNonce: request.invocationNonce,
    });
    expect(otherGrant.accounting.invocationId).not.toBe(one.accounting.invocationId);
  });

  it('caps the invocations one credential grant can begin, before any credential read', async () => {
    const h = harness();
    const request = await h.request();
    const nonces = Array.from({ length: MAX_INVOCATIONS_PER_GRANT }, () => randomUUID());
    const begun = [];
    for (const invocationNonce of nonces)
      begun.push(await h.resolve({ ...request, invocationNonce }));
    expect(new Set(begun.map((r) => r.accounting.invocationId)).size).toBe(
      MAX_INVOCATIONS_PER_GRANT,
    );
    h.ssmClient.send.mockClear();
    await expect(h.resolve({ ...request, invocationNonce: randomUUID() })).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_LIMIT',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    const { Items } = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        FilterExpression: '#type = :type AND executionId = :e',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': 'AgentInvocation', ':e': 'e' },
      }),
    );
    const ids = new Set(Items.map((item) => item.id));
    expect(begun.every((r) => ids.has(r.accounting.invocationId))).toBe(true);
    // A retry of an already begun nonce stays idempotent at the cap; a new grant has its own.
    expect((await h.resolve({ ...request, invocationNonce: nonces[0] })).accounting).toEqual(
      begun[0].accounting,
    );
    expect((await h.resolve(await h.request())).accounting.ticket).toEqual(expect.any(String));
  });

  it('recovers a same-nonce begin that lost the last budget slot to its own retry', async () => {
    const h = harness();
    const request = await h.request();
    for (let i = 1; i < MAX_INVOCATIONS_PER_GRANT; i += 1)
      await h.resolve({ ...request, invocationNonce: randomUUID() });
    // Both begins read no row, then commit one after the other: the second finds the
    // slot taken and its invocation row already written by the first.
    const secondBegin = Promise.withResolvers();
    const firstResolved = Promise.withResolvers();
    let begins = 0;
    h.ddbClient.send.mockImplementation(async (command) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems.some((item) => item.Put?.Item.type === 'AgentInvocation')
      ) {
        begins += 1;
        if (begins === 1) await secondBegin.promise;
        else {
          secondBegin.resolve();
          await firstResolved.promise;
        }
      }
      return ddb.send(command);
    });
    const first = h.resolve(request);
    const second = h.resolve(request);
    const one = await first;
    firstResolved.resolve();
    const two = await second;
    expect(begins).toBe(2);
    expect(two.accounting).toEqual(one.accounting);
    expect(h.ssmClient.send).toHaveBeenCalledTimes(MAX_INVOCATIONS_PER_GRANT + 1);

    h.ssmClient.send.mockClear();
    await expect(h.resolve({ ...request, invocationNonce: randomUUID() })).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_LIMIT',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
  });

  it.each([false, true])(async (cleanupFails) => {
    const h = harness();
    const failure = new Error('provider unavailable');
    h.ssmClient.send.mockRejectedValue(failure);
    h.ddbClient.send.mockImplementation((command) => {
      if (
        cleanupFails &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems[0].Update?.Key.pk.startsWith('AGENTAUTH#INVOCATION#')
      )
        throw new Error('completion unavailable');
      return ddb.send(command);
    });
    await expect(h.resolve(await h.request())).rejects.toBe(failure);
    const begin = h.ddbClient.send.mock.calls
      .flatMap(([command]) => command.input.TransactItems ?? [])
      .find((item) => item.Put?.Item.type === 'AgentInvocation').Put.Item;
    const invocation = await read(begin.id);
    expect(invocation.state).toBe(cleanupFails ? 'ACTIVE' : 'FINISHED');
    expect(invocation.credentialMaterialIssuedAt).toBeUndefined();
    expect(invocation.agentAuthTtl).toBe(cleanupFails ? undefined : start / 1000 + 86400);
    for (const { Put } of inventoryReferenceWrites(tableName, invocation)) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: { pk: Put.Item.pk, sk: Put.Item.sk } }),
      );
      expect(Item.agentAuthTtl).toBe(invocation.agentAuthTtl);
    }
  });

  it('a failing retry cannot finish an invocation already handed to another caller', async () => {
    const h = harness();
    const request = await h.request();
    const first = await h.resolve(request);
    const entered = Promise.withResolvers();
    const failed = Promise.withResolvers();
    h.ssmClient.send.mockImplementationOnce(() => {
      entered.resolve();
      return failed.promise;
    });
    const rejected = expect(h.resolve(request)).rejects.toThrow('retry provider failed');
    await entered.promise;
    const successful = await h.resolve(request);
    failed.reject(new Error('retry provider failed'));
    await rejected;
    expect(successful.accounting).toEqual(first.accounting);
    expect(await read(first.accounting.invocationId)).toMatchObject({
      state: 'ACTIVE',
      credentialMaterialIssuedAt: new Date(start).toISOString(),
    });
    await h.act('finish-invocation', first.accounting.ticket);
  });

  it.each([false, true])(
    'keeps ambiguous handoff acknowledgement conservative, committed=%s',
    async (committed) => {
      const h = harness();
      const request = await h.request();
      h.ddbClient.send.mockImplementation(async (command) => {
        if (
          command instanceof UpdateCommand &&
          command.input.UpdateExpression.includes('credentialMaterialIssuedAt')
        ) {
          if (committed) await ddb.send(command);
          throw new Error('lost acknowledgement');
        }
        return ddb.send(command);
      });
      await expect(h.resolve(request)).rejects.toThrow('lost acknowledgement');
      const invocation = h.ddbClient.send.mock.calls
        .flatMap(([command]) => command.input.TransactItems ?? [])
        .find((item) => item.Put?.Item.type === 'AgentInvocation').Put.Item;
      expect((await read(invocation.id)).state).toBe('ACTIVE');
      h.ddbClient.send.mockImplementation((command) => ddb.send(command));
      if (committed) expect((await h.resolve(request)).accounting.invocationId).toBe(invocation.id);
      else
        await expect(h.resolve(request)).rejects.toMatchObject({
          code: 'INVOCATION_ACCOUNTING_CONFLICT',
        });
    },
  );

  it('rejects a real policy CAS race before any credential read, and rechecks fresh reviews', async () => {
    const h = harness();
    const request = await h.request();
    h.ddbClient.send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: 'AGENTAUTH#REVIEW#racing',
              sk: 'META',
              candidate: {
                kind: 'credential-update',
                source: 'user',
                userId: binding.userId,
                changes: [{ provider: 'kiro' }],
              },
            },
          }),
        );
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: policyKey,
            UpdateExpression: 'SET revision = :revision, pendingReview = :review',
            ExpressionAttributeValues: { ':revision': 1, ':review': 'racing' },
          }),
        );
      }
      return ddb.send(command);
    });
    await expect(h.resolve(request)).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_CONFLICT',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    await expect(h.resolve(request)).rejects.toMatchObject({
      code: 'AGENT_AUTH_CHANGE_IN_PROGRESS',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['execution', 'run-stage', 'stage'],
    ['execution', 'resolve-conflict', 'conflict'],
    ['execution', 'derive-artifacts', 'execution'],
    ['compose', 'compose-plan-start', 'execution'],
    ['discussion', 'discussion-assist-start', 'discussion'],
  ])('accepts verified %s purpose for %s', async (purpose, command, mode) => {
    const h = harness();
    expect(
      (await h.resolve(await h.request({ purpose, command, mode }))).accounting.ticket,
    ).toBeTypeOf('string');
    expect(h.verifyGrant).toHaveBeenCalledTimes(1);
  });

  it('keeps capabilities grant-only without execution reads', async () => {
    const h = harness();
    const result = await h.resolve(
      await h.request({
        purpose: 'capabilities',
        command: 'capabilities',
        executionId: null,
        mode: null,
      }),
    );
    expect(result.accounting).toBeDefined();
    expect(h.verifyGrant).not.toHaveBeenCalled();
    expect(h.ddbClient.send.mock.calls.some(([c]) => c.input.Key?.pk?.startsWith('EXEC#'))).toBe(
      false,
    );
  });

  it.each([
    'missing-gateway',
    'bad-gateway',
    'expired-gateway',
    'foreign-project',
    'foreign-execution',
    'wrong-mode',
    'wrong-purpose',
    'missing-nonce',
    'bad-nonce',
    'bad-credential',
  ])('denies %s without material or accounting writes', async (kind) => {
    const h = harness();
    const event = await h.request();
    if (kind === 'missing-gateway') delete event.gatewayGrant;
    if (kind === 'bad-gateway') event.gatewayGrant += 'tampered';
    if (kind === 'foreign-project')
      event.gatewayGrant = (await h.request({ projectId: 'foreign' })).gatewayGrant;
    if (kind === 'foreign-execution')
      event.gatewayGrant = (await h.request({ executionId: 'foreign' })).gatewayGrant;
    if (kind === 'wrong-mode')
      event.gatewayGrant = (await h.request({ mode: 'discussion' })).gatewayGrant;
    if (kind === 'wrong-purpose') event.command = 'capabilities';
    if (kind === 'missing-nonce') delete event.invocationNonce;
    if (kind === 'bad-nonce') event.invocationNonce = 'caller-key';
    if (kind === 'bad-credential') event.grant = 'invalid';
    if (kind === 'expired-gateway') {
      h.advance(400_000);
      event.grant = (await h.request()).grant;
    }
    await expect(h.resolve(event)).rejects.toHaveProperty('code');
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    expect(h.ddbClient.send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(
      false,
    );
  });

  it('preserves flag-off redemption with no accounting fields or writes', async () => {
    const h = harness();
    const { grant } = await h.request();
    expect(
      await h.resolve({ grant }, { env: { ...env, ENGINE_DATA_ENABLED: 'false' } }),
    ).not.toHaveProperty('accounting');
    expect(h.verifyGrant).not.toHaveBeenCalled();
    expect(h.ddbClient.send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(
      false,
    );
  });
});

describe('broker accounting rollout modes', () => {
  const enforced = { ...env, RUNTIME_GRANTS_ENFORCED: 'true' };
  const accountingWrites = (h) =>
    h.ddbClient.send.mock.calls.some(([c]) => c instanceof TransactWriteCommand);

  it('serves the legacy request shape in transition without accounting and logs it', async () => {
    const h = harness();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { action, grant } = await h.request();
    const result = await h.resolve({ action, grant });
    expect(result).not.toHaveProperty('accounting');
    expect(result.credentials).toHaveLength(1);
    expect(h.verifyGrant).not.toHaveBeenCalled();
    expect(accountingWrites(h)).toBe(false);
    expect(warn).toHaveBeenCalledWith('legacy runtime request', {
      code: 'LEGACY_RUNTIME_REQUEST',
      action: 'resolve-agent-credentials',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(grant);
  });

  it('verifies new-shape requests in transition exactly as in enforcement', async () => {
    const h = harness();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect((await h.resolve(await h.request())).accounting.ticket).toBeTypeOf('string');
    expect(h.verifyGrant).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['nonce only', ['invocationNonce']],
    ['command only', ['command']],
    ['gateway grant only', ['gatewayGrant']],
    ['command and nonce without the required gateway grant', ['command', 'invocationNonce']],
    ['command and gateway grant without a nonce', ['command', 'gatewayGrant']],
  ])('denies a transition request mixing legacy and %s', async (_, fields) => {
    const h = harness();
    const event = await h.request();
    const mixed = Object.fromEntries(
      Object.entries(event).filter(([key]) => ['action', 'grant', ...fields].includes(key)),
    );
    await expect(h.resolve(mixed)).rejects.toHaveProperty('code');
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    expect(accountingWrites(h)).toBe(false);
  });

  it.each(['bad', 'expired', 'foreign'])(
    'denies a %s gateway grant in transition, never downgrading it',
    async (kind) => {
      const h = harness();
      const event = await h.request();
      if (kind === 'bad') event.gatewayGrant += 'tampered';
      if (kind === 'foreign')
        event.gatewayGrant = (await h.request({ projectId: 'foreign' })).gatewayGrant;
      if (kind === 'expired') {
        h.advance(400_000);
        event.grant = (await h.request()).grant;
      }
      await expect(h.resolve(event)).rejects.toMatchObject({
        code: kind === 'foreign' ? 'GATEWAY_GRANT_SCOPE_MISMATCH' : expect.any(String),
      });
      expect(h.ssmClient.send).not.toHaveBeenCalled();
      expect(accountingWrites(h)).toBe(false);
    },
  );

  it('denies the legacy request shape once runtime grants are enforced', async () => {
    const h = harness();
    const { action, grant } = await h.request();
    await expect(h.resolve({ action, grant }, { env: enforced })).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_INVALID',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    expect(accountingWrites(h)).toBe(false);
  });

  it('ignores the enforcement flag without engine data', async () => {
    const h = harness();
    const { grant } = await h.request();
    const result = await h.resolve(
      { grant },
      { env: { ...enforced, ENGINE_DATA_ENABLED: 'false' } },
    );
    expect(result).not.toHaveProperty('accounting');
    expect(accountingWrites(h)).toBe(false);
  });

  it('keeps accounting actions available in transition', async () => {
    const h = harness();
    const { accounting } = await h.resolve(await h.request());
    await expect(h.act('finish-invocation', accounting.ticket)).resolves.toEqual({ ok: true });
  });
});

describe('accounting tickets and completion', () => {
  it('heartbeats after dispatch expiry, atomically finishes references once, and cannot reopen', async () => {
    const h = harness();
    const request = await h.request();
    const { accounting } = await h.resolve(request);
    const claims = verifyInvocationAccountingTicket(accounting.ticket, secret, { now: h.now });
    expect(Object.keys(claims).toSorted()).toEqual([
      'audience',
      'expiresAt',
      'invocationId',
      'issuedAt',
    ]);
    expect(claims.expiresAt - claims.issuedAt).toBe(86400);
    h.advance(600_000);
    expect(await h.act('heartbeat-invocation', accounting.ticket)).toEqual({ ok: true });
    expect((await read(accounting.invocationId)).heartbeatAt).toBe(new Date(h.now()).toISOString());
    expect(await h.act('finish-invocation', accounting.ticket)).toEqual({ ok: true });
    const finished = await read(accounting.invocationId);
    expect(finished).toMatchObject({
      state: 'FINISHED',
      completedAt: new Date(h.now()).toISOString(),
      agentAuthTtl: h.now() / 1000 + 86400,
    });
    h.advance(60_000);
    expect(await h.act('finish-invocation', accounting.ticket)).toEqual({ ok: true });
    expect(await read(accounting.invocationId)).toEqual(finished);
    for (const { Put } of inventoryReferenceWrites(tableName, finished)) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: { pk: Put.Item.pk, sk: Put.Item.sk } }),
      );
      expect(Item.agentAuthTtl).toBe(finished.agentAuthTtl);
    }
    await expect(h.act('heartbeat-invocation', accounting.ticket)).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_INVALID',
    });
  });

  it('does not redeem again once the idempotent invocation is finished', async () => {
    const h = harness();
    const request = await h.request();
    const { accounting } = await h.resolve(request);
    await h.act('finish-invocation', accounting.ticket);
    h.ssmClient.send.mockClear();
    await expect(h.resolve(request)).rejects.toMatchObject({
      code: 'INVOCATION_ACCOUNTING_INVALID',
    });
    expect(h.ssmClient.send).not.toHaveBeenCalled();
  });

  it('concurrent finish is idempotent and failed completion leaves ACTIVE without TTL', async () => {
    const h = harness();
    const { accounting } = await h.resolve(await h.request());
    h.ddbClient.send.mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand) throw new Error('local completion failure');
      return ddb.send(command);
    });
    await expect(h.act('finish-invocation', accounting.ticket)).rejects.toThrow(
      'local completion failure',
    );
    const active = await read(accounting.invocationId);
    expect(active.state).toBe('ACTIVE');
    expect(active.agentAuthTtl).toBeUndefined();
    const { Items } = await ddb.send(new ScanCommand({ TableName: tableName }));
    for (const { Put } of inventoryReferenceWrites(tableName, active))
      expect(
        Items.find((row) => row.pk === Put.Item.pk && row.sk === Put.Item.sk).agentAuthTtl,
      ).toBeUndefined();
    h.ddbClient.send.mockImplementation((command) => ddb.send(command));
    await expect(
      Promise.all([
        h.act('finish-invocation', accounting.ticket),
        h.act('finish-invocation', accounting.ticket),
      ]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
  });

  it.each([
    'audience',
    'tampered',
    'expired',
    'other-invocation',
    'extra-claim',
    'too-long',
    'future',
    'wrong-row-time',
  ])('denies %s tickets without writes', async (kind) => {
    const h = harness();
    const { accounting } = await h.resolve(await h.request());
    const claims = verifyInvocationAccountingTicket(accounting.ticket, secret, { now: h.now });
    let ticket = accounting.ticket;
    if (kind === 'audience')
      ticket = rawTicket({ ...claims, audience: 'aidlc-agent-credential-broker' });
    if (kind === 'tampered') ticket = `${ticket.split('.')[0]}.${'A'.repeat(43)}`;
    if (kind === 'expired') h.advance(86400_000);
    if (kind === 'other-invocation')
      ticket = rawTicket({ ...claims, invocationId: 'f'.repeat(64) });
    if (kind === 'extra-claim') ticket = rawTicket({ ...claims, bindings: [binding] });
    if (kind === 'too-long') ticket = rawTicket({ ...claims, expiresAt: claims.expiresAt + 1 });
    if (kind === 'future') ticket = rawTicket({ ...claims, issuedAt: claims.issuedAt + 1 });
    if (kind === 'wrong-row-time')
      ticket = rawTicket({
        ...claims,
        issuedAt: claims.issuedAt - 1,
        expiresAt: claims.expiresAt - 1,
      });
    h.ddbClient.send.mockClear();
    for (const action of ['heartbeat-invocation', 'finish-invocation'])
      await expect(h.act(action, ticket)).rejects.toHaveProperty('code');
    expect(h.ddbClient.send.mock.calls.every(([c]) => c instanceof GetCommand)).toBe(true);
    expect((await read(accounting.invocationId)).state).toBe('ACTIVE');
  });

  it('rejects retargeting fields, grant replay, and accounting audience as a renewal audience', async () => {
    const h = harness();
    const event = await h.request();
    const { accounting } = await h.resolve(event);
    await expect(
      h.act('finish-invocation', accounting.ticket, { invocationId: 'other' }),
    ).rejects.toHaveProperty('code');
    await expect(h.act('heartbeat-invocation', event.grant)).rejects.toHaveProperty('code');
    expect(() => verifyAgentCredentialGrant(accounting.ticket, secret, { now: h.now })).toThrow();
    await expect(h.resolve({ ...event, grant: accounting.ticket })).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
    expect(() =>
      createBrokerProviderRegistry([
        {
          id: 'test',
          adapters: { 'test:api-key': () => null },
          renewal: {
            action: 'renew-test',
            audience: 'aidlc-invocation-accounting',
            ttlSeconds: 300,
          },
        },
      ]),
    ).toThrow('distinct');
  });

  it('redacts ticket and caller-controlled secrets at the real handler boundary', async () => {
    vi.stubEnv('ENGINE_DATA_ENABLED', 'true');
    vi.stubEnv('V2_PROCESS_TABLE', tableName);
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', secret);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sentinel = 'never-log-this-secret-ticket';
    expect(await handler({ action: 'finish-invocation', ticket: sentinel })).toEqual({
      ok: false,
      code: 'INVOCATION_TICKET_INVALID',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
});
