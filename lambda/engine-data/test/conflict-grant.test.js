import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createBlobGateway } from '../blob-gateway.js';
import { createGraphGateway } from '../graph-gateway.js';
import { createRealtimeGateway } from '../realtime-gateway.js';
import { createStoreGateway } from '../store-gateway.js';

// A conflict grant runs resolve-conflict for one unit lane. Its engine-data use
// is the auth resolver's META read, the lane's events and its CLI spend metric,
// and the lane's agent.unit / agent.metric broadcasts; nothing else.
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const CONFLICT = {
  mode: 'conflict',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  unitSlug: 'api',
  sectionIndex: 0,
};
const META = {
  executionId: 'e-1',
  projectId: 'p-1',
  intentId: 'i-1',
  status: 'RUNNING',
  orchestratorRunId: 'run-1',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  customRules: [],
  attachments: [],
};

const grantFor = (scope = CONFLICT) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
  });

const fakeStore = () => ({
  getExecution: vi.fn(async () => META),
  getStage: vi.fn(async () => null),
  getCompose: vi.fn(async () => null),
  getQuorumEdit: vi.fn(async () => null),
  appendEvent: vi.fn(async () => ({ eventId: 'ev-1' })),
  recordMetric: vi.fn(async () => ({ metricId: 'm-1' })),
  updateExecution: vi.fn(async () => META),
  updateStageState: vi.fn(async () => ({})),
  putReceipt: vi.fn(async () => ({})),
  listEvents: vi.fn(async () => []),
});

const denied = (code) => expect.objectContaining({ error: expect.objectContaining({ code }) });

describe('engine-data conflict grants', () => {
  const storeCall = async (method, args, scope) => {
    const store = fakeStore();
    const handler = createStoreGateway({ verifyGrant, createStore: () => store });
    return {
      store,
      result: await handler({ op: `store.${method}`, args, grant: await grantFor(scope) }),
    };
  };
  const event = (overrides = {}) => ({
    executionId: 'e-1',
    type: 'v2.conflict.resolving',
    unitSlug: 'api',
    sectionIndex: 0,
    actor: 'agentcore',
    summary: 'resolving',
    ...overrides,
  });
  const metric = (overrides = {}) => ({
    executionId: 'e-1',
    stageInstanceId: null,
    unitSlug: 'api',
    sectionIndex: 0,
    metrics: { tokensIn: 3 },
    resolvedModel: 'model',
    ...overrides,
  });

  it('serves the calls resolve-conflict makes for its own lane', async () => {
    for (const [method, args] of [
      ['getExecution', ['e-1', { consistentRead: true }]],
      ['appendEvent', [event()]],
      ['recordMetric', [metric()]],
    ]) {
      const { store, result } = await storeCall(method, args);
      expect(result).toMatchObject({ ok: true });
      expect(store[method]).toHaveBeenCalledWith(...args);
    }
  });

  it('refuses execution, stage and checkpoint writes', async () => {
    const { store, result } = await storeCall('updateExecution', [
      { executionId: 'e-1', status: 'SUCCEEDED' },
    ]);
    expect(result).toEqual(denied('op_not_allowed'));
    expect(store.updateExecution).not.toHaveBeenCalled();
    for (const [method, args] of [
      ['updateStageState', [{ executionId: 'e-1', stageInstanceId: 'si-1', state: 'SUCCEEDED' }]],
      ['putReceipt', [{ executionId: 'e-1', stageInstanceId: 'si-1', kind: 'approval' }]],
      ['listEvents', ['e-1']],
    ]) {
      expect((await storeCall(method, args)).result).toEqual(denied('op_not_allowed'));
    }
  });

  it('refuses events and metrics for another lane, a stage, or no lane', async () => {
    for (const input of [
      event({ unitSlug: 'web' }),
      event({ sectionIndex: 1 }),
      event({ unitSlug: undefined }),
      event({ sectionIndex: undefined }),
      event({ sectionIndex: null }),
      event({ stageInstanceId: 'si-1' }),
    ]) {
      const { store, result } = await storeCall('appendEvent', [input]);
      expect(result).toEqual(denied('scope_mismatch'));
      expect(store.appendEvent).not.toHaveBeenCalled();
    }
    for (const input of [
      metric({ unitSlug: 'web' }),
      metric({ sectionIndex: undefined }),
      metric({ stageInstanceId: 'si-1' }),
    ]) {
      const { store, result } = await storeCall('recordMetric', [input]);
      expect(result).toEqual(denied('scope_mismatch'));
      expect(store.recordMetric).not.toHaveBeenCalled();
    }
  });

  it('refuses every graph operation, reads and mutations alike, without opening the graph', async () => {
    const withGraph = vi.fn(async () => {
      throw new Error('graph must not be opened');
    });
    const handler = createGraphGateway({ verifyGrant, createStore: fakeStore, withGraph });
    for (const op of [
      'getIntentGraph',
      'updateArtifact',
      'markArtifactsStale',
      'getArtifactContent',
    ]) {
      await expect(
        handler({ op: `graph.${op}`, args: [{}, {}], grant: await grantFor() }),
      ).resolves.toEqual(denied('op_not_allowed'));
    }
    expect(withGraph).not.toHaveBeenCalled();
  });

  it('refuses execution-owned objects', async () => {
    const s3 = { send: vi.fn() };
    const handler = createBlobGateway({ verifyGrant, createStore: fakeStore, s3, bucket: 'b' });
    for (const [op, input] of [
      ['readCustomRules', {}],
      ['pinCustomRuleVersions', {}],
      ['readAttachmentChunk', { attachmentId: 'a-1', offset: 0 }],
    ]) {
      await expect(
        handler({ op: `blob.${op}`, args: [input], grant: await grantFor() }),
      ).resolves.toEqual(denied('op_not_allowed'));
    }
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('broadcasts only its lane’s unit and metric events', async () => {
    const ddb = { send: vi.fn(async () => ({ Items: [] })) };
    const handler = createRealtimeGateway({
      verifyGrant,
      createStore: fakeStore,
      withGraph: vi.fn(),
      ddb,
      api: { send: vi.fn() },
      connectionsTable: 'connections',
    });
    const broadcast = async (payload) =>
      handler({
        op: 'realtime.broadcastIntent',
        args: [{ payload: { intentId: 'i-1', projectId: 'p-1', executionId: 'e-1', ...payload } }],
        grant: await grantFor(),
      });
    await expect(
      broadcast({ action: 'agent.unit', unitSlug: 'api', sectionIndex: 0, state: 'RESOLVING' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      broadcast({ action: 'agent.metric', unitSlug: 'api', sectionIndex: 0, metricId: 'm-1' }),
    ).resolves.toMatchObject({ ok: true });
    expect(ddb.send).toHaveBeenCalledTimes(2);

    await expect(
      broadcast({ action: 'agent.unit', unitSlug: 'web', sectionIndex: 0, state: 'RESOLVING' }),
    ).resolves.toEqual(denied('scope_mismatch'));
    await expect(
      broadcast({ action: 'agent.unit', unitSlug: 'api', state: 'RESOLVING' }),
    ).resolves.toEqual(denied('scope_mismatch'));
    await expect(
      broadcast({ action: 'agent.metric', unitSlug: 'api', sectionIndex: 0, stageInstanceId: 's' }),
    ).resolves.toEqual(denied('scope_mismatch'));
    await expect(broadcast({ action: 'agent.execution', status: 'SUCCEEDED' })).resolves.toEqual(
      denied('op_not_allowed'),
    );
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });
});
