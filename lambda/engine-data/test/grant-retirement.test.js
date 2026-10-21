import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import {
  isGatewayGrantRetired,
  retireGatewayExecution,
  retireGatewayGrant,
} from '../../shared/gateway-grant-retirement.js';
import { createStoreGateway } from '../store-gateway.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const STAGE_GRANT = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  stageCallbackId: 'cb-1',
  orchestratorRunId: 'run-1',
};
const META = {
  executionId: 'e-1',
  projectId: 'p-1',
  intentId: 'i-1',
  status: 'RUNNING',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
};

// The retirement table plus the process table's META rows ('proc').
const retirementTable = () => {
  const items = new Map();
  const metas = new Map();
  return {
    metas,
    send: vi.fn(async ({ input }) => {
      if (input.Item) {
        if (items.has(input.Item.pk)) {
          throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        }
        items.set(input.Item.pk, input.Item);
        return {};
      }
      if (input.UpdateExpression) {
        items.set(input.Key.pk, {
          pk: input.Key.pk,
          retiredAt: input.ExpressionAttributeValues[':retiredAt'],
        });
        return {};
      }
      if (input.TableName === 'proc') return { Item: metas.get(input.Key.pk) };
      return { Item: items.get(input.Key.pk) };
    }),
  };
};

const setup = ({ isRetired } = {}) => {
  const ddb = retirementTable();
  const check =
    isRetired ??
    ((claims) => isGatewayGrantRetired({ ddb, tableName: 't', processTableName: 'proc' }, claims));
  const store = {
    getExecution: vi.fn(async () => META),
    appendEvent: vi.fn(async () => ({ ok: true })),
  };
  const audit = vi.fn();
  const handler = createStoreGateway({
    verifyGrant: (token) =>
      verifyGatewayGrant(token, {
        publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
        now: () => NOW + 1000,
        isRetired: check,
      }),
    createStore: () => store,
    audit,
  });
  return { ddb, store, audit, handler };
};

const grant = (jti, { at = NOW, scope = STAGE_GRANT } = {}) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => at,
    randomId: () => jti,
  });
const write = (token) => ({
  op: 'store.appendEvent',
  grant: token,
  args: [{ executionId: 'e-1', type: 'v2.stage.note', summary: 'progress' }],
});

describe('engine-data end-of-stage grant retirement', () => {
  it('serves writes before the stage callback and denies them once the grant is retired', async () => {
    const { ddb, store, audit, handler } = setup();
    const token = await grant('grant-live');
    await expect(handler(write(token))).resolves.toMatchObject({ ok: true });
    expect(store.appendEvent).toHaveBeenCalledTimes(1);

    await retireGatewayGrant({ ddb, tableName: 't', now: () => NOW }, { grantId: 'grant-live' });
    await expect(handler(write(token))).resolves.toMatchObject({
      error: { code: 'grant_retired' },
    });
    expect(store.appendEvent).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'grant_retired' }),
    );
  });

  it('keeps serving a fresh grant for the same stage after an earlier one is retired', async () => {
    const { ddb, store, handler } = setup();
    await retireGatewayGrant({ ddb, tableName: 't', now: () => NOW }, { grantId: 'grant-parked' });
    await expect(handler(write(await grant('grant-resumed')))).resolves.toMatchObject({ ok: true });
    expect(store.appendEvent).toHaveBeenCalledTimes(1);
  });

  it('denies a grant whose exhausted retirement is recorded on META and serves any other', async () => {
    const { ddb, store, audit, handler } = setup();
    ddb.metas.set('EXEC#e-1', {
      pk: 'EXEC#e-1',
      sk: 'META',
      status: 'FAILED',
      pendingGrantRetirements: new Set(['grant-pending']),
    });
    await expect(handler(write(await grant('grant-pending')))).resolves.toMatchObject({
      error: { code: 'grant_retired' },
    });
    expect(store.appendEvent).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'grant_retired' }),
    );

    await expect(handler(write(await grant('grant-other')))).resolves.toMatchObject({ ok: true });
    expect(store.appendEvent).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the process table cannot be read', async () => {
    const { ddb, store, handler } = setup();
    const send = ddb.send.getMockImplementation();
    ddb.send.mockImplementation(async (command) => {
      if (command.input.TableName === 'proc') throw new Error('ThrottlingException');
      return send(command);
    });
    await expect(handler(write(await grant('grant-live')))).resolves.toMatchObject({
      error: { code: 'grant_retirement_unavailable' },
    });
    expect(store.appendEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the retirement lookup fails', async () => {
    const { store, handler } = setup({
      isRetired: async () => {
        throw new Error('ThrottlingException');
      },
    });
    await expect(handler(write(await grant('grant-live')))).resolves.toMatchObject({
      error: { code: 'grant_retirement_unavailable' },
    });
    expect(store.getExecution).not.toHaveBeenCalled();
    expect(store.appendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['stage', STAGE_GRANT],
    ['execution', { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' }],
  ])(
    'denies a %s grant issued before its execution was retired and serves a re-driven run’s grant',
    async (_mode, scope) => {
      const { ddb, store, audit, handler } = setup();
      const before = await grant('grant-before-cancel', { scope });
      const { retiredAt } = await retireGatewayExecution(
        { ddb, tableName: 't', now: () => NOW },
        { executionId: 'e-1', reason: 'cancelled' },
      );
      await expect(handler(write(before))).resolves.toMatchObject({
        error: { code: 'grant_retired' },
      });
      expect(store.appendEvent).not.toHaveBeenCalled();
      expect(audit).toHaveBeenLastCalledWith(
        expect.objectContaining({ decision: 'deny', reason: 'grant_retired' }),
      );

      const redriven = await grant('grant-redrive', { at: (retiredAt + 1) * 1000, scope });
      await expect(handler(write(redriven))).resolves.toMatchObject({ ok: true });
      expect(store.appendEvent).toHaveBeenCalledTimes(1);
    },
  );
});
