import { describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import { buildExecutionMeta } from '../v2-process-keys.js';
import { conditionCheckPasses, evaluateCondition } from './ddb-condition-eval.js';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  GATEWAY_GRANT_MAX_TTL_SECONDS,
  issueGatewayGrant,
  verifyGatewayGrant,
} from '../gateway-grant.js';
import {
  GATEWAY_GRANT_RETIREMENT_SKEW_MS,
  GATEWAY_GRANT_RETIREMENT_TABLE_ENV,
  awaitGrantIssuanceAfterRetirement,
  executionRetirementSecond,
  gatewayExecutionRetirerFromEnv,
  gatewayGrantIssuanceGuardFromEnv,
  gatewayGrantRetirementCheckFromEnv,
  gatewayGrantRetirementExpiry,
  gatewayGrantRetirerFromEnv,
  isGatewayGrantRetired,
  retireGatewayExecution,
  retireGatewayGrant,
} from '../gateway-grant-retirement.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const stageScope = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
};

const issue = (randomId = () => 'grant-1', { at = NOW, scope = stageScope } = {}) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => at,
    randomId,
  });
const verify = (token, isRetired, { at = NOW + 1000 } = {}) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => at,
    isRetired,
  });

const conditionFailed = () =>
  Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

// An in-memory stand-in for the DocumentClient that honours the conditions the
// retirement store relies on: the conditional jti put, the max-retiredAt update
// and the run-ownership ConditionCheck on the process table's META row.
const memoryDdb = () => {
  const items = new Map();
  const runs = new Map();
  const metas = new Map();
  const retirementHolds = (update) => {
    const current = items.get(update.Key.pk);
    return (
      current?.retiredAt === undefined ||
      current.retiredAt < update.ExpressionAttributeValues[':retiredAt']
    );
  };
  const applyUpdate = (update) => {
    const v = update.ExpressionAttributeValues;
    items.set(update.Key.pk, {
      pk: update.Key.pk,
      executionId: v[':executionId'],
      retiredAt: v[':retiredAt'],
      expiresAt: v[':expiresAt'],
      retirementReason: v[':reason'],
      updatedAt: v[':updatedAt'],
    });
  };
  // META as DynamoDB holds it: a run id set to null is a stored NULL, an
  // execution without an entry has no orchestratorRunId attribute.
  const runHolds = (check) => {
    const executionId = check.Key.pk.replace(/^EXEC#/, '');
    return conditionCheckPasses(check, {
      ...check.Key,
      ...(runs.has(executionId) ? { orchestratorRunId: runs.get(executionId) } : {}),
    });
  };
  const send = vi.fn(async (command) => {
    const { input } = command;
    switch (command.constructor.name) {
      case 'PutCommand':
        if (input.ConditionExpression && items.has(input.Item.pk)) throw conditionFailed();
        items.set(input.Item.pk, input.Item);
        return {};
      case 'UpdateCommand':
        if (!retirementHolds(input)) throw conditionFailed();
        applyUpdate(input);
        return {};
      case 'TransactWriteCommand': {
        const [{ ConditionCheck: check }, { Update: update }] = input.TransactItems;
        const reasons = [
          { Code: runHolds(check) ? 'None' : 'ConditionalCheckFailed' },
          { Code: retirementHolds(update) ? 'None' : 'ConditionalCheckFailed' },
        ];
        if (reasons.some((r) => r.Code !== 'None')) {
          throw Object.assign(new Error('cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: reasons,
          });
        }
        applyUpdate(update);
        return {};
      }
      default:
        if (input.TableName === 'process') return { Item: metas.get(input.Key.pk) };
        return { Item: items.get(input.Key.pk) };
    }
  });
  return { send, items, runs, metas };
};

const store = (ddb, now = () => NOW) => ({
  ddb,
  tableName: 't',
  processTableName: 'process',
  now,
});

describe('verifyGatewayGrant retirement seam', () => {
  it('accepts a grant that is not retired and checks its jti, execution and issue time', async () => {
    const isRetired = vi.fn(async () => false);
    await expect(verify(await issue(), isRetired)).resolves.toMatchObject({ grantId: 'grant-1' });
    expect(isRetired).toHaveBeenCalledWith({
      grantId: 'grant-1',
      executionId: 'e-1',
      issuedAt: Math.floor(NOW / 1000),
    });
  });

  it('passes no execution for a discussion grant', async () => {
    const isRetired = vi.fn(async () => false);
    const token = await issue(() => 'grant-d', {
      scope: { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' },
    });
    await verify(token, isRetired);
    expect(isRetired).toHaveBeenCalledWith(expect.objectContaining({ executionId: null }));
  });

  it('rejects a retired grant', async () => {
    await expect(verify(await issue(), async () => true)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIRED',
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a truthy non-boolean', 'yes'],
  ])('treats a %s answer as retired (fail closed)', async (_label, answer) => {
    await expect(verify(await issue(), async () => answer)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIRED',
    });
  });

  it('fails closed when the retirement lookup fails', async () => {
    await expect(
      verify(await issue(), async () => {
        throw new Error('ProvisionedThroughputExceededException');
      }),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE' });
  });

  it('never consults the store for a grant that fails verification', async () => {
    const isRetired = vi.fn(async () => false);
    await expect(verify('a.b.c', isRetired)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_INVALID',
    });
    expect(isRetired).not.toHaveBeenCalled();
  });
});

describe('gateway grant retirement store', () => {
  it('records a retirement that outlives any grant it can name', async () => {
    const ddb = memoryDdb();
    await expect(
      retireGatewayGrant(
        { ddb, tableName: 't', now: () => NOW },
        { grantId: 'grant-1', executionId: 'e-1', stageCallbackId: 'cb-1', outcome: 'SUCCEEDED' },
      ),
    ).resolves.toEqual({ retired: true, alreadyRetired: false });
    const item = ddb.items.get('GRANT#grant-1');
    expect(item).toMatchObject({
      grantId: 'grant-1',
      executionId: 'e-1',
      stageCallbackId: 'cb-1',
      outcome: 'SUCCEEDED',
      retiredAt: new Date(NOW).toISOString(),
    });
    expect(item.expiresAt).toBe(gatewayGrantRetirementExpiry(NOW));
    expect(item.expiresAt - Math.floor(NOW / 1000)).toBeGreaterThanOrEqual(
      GATEWAY_GRANT_MAX_TTL_SECONDS,
    );
    const lookup = { ddb, tableName: 't' };
    await expect(isGatewayGrantRetired(lookup, { grantId: 'grant-1' })).resolves.toBe(true);
    await expect(isGatewayGrantRetired(lookup, { grantId: 'grant-2' })).resolves.toBe(false);
    expect(ddb.send.mock.calls.at(-1)[0].input).toMatchObject({ ConsistentRead: true });
  });

  it('is idempotent and keeps the first retirement', async () => {
    const ddb = memoryDdb();
    const options = { ddb, tableName: 't', now: () => NOW };
    await retireGatewayGrant(options, { grantId: 'grant-1', outcome: 'SUCCEEDED' });
    await expect(
      retireGatewayGrant({ ...options, now: () => NOW + 5000 }, { grantId: 'grant-1' }),
    ).resolves.toEqual({ retired: true, alreadyRetired: true });
    expect(ddb.items.get('GRANT#grant-1').outcome).toBe('SUCCEEDED');
  });

  it('surfaces a write failure to the caller', async () => {
    const ddb = { send: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) };
    await expect(
      retireGatewayGrant({ ddb, tableName: 't' }, { grantId: 'grant-1' }),
    ).rejects.toThrow('AccessDenied');
  });

  it.each([[''], [42], ['x'.repeat(129)]])('rejects a malformed grant id %#', async (grantId) => {
    const ddb = memoryDdb();
    await expect(isGatewayGrantRetired({ ddb, tableName: 't' }, { grantId })).rejects.toMatchObject(
      { code: 'GATEWAY_GRANT_ID_INVALID' },
    );
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('wires the verifier seam and the retirer only when the table is configured', async () => {
    const ddb = memoryDdb();
    expect(gatewayGrantRetirementCheckFromEnv({ ddb, env: {} })).toBeNull();
    expect(gatewayGrantRetirerFromEnv({ ddb, env: {} })).toBeNull();
    expect(gatewayExecutionRetirerFromEnv({ ddb, env: {} })).toBeNull();
    expect(gatewayGrantIssuanceGuardFromEnv({ ddb, env: {} })).toBeNull();
    const env = {
      [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 'retired-grants',
      V2_PROCESS_TABLE: 'process',
    };
    const retire = gatewayGrantRetirerFromEnv({ ddb, env, now: () => NOW });
    const isRetired = gatewayGrantRetirementCheckFromEnv({ ddb, env });
    const token = await issue();
    await expect(verify(token, isRetired)).resolves.toMatchObject({ grantId: 'grant-1' });
    await retire({ grantId: 'grant-1' });
    await expect(verify(token, isRetired)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIRED',
    });
    expect(
      ddb.send.mock.calls.every(([c]) => ['retired-grants', 'process'].includes(c.input.TableName)),
    ).toBe(true);
  });
});

describe('gateway execution retirement', () => {
  it('keeps execution records apart from jti records', async () => {
    const ddb = memoryDdb();
    await retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' });
    expect([...ddb.items.keys()]).toEqual(['EXEC#e-1']);
    const record = ddb.items.get('EXEC#e-1');
    expect(record).toMatchObject({
      executionId: 'e-1',
      retiredAt: executionRetirementSecond(NOW),
      retirementReason: 'cancel',
    });
    expect(record.expiresAt - record.retiredAt).toBeGreaterThanOrEqual(
      GATEWAY_GRANT_MAX_TTL_SECONDS,
    );
    // A jti equal to the execution id names a different record.
    await expect(isGatewayGrantRetired({ ddb, tableName: 't' }, { grantId: 'e-1' })).resolves.toBe(
      false,
    );
  });

  it('retires every grant of the execution issued before the retirement, at each consumer seam', async () => {
    const ddb = memoryDdb();
    const isRetired = gatewayGrantRetirementCheckFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't', V2_PROCESS_TABLE: 'process' },
    });
    const stage = await issue(() => 'grant-stage', { at: NOW - 60_000 });
    const execution = await issue(() => 'grant-exec', {
      at: NOW - 1000,
      scope: { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' },
    });
    const otherExecution = await issue(() => 'grant-other', {
      at: NOW - 1000,
      scope: { ...stageScope, executionId: 'e-2' },
    });
    await retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' });
    for (const token of [stage, execution]) {
      await expect(verify(token, isRetired)).rejects.toMatchObject({
        code: 'GATEWAY_GRANT_RETIRED',
      });
    }
    await expect(verify(otherExecution, isRetired)).resolves.toMatchObject({
      grantId: 'grant-other',
    });
  });

  it('keeps a re-driven run’s grants, issued after the retirement, valid', async () => {
    const ddb = memoryDdb();
    const isRetired = gatewayGrantRetirementCheckFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't', V2_PROCESS_TABLE: 'process' },
    });
    await retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' });
    const { retiredAt } = ddb.items.get('EXEC#e-1');
    const redriven = await issue(() => 'grant-redrive', { at: (retiredAt + 1) * 1000 });
    await expect(
      verify(redriven, isRetired, { at: (retiredAt + 2) * 1000 }),
    ).resolves.toMatchObject({ grantId: 'grant-redrive' });
  });

  it('treats a grant issued in the retirement second, or within the skew allowance after it, as retired', async () => {
    const ddb = memoryDdb();
    const lookup = { ddb, tableName: 't', processTableName: 'process' };
    await retireGatewayExecution(store(ddb), { executionId: 'e-1' });
    const second = Math.floor(NOW / 1000);
    expect(executionRetirementSecond(NOW)).toBe(
      Math.floor((NOW + GATEWAY_GRANT_RETIREMENT_SKEW_MS) / 1000),
    );
    for (const issuedAt of [second - 1, second, executionRetirementSecond(NOW)]) {
      await expect(
        isGatewayGrantRetired(lookup, { grantId: 'g', executionId: 'e-1', issuedAt }),
      ).resolves.toBe(true);
    }
    await expect(
      isGatewayGrantRetired(lookup, {
        grantId: 'g',
        executionId: 'e-1',
        issuedAt: executionRetirementSecond(NOW) + 1,
      }),
    ).resolves.toBe(false);
  });

  it('still honours a jti retirement on its own', async () => {
    const ddb = memoryDdb();
    await retireGatewayGrant({ ddb, tableName: 't', now: () => NOW }, { grantId: 'grant-1' });
    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't', processTableName: 'process' },
        { grantId: 'grant-1', executionId: 'e-1', issuedAt: Math.floor(NOW / 1000) + 3600 },
      ),
    ).resolves.toBe(true);
  });

  it('reads META before the consistent grant and execution records', async () => {
    const ddb = memoryDdb();
    await isGatewayGrantRetired(
      { ddb, tableName: 't', processTableName: 'process' },
      { grantId: 'grant-1', executionId: 'e-1', issuedAt: 1 },
    );
    const inputs = ddb.send.mock.calls.map(([c]) => c.input);
    expect(inputs[0]).toEqual(
      expect.objectContaining({
        TableName: 'process',
        Key: { pk: 'EXEC#e-1', sk: 'META' },
        ConsistentRead: true,
        ProjectionExpression: 'pendingGrantRetirements',
      }),
    );
    expect(inputs.slice(1)).toEqual([
      expect.objectContaining({ Key: { pk: 'GRANT#grant-1' }, ConsistentRead: true }),
      expect.objectContaining({ Key: { pk: 'EXEC#e-1' }, ConsistentRead: true }),
    ]);
  });

  it('keeps a pending jti retired when recovery writes GRANT and clears META after its read', async () => {
    const ddb = memoryDdb();
    ddb.metas.set('EXEC#e-1', { pendingGrantRetirements: new Set(['grant-pending']) });
    const send = ddb.send.getMockImplementation();
    ddb.send.mockImplementation(async (command) => {
      const { input } = command;
      if (
        input.TableName === 'process' &&
        input.Key?.sk === 'META' &&
        input.ProjectionExpression === 'pendingGrantRetirements'
      ) {
        const response = await send(command);
        // Recovery persists the retirement then clears META after the read has
        // captured the pending jti, but before any retirement-table reads.
        ddb.items.set('GRANT#grant-pending', { pk: 'GRANT#grant-pending' });
        ddb.metas.set('EXEC#e-1', { pendingGrantRetirements: new Set() });
        return response;
      }
      return send(command);
    });

    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't', processTableName: 'process' },
        { grantId: 'grant-pending', executionId: 'e-1', issuedAt: 1 },
      ),
    ).resolves.toBe(true);
    expect(ddb.send.mock.calls.map(([command]) => command.input.TableName)).toEqual(['process']);
    expect(ddb.items.has('GRANT#grant-pending')).toBe(true);
    expect(ddb.metas.get('EXEC#e-1').pendingGrantRetirements.size).toBe(0);
  });

  it.each([
    ['a string set', new Set(['grant-a', 'grant-pending'])],
    ['a list', ['grant-pending']],
  ])('retires a jti META records as pending in %s and no other', async (_label, recorded) => {
    const ddb = memoryDdb();
    ddb.metas.set('EXEC#e-1', { status: 'FAILED', pendingGrantRetirements: recorded });
    const lookup = { ddb, tableName: 't', processTableName: 'process' };
    const issuedAt = Math.floor(NOW / 1000);
    await expect(
      isGatewayGrantRetired(lookup, { grantId: 'grant-pending', executionId: 'e-1', issuedAt }),
    ).resolves.toBe(true);
    await expect(
      isGatewayGrantRetired(lookup, { grantId: 'grant-other', executionId: 'e-1', issuedAt }),
    ).resolves.toBe(false);
    // Another execution's META never retires this execution's grant.
    await expect(
      isGatewayGrantRetired(lookup, { grantId: 'grant-pending', executionId: 'e-2', issuedAt }),
    ).resolves.toBe(false);
  });

  it('denies a pending jti at the consumer seam and fails closed when META cannot be read', async () => {
    const ddb = memoryDdb();
    ddb.metas.set('EXEC#e-1', { pendingGrantRetirements: new Set(['grant-1']) });
    const isRetired = gatewayGrantRetirementCheckFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't', V2_PROCESS_TABLE: 'process' },
    });
    await expect(verify(await issue(), isRetired)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIRED',
    });
    ddb.metas.clear();
    await expect(verify(await issue(), isRetired)).resolves.toMatchObject({ grantId: 'grant-1' });
    const send = ddb.send.getMockImplementation();
    ddb.send.mockImplementation(async (command) => {
      if (command.input.TableName === 'process') throw new Error('ThrottlingException');
      return send(command);
    });
    await expect(verify(await issue(), isRetired)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE',
    });
  });

  it('fails closed on an execution grant without the process table', async () => {
    const ddb = memoryDdb();
    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't' },
        { grantId: 'g', executionId: 'e-1', issuedAt: 1 },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_RETIREMENT_PROCESS_TABLE_MISSING' });
    const isRetired = gatewayGrantRetirementCheckFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't' },
    });
    await expect(verify(await issue(), isRetired)).rejects.toMatchObject({
      code: 'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE',
    });
    expect(ddb.send).not.toHaveBeenCalled();
    // A discussion grant names no execution and needs no process table.
    const discussion = await issue(() => 'grant-d', {
      scope: { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' },
    });
    await expect(verify(discussion, isRetired)).resolves.toMatchObject({ grantId: 'grant-d' });
  });

  it.each([
    ['a non-numeric retiredAt', { retiredAt: 'later' }, true],
    ['a record without retiredAt', {}, false],
  ])('handles %s', async (_label, record, expected) => {
    const ddb = memoryDdb();
    ddb.items.set('EXEC#e-1', { pk: 'EXEC#e-1', ...record });
    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't', processTableName: 'process' },
        { grantId: 'g', executionId: 'e-1', issuedAt: 1 },
      ),
    ).resolves.toBe(expected);
  });

  it('rejects a malformed execution claim before reading', async () => {
    const ddb = memoryDdb();
    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't', processTableName: 'process' },
        { grantId: 'g', executionId: 'e-1' },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_ISSUED_AT_INVALID' });
    await expect(
      isGatewayGrantRetired(
        { ddb, tableName: 't', processTableName: 'process' },
        { grantId: 'g', executionId: 'x'.repeat(129), issuedAt: 1 },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_EXECUTION_ID_INVALID' });
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('is idempotent and keeps the latest retirement', async () => {
    const ddb = memoryDdb();
    const later = NOW + 30_000;
    await retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' });
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' }),
    ).resolves.toMatchObject({ retired: true, alreadyRetired: true });
    await expect(
      retireGatewayExecution(
        store(ddb, () => later),
        { executionId: 'e-1', reason: 'failed' },
      ),
    ).resolves.toMatchObject({ retired: true, alreadyRetired: false });
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', reason: 'cancel' }),
    ).resolves.toMatchObject({ alreadyRetired: true });
    expect(ddb.items.get('EXEC#e-1')).toMatchObject({
      retiredAt: executionRetirementSecond(later),
      retirementReason: 'failed',
    });
    const update = ddb.send.mock.calls[0][0].input;
    expect(update.ConditionExpression).toBe(
      'attribute_not_exists(retiredAt) OR retiredAt < :retiredAt',
    );
  });

  it('writes a run-conditional retirement only while the run still owns the execution', async () => {
    const ddb = memoryDdb();
    ddb.runs.set('e-1', 'run-1');
    await expect(
      retireGatewayExecution(store(ddb), {
        executionId: 'e-1',
        reason: 'succeeded',
        ifOrchestratorRunId: 'run-1',
      }),
    ).resolves.toMatchObject({ retired: true, alreadyRetired: false });
    const [{ ConditionCheck }] = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(ConditionCheck).toMatchObject({
      TableName: 'process',
      Key: { pk: 'EXEC#e-1', sk: 'META' },
    });

    ddb.items.clear();
    ddb.runs.set('e-1', 'run-2');
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: 'run-1' }),
    ).resolves.toEqual({ retired: false, superseded: true, retiredAt: null });
    expect(ddb.items.size).toBe(0);

    ddb.runs.delete('e-1');
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: null }),
    ).resolves.toMatchObject({ retired: true });
  });

  it('fences "no run" so a fresh intent (orchestratorRunId stored as NULL) still matches', async () => {
    const ddb = memoryDdb();
    ddb.runs.set('e-1', null);
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: null }),
    ).resolves.toMatchObject({ retired: true, alreadyRetired: false });
    ddb.runs.set('e-1', 'run-1');
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: null }),
    ).resolves.toMatchObject({ retired: false, superseded: true });
  });

  it('matches the META row buildExecutionMeta actually persists, through the marshaller', async () => {
    const ddb = memoryDdb();
    await retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: null });
    const [{ ConditionCheck: check }] = ddb.send.mock.calls[0][0].input.TransactItems;
    const meta = buildExecutionMeta({
      executionId: 'e-1',
      projectId: 'p-1',
      intentId: 'e-1',
      status: 'DRAFT',
      workflowId: 'aidlc-v2',
      workflowVersion: 4,
      scope: 'feature',
      startedAt: '2026-01-01T00:00:00.000Z',
      startedBy: 'u-1',
      now: '2026-01-01T00:00:00.000Z',
    });
    const stored = marshall(meta, { removeUndefinedValues: true });
    // DynamoDB keeps the null: the attribute EXISTS, typed NULL.
    expect(stored.orchestratorRunId).toEqual({ NULL: true });
    const values = marshall(check.ExpressionAttributeValues ?? {});
    expect(evaluateCondition(check.ConditionExpression, { item: stored, values })).toBe(true);
    expect(
      evaluateCondition('attribute_not_exists(orchestratorRunId)', { item: stored, values }),
    ).toBe(false);
    expect(
      evaluateCondition(check.ConditionExpression, {
        item: marshall({ ...meta, orchestratorRunId: 'run-1' }, { removeUndefinedValues: true }),
        values,
      }),
    ).toBe(false);
    expect(evaluateCondition(check.ConditionExpression, { item: null, values })).toBe(false);
  });

  it('treats an earlier-or-equal run-conditional retirement as already retired', async () => {
    const ddb = memoryDdb();
    ddb.runs.set('e-1', 'run-1');
    await retireGatewayExecution(store(ddb), { executionId: 'e-1' });
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: 'run-1' }),
    ).resolves.toMatchObject({ retired: true, alreadyRetired: true });
  });

  it('refuses a run-conditional retirement without the process table', async () => {
    const ddb = memoryDdb();
    await expect(
      retireGatewayExecution(
        { ddb, tableName: 't', now: () => NOW },
        { executionId: 'e-1', ifOrchestratorRunId: 'run-1' },
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_RETIREMENT_PROCESS_TABLE_MISSING' });
  });

  it('surfaces other write failures to the caller', async () => {
    const ddb = { send: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) };
    await expect(retireGatewayExecution(store(ddb), { executionId: 'e-1' })).rejects.toThrow(
      'AccessDenied',
    );
    await expect(
      retireGatewayExecution(store(ddb), { executionId: 'e-1', ifOrchestratorRunId: 'r' }),
    ).rejects.toThrow('AccessDenied');
  });

  it('wires the execution retirer with the process table from the environment', async () => {
    const ddb = memoryDdb();
    ddb.runs.set('e-1', 'run-1');
    const retire = gatewayExecutionRetirerFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't', V2_PROCESS_TABLE: 'process' },
      now: () => NOW,
    });
    await expect(
      retire({ executionId: 'e-1', ifOrchestratorRunId: 'run-1' }),
    ).resolves.toMatchObject({ retired: true });
  });
});

