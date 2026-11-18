import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createBlobGateway } from '../blob-gateway.js';
import { createRealtimeGateway } from '../realtime-gateway.js';
import { createStoreGateway } from '../store-gateway.js';

// Rewind, recompose and lane repair replace META's orchestratorRunId; the graph
// namespace's run_retired check is covered in graph-gateway.test.js.
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const STAGE = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  stageCallbackId: 'cb-1',
  orchestratorRunId: 'run-old',
};
const metaFor = (orchestratorRunId) => ({
  executionId: 'e-1',
  projectId: 'p-1',
  intentId: 'i-1',
  status: 'RUNNING',
  orchestratorRunId,
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  customRules: [],
  attachments: [],
});

const grant = () =>
  issueGatewayGrant(STAGE, {
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
const storeWith = (orchestratorRunId) => ({
  getExecution: vi.fn(async () => metaFor(orchestratorRunId)),
  getStage: vi.fn(async () => null),
  appendEvent: vi.fn(async () => ({ eventId: 'ev-1' })),
  listEvents: vi.fn(async () => []),
});

const NAMESPACES = {
  store: (store) => ({
    handler: createStoreGateway({ verifyGrant, createStore: () => store }),
    calls: [
      { op: 'store.appendEvent', args: [{ executionId: 'e-1', type: 'v2.stage.note' }] },
      { op: 'store.listEvents', args: ['e-1'] },
    ],
  }),
  blob: (store) => ({
    handler: createBlobGateway({
      verifyGrant,
      createStore: () => store,
      s3: { send: vi.fn() },
      bucket: 'b',
    }),
    calls: [{ op: 'blob.readCustomRules', args: [{}] }],
  }),
  realtime: (store) => ({
    handler: createRealtimeGateway({
      verifyGrant,
      createStore: () => store,
      withGraph: vi.fn(),
      ddb: { send: vi.fn(async () => ({ Items: [] })) },
      api: { send: vi.fn() },
      connectionsTable: 'connections',
    }),
    calls: [
      {
        op: 'realtime.broadcastIntent',
        args: [{ payload: { action: 'agent.stage', intentId: 'i-1', state: 'RUNNING' } }],
      },
    ],
  }),
};

describe('engine-data refuses a stage grant whose run was replaced', () => {
  it.each(Object.keys(NAMESPACES))(
    '%s: serves the current run, refuses a replaced one',
    async (ns) => {
      const token = await grant();
      const current = storeWith('run-old');
      const replaced = storeWith('run-new');
      const live = NAMESPACES[ns](current);
      const stale = NAMESPACES[ns](replaced);
      for (const call of live.calls) {
        await expect(live.handler({ ...call, grant: token })).resolves.toMatchObject({ ok: true });
        await expect(stale.handler({ ...call, grant: token })).resolves.toMatchObject({
          error: { code: 'run_retired' },
        });
      }
      expect(replaced.appendEvent).not.toHaveBeenCalled();
      expect(replaced.listEvents).not.toHaveBeenCalled();
    },
  );
});
