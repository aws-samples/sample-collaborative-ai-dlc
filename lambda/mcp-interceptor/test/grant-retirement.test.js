import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import {
  isGatewayGrantRetired,
  retireGatewayExecution,
  retireGatewayGrant,
} from '../../shared/gateway-grant-retirement.js';
import { encodeGatewaySession } from '../../shared/mcp/gateway-session.js';
import { createGatewayAuthorizer } from '../../shared/mcp/gateway-authorization.js';
import { createGatewayInterceptor } from '../interceptor.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const STAGE = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
};
const SESSION = encodeGatewaySession({ role: 'author', stageInstanceId: 'si-1' });

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
  const store = {
    getExecution: vi.fn(async () => ({
      executionId: 'e-1',
      projectId: 'p-1',
      intentId: 'i-1',
      status: 'RUNNING',
    })),
    getStage: vi.fn(async () => ({
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      stageId: 'requirements-analysis',
      unitSlug: null,
      sectionIndex: null,
      state: 'RUNNING',
    })),
  };
  const chain = { has: () => chain, hasNext: async () => true };
  const audit = vi.fn();
  const handler = createGatewayInterceptor({
    authorizer: createGatewayAuthorizer({
      verifyGrant: (token) =>
        verifyGatewayGrant(token, {
          publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
          now: () => NOW + 1000,
          isRetired:
            isRetired ??
            ((claims) =>
              isGatewayGrantRetired({ ddb, tableName: 't', processTableName: 'proc' }, claims)),
        }),
      createStore: () => store,
      openGraph: async () => ({ V: () => chain }),
      closeGraphSource: async () => {},
      processTable: 'proc',
    }),
    audit,
  });
  return { ddb, store, audit, handler };
};

const grant = (jti, at = NOW) =>
  issueGatewayGrant(STAGE, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => at,
    randomId: () => jti,
  });

const request = (handler, token, body) =>
  handler(
    {
      interceptorInputVersion: '1.0',
      mcp: {
        gatewayRequest: {
          path: '/mcp',
          httpMethod: 'POST',
          headers: { 'x-aidlc-grant': token, 'x-aidlc-session': SESSION },
          body,
        },
      },
    },
    { awsRequestId: 'req-1' },
  );
const call = (handler, token) =>
  request(handler, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'aidlc___get_artifact', arguments: { id: 'a-1' } },
  });

// A forwarded request reaches the target; a denial is answered by the Gateway.
const forwarded = (output) => output.mcp.transformedGatewayRequest !== undefined;
const deniedAs = (output, reason) => {
  expect(output.mcp.transformedGatewayRequest).toBeUndefined();
  expect(output.mcp.transformedGatewayResponse.body.error).toMatchObject({ message: reason });
};

describe('MCP Gateway interceptor grant retirement', () => {
  it('forwards a live grant and denies it once the orchestrator retires it', async () => {
    const { ddb, audit, handler } = setup();
    const token = await grant('grant-live');
    expect(forwarded(await call(handler, token))).toBe(true);

    await retireGatewayGrant({ ddb, tableName: 't', now: () => NOW }, { grantId: 'grant-live' });
    deniedAs(await call(handler, token), 'grant_invalid');
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'grant_invalid' }),
    );
    deniedAs(
      await request(handler, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      'grant_invalid',
    );
  });

  it('denies a grant whose exhausted retirement is recorded on META and forwards any other', async () => {
    const { ddb, store, audit, handler } = setup();
    ddb.metas.set('EXEC#e-1', {
      pk: 'EXEC#e-1',
      sk: 'META',
      status: 'FAILED',
      pendingGrantRetirements: new Set(['grant-pending']),
    });
    deniedAs(await call(handler, await grant('grant-pending')), 'grant_invalid');
    expect(store.getExecution).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny' }));

    expect(forwarded(await call(handler, await grant('grant-other')))).toBe(true);
  });

  it('fails closed when the retirement lookup fails', async () => {
    const { store, handler } = setup({
      isRetired: async () => {
        throw new Error('ThrottlingException');
      },
    });
    deniedAs(await call(handler, await grant('grant-live')), 'grant_invalid');
    expect(store.getExecution).not.toHaveBeenCalled();
  });

  it('fails closed when the retirement table read fails', async () => {
    const { ddb, store, handler } = setup();
    ddb.send.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    deniedAs(await call(handler, await grant('grant-live')), 'grant_invalid');
    expect(store.getExecution).not.toHaveBeenCalled();
  });

  it('denies a grant issued before its execution was retired and forwards a re-driven run’s grant', async () => {
    const { ddb, store, audit, handler } = setup();
    const before = await grant('grant-before-cancel');
    const { retiredAt } = await retireGatewayExecution(
      { ddb, tableName: 't', now: () => NOW },
      { executionId: 'e-1', reason: 'cancelled' },
    );
    deniedAs(await call(handler, before), 'grant_invalid');
    expect(store.getExecution).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny' }));

    const redriven = await grant('grant-redrive', (retiredAt + 1) * 1000);
    expect(forwarded(await call(handler, redriven))).toBe(true);
  });
});
