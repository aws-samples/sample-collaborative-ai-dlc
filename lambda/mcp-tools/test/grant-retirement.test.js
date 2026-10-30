import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import {
  isGatewayGrantRetired,
  retireGatewayExecution,
  retireGatewayGrant,
} from '../../shared/gateway-grant-retirement.js';
import { encodeGatewaySession } from '../../shared/mcp/gateway-session.js';
import { createToolGateway } from '../tool-gateway.js';

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
  const writer = { getArtifact: vi.fn(async ({ id }) => ({ id })) };
  const audit = vi.fn();
  const handler = createToolGateway({
    verifyGrant: (token) =>
      verifyGatewayGrant(token, {
        publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
        now: () => NOW + 1000,
        isRetired:
          isRetired ??
          ((claims) =>
            isGatewayGrantRetired({ ddb, tableName: 't', processTableName: 'proc' }, claims)),
      }),
    createStore: () => ({
      getExecution: async () => ({
        executionId: 'e-1',
        projectId: 'p-1',
        intentId: 'i-1',
        status: 'RUNNING',
      }),
      getStage: async () => ({
        executionId: 'e-1',
        stageInstanceId: 'si-1',
        stageId: 'requirements-analysis',
        unitSlug: null,
        sectionIndex: null,
        state: 'RUNNING',
      }),
    }),
    openGraph: async () => {
      const chain = { has: () => chain, hasNext: async () => true };
      return { V: () => chain };
    },
    closeGraphSource: async () => {},
    createGraphWriter: () => writer,
    createGraphManager: () => ({ withWriter: (fn) => fn(writer), close: async () => {} }),
    createProcessBridge: () => ({ rehydrateAuthorizations: async () => {} }),
    broadcastToIntent: async () => {},
    processTable: 'proc',
    audit,
  });
  return { ddb, writer, audit, handler };
};

const grant = (jti, at = NOW) =>
  issueGatewayGrant(STAGE, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => at,
    randomId: () => jti,
  });
const call = (handler, token) =>
  handler(
    { id: 'a-1' },
    {
      clientContext: {
        custom: {
          bedrockAgentCoreToolName: 'aidlc___get_artifact',
          bedrockAgentCorePropagatedHeaders: { 'x-aidlc-grant': token, 'x-aidlc-session': SESSION },
        },
      },
    },
  );

describe('MCP tools end-of-stage grant retirement', () => {
  it('serves a live grant and denies it once the orchestrator retires it', async () => {
    const { ddb, writer, audit, handler } = setup();
    const token = await grant('grant-live');
    expect((await call(handler, token)).isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalledTimes(1);

    await retireGatewayGrant({ ddb, tableName: 't', now: () => NOW }, { grantId: 'grant-live' });
    const denied = await call(handler, token);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/^Tool call denied/);
    expect(writer.getArtifact).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'grant_invalid' }),
    );
  });

  it('denies a grant whose exhausted retirement is recorded on META and serves any other', async () => {
    const { ddb, writer, audit, handler } = setup();
    ddb.metas.set('EXEC#e-1', {
      pk: 'EXEC#e-1',
      sk: 'META',
      status: 'FAILED',
      pendingGrantRetirements: new Set(['grant-pending']),
    });
    const denied = await call(handler, await grant('grant-pending'));
    expect(denied.isError).toBe(true);
    expect(writer.getArtifact).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny' }));

    expect((await call(handler, await grant('grant-other'))).isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the retirement lookup fails', async () => {
    const { writer, handler } = setup({
      isRetired: async () => {
        throw new Error('ThrottlingException');
      },
    });
    expect((await call(handler, await grant('grant-live'))).isError).toBe(true);
    expect(writer.getArtifact).not.toHaveBeenCalled();
  });

  it('denies a grant issued before its execution was retired and serves a re-driven run’s grant', async () => {
    const { ddb, writer, audit, handler } = setup();
    const before = await grant('grant-before-cancel');
    const { retiredAt } = await retireGatewayExecution(
      { ddb, tableName: 't', now: () => NOW },
      { executionId: 'e-1', reason: 'cancelled' },
    );
    const denied = await call(handler, before);
    expect(denied.isError).toBe(true);
    expect(writer.getArtifact).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny' }));

    const redriven = await grant('grant-redrive', (retiredAt + 1) * 1000);
    expect((await call(handler, redriven)).isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalledTimes(1);
  });
});