describe('grant issuance after an execution retirement', () => {
  it('waits until the issuing clock is past the retirement second', async () => {
    const ddb = memoryDdb();
    await retireGatewayExecution(store(ddb), { executionId: 'e-1' });
    const { retiredAt } = ddb.items.get('EXEC#e-1');
    const sleep = vi.fn(async () => {});
    await expect(
      awaitGrantIssuanceAfterRetirement({ ddb, tableName: 't', now: () => NOW, sleep }, 'e-1'),
    ).resolves.toEqual({ retiredAt, waitedMs: (retiredAt + 1) * 1000 - NOW, bounded: false });
    expect(sleep).toHaveBeenCalledWith((retiredAt + 1) * 1000 - NOW);
    // The first grant signed after the wait is live.
    const token = await issue(() => 'grant-next', { at: (retiredAt + 1) * 1000 });
    const isRetired = gatewayGrantRetirementCheckFromEnv({
      ddb,
      env: { [GATEWAY_GRANT_RETIREMENT_TABLE_ENV]: 't', V2_PROCESS_TABLE: 'process' },
    });
    await expect(
      verify(token, isRetired, { at: (retiredAt + 1) * 1000 + 10 }),
    ).resolves.toMatchObject({ grantId: 'grant-next' });
  });

  it('does not wait without a retirement or once the clock is past it', async () => {
    const ddb = memoryDdb();
    const sleep = vi.fn(async () => {});
    const options = { ddb, tableName: 't', sleep };
    await expect(
      awaitGrantIssuanceAfterRetirement({ ...options, now: () => NOW }, 'e-1'),
    ).resolves.toMatchObject({ retiredAt: null, waitedMs: 0 });
    await retireGatewayExecution(store(ddb), { executionId: 'e-1' });
    await expect(
      awaitGrantIssuanceAfterRetirement({ ...options, now: () => NOW + 10_000 }, 'e-1'),
    ).resolves.toMatchObject({ waitedMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('bounds the wait for a retirement far in the future', async () => {
    const ddb = memoryDdb();
    await retireGatewayExecution(
      store(ddb, () => NOW + 3_600_000),
      { executionId: 'e-1' },
    );
    const sleep = vi.fn(async () => {});
    const result = await awaitGrantIssuanceAfterRetirement(
      { ddb, tableName: 't', now: () => NOW, sleep },
      'e-1',
    );
    expect(result.bounded).toBe(true);
    expect(result.waitedMs).toBeLessThanOrEqual(1000 + GATEWAY_GRANT_RETIREMENT_SKEW_MS + 500);
  });
});

describe('pendingGrantRetirementIds', () => {
  it('reads the string set (or an array) of unretired jtis off META, dropping invalid ids', async () => {
    const { pendingGrantRetirementIds } = await import('../gateway-grant-retirement.js');
    expect(pendingGrantRetirementIds({ pendingGrantRetirements: new Set(['j1', 'j2']) })).toEqual([
      'j1',
      'j2',
    ]);
    expect(
      pendingGrantRetirementIds({ pendingGrantRetirements: ['j1', 'j1', '', 'x'.repeat(200)] }),
    ).toEqual(['j1']);
    expect(pendingGrantRetirementIds({})).toEqual([]);
    expect(pendingGrantRetirementIds(null)).toEqual([]);
  });
});
