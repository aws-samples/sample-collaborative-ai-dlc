import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { __durableHandler } from './fixtures/completion-handler.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import {
  isGatewayGrantRetired,
  retireGatewayGrant,
} from '../../shared/gateway-grant-retirement.js';
import { createStoreGateway } from '../../engine-data/store-gateway.js';

// Fail-closed Gateway grant retirement on the REAL durable runner: a failed
// retirement write is a thrown step that the SDK retries with backoff (never a
// checkpointed "done"), the stage does not settle until the write lands, and
// exhausted retries fail the stage through the normal failure path. Time is
// skipped so the backoff does not slow the suite.

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
};

// `retireGrant(retirement, call)` decides the outcome of the stage grant
// retirements (`call` counts them); synchronous command grants are retired
// unless `retireSyncGrant` says otherwise.
const makeWorld = ({ retireGrant, retireSyncGrant = () => ({ retired: true }) }) => {
  const world = {
    invokes: [],
    statusWrites: [],
    retirements: [],
    syncRetirements: [],
    pending: [],
    stageRowFailures: [],
    timeline: [],
    executionRetirements: [],
  };
  world.deps = {
    store: {
      getExecution: async () => ({ ...META }),
      updateExecution: async (input) => {
        if (input.status) {
          world.statusWrites.push(input.status);
          world.timeline.push(`status:${input.status}`);
        }
        return { orchestratorRunId: input.orchestratorRunId ?? null };
      },
      addPendingGrantRetirements: async ({ grantIds }) => {
        world.pending.push(...grantIds);
        world.timeline.push(`pending:${grantIds.join(',')}`);
        return grantIds;
      },
      clearPendingGrantRetirements: async ({ grantIds }) => grantIds,
      failStageAttemptForGrantRetirement: async (input) => {
        world.stageRowFailures.push(input);
        return { state: 'FAILED' };
      },
      listUnits: async () => [],
      setGateCallbackId: async () => ({}),
      getHumanTask: async () => ({ status: 'answered' }),
      appendEvent: async () => ({}),
      failRunningStageAttempt: async () => null,
    },
    loadPlan: async () => ({ valid: true, plan: { stages: [{ stageId: 'a' }, { stageId: 'b' }] } }),
    invokeRuntime: async (payload) => {
      world.invokes.push(payload);
      if (payload.command === 'run-stage-start') return { ok: true, accepted: true };
      return { ok: true };
    },
    issueGatewayGrant: async (scope, options) => `gw:${scope.mode}:${options?.randomId?.() ?? 'x'}`,
    retireGatewayGrant: async (retirement) => {
      if (!retirement.stageId) {
        world.syncRetirements.push(retirement.grantId);
        return retireSyncGrant(retirement, world.syncRetirements.length);
      }
      world.retirements.push(retirement.grantId);
      return retireGrant(retirement, world.retirements.length);
    },
    retireGatewayExecution: async (retirement) => {
      world.executionRetirements.push(retirement.reason);
      return { retired: true, alreadyRetired: false };
    },
    awaitGrantIssuance: async () => ({ retiredAt: null, waitedMs: 0, bounded: false }),
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    applicationUrl: 'https://aidlc.example.test/',
  };
  return world;
};

const jtiOf = (payload) => payload.gatewayGrant.split(':')[2];

const completeStage = async (runner, opName, result) => {
  const op = await runner.getOperation(opName).waitForData(WaitingOperationStatus.STARTED);
  await op.sendCallbackSuccess(JSON.stringify(result));
};

const start = (world) => {
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });
  const completion = runner.run({
    payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
  });
  return { runner, completion };
};

describe('fail-closed gateway grant retirement on the durable runner', () => {
  it('retries a failed jti retirement and only then starts the next stage', async () => {
    const world = makeWorld({
      retireGrant: (_r, call) => {
        if (call <= 2) throw new Error('ProvisionedThroughputExceededException');
        return { retired: true, alreadyRetired: false };
      },
    });
    const { runner, completion } = start(world);
    await completeStage(runner, 'stage-cb-a', { ok: true, state: 'SUCCEEDED' });
    await completeStage(runner, 'stage-cb-b', { ok: true, state: 'SUCCEEDED' });
    const execution = await completion;
    expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 2 });
    const [a, b] = world.invokes.filter((p) => p.command === 'run-stage-start');
    // Stage a's jti was attempted three times (two failures, one success); the
    // retried step re-signs nothing and keeps the same memoized jti.
    expect(world.retirements.slice(0, 3)).toEqual([jtiOf(a), jtiOf(a), jtiOf(a)]);
    expect(world.retirements.slice(3)).toEqual([jtiOf(b)]);
    expect(world.statusWrites).toContain('SUCCEEDED');
    // The run's end writes no execution-level retirement: every grant it
    // signed (stage and synchronous command alike) was retired by jti.
    expect(world.executionRetirements).toEqual([]);
    const syncJtis = world.invokes
      .filter((p) => p.command !== 'run-stage-start' && p.gatewayGrant)
      .map(jtiOf);
    expect(syncJtis.length).toBeGreaterThan(0);
    expect(world.syncRetirements).toEqual(syncJtis);
    expect(world.pending).toEqual([]);
  });

  it('fails the stage and the run once the retirement exhausts its retries', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const world = makeWorld({
        retireGrant: () => {
          throw new Error('AccessDeniedException');
        },
      });
      const { runner, completion } = start(world);
      await completeStage(runner, 'stage-cb-a', { ok: true, state: 'SUCCEEDED' });
      const result = (await completion).getResult();
      expect(result).toMatchObject({ ok: false, reason: 'stage_failed' });
      expect(result.detail).toContain('gateway_grant_retirement_failed');
      expect(world.retirements.length).toBeGreaterThan(1);
      // The worker's SUCCEEDED row is failed, and the unretired jti is on META
      // before the run is reported FAILED (a /start retires it first).
      const [stageStart] = world.invokes.filter((p) => p.command === 'run-stage-start');
      expect(world.stageRowFailures).toEqual([
        expect.objectContaining({
          stageCallbackId: stageStart.stageCallbackId,
          runtimeError: 'gateway_grant_retirement_failed',
        }),
      ]);
      expect(world.pending).toEqual([stageStart.gatewayGrant.split(':')[2]]);
      expect(world.timeline.indexOf(`pending:${world.pending[0]}`)).toBeLessThan(
        world.timeline.indexOf('status:FAILED'),
      );
      expect(world.invokes.filter((p) => p.command === 'run-stage-start')).toHaveLength(1);
      expect(world.statusWrites).toContain('FAILED');
      expect(world.statusWrites).not.toContain('SUCCEEDED');
      expect(log).toHaveBeenCalledWith(
        'gateway grant retirement failed after retries',
        expect.objectContaining({ code: 'GATEWAY_GRANT_RETIREMENT_FAILED', stageId: 'a' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('records an unretired engine-command grant on META and fails the run', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const world = makeWorld({
        retireGrant: () => ({ retired: true }),
        retireSyncGrant: () => {
          throw new Error('AccessDeniedException');
        },
      });
      const { completion } = start(world);
      const result = (await completion).getResult();
      expect(result).toMatchObject({ ok: false, reason: 'gateway_grant_retirement_failed' });
      const initWs = world.invokes.find((p) => p.command === 'init-ws');
      // The durable SDK retried the retirement step before giving up.
      expect(world.syncRetirements.length).toBeGreaterThan(1);
      expect(new Set(world.syncRetirements)).toEqual(new Set([jtiOf(initWs)]));
      expect(world.pending).toEqual([jtiOf(initWs)]);
      expect(world.timeline).toEqual([`pending:${jtiOf(initWs)}`, 'status:FAILED']);
      expect(world.invokes.map((p) => p.command)).toEqual(['init-ws']);
    } finally {
      log.mockRestore();
    }
  });

  // Oracle regression (3d383dd7): a failed retirement write used to be
  // checkpointed as done, and engine-data — which gates on ownership, not run
  // status — then accepted the stage's grant on a SUCCEEDED execution.
  it('denies the old stage grant at engine-data after a failed-then-recovered retirement', async () => {
    const KID = 'kid-1';
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const items = new Map();
    let failingWrites = 2;
    const table = {
      send: async ({ input }) => {
        if (input.Item) {
          if (failingWrites-- > 0) throw new Error('ProvisionedThroughputExceededException');
          if (items.has(input.Item.pk)) {
            throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
          }
          items.set(input.Item.pk, input.Item);
          return {};
        }
        return { Item: items.get(input.Key.pk) };
      },
    };
    const world = makeWorld({ retireGrant: () => ({ retired: true }) });
    world.deps.loadPlan = async () => ({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    world.deps.issueGatewayGrant = (scope, options = {}) =>
      issueGatewayGrant(scope, {
        ...options,
        keyId: KID,
        sign: async (message) => cryptoSign('sha256', message, keys.privateKey),
      });
    world.deps.retireGatewayGrant = (retirement) =>
      retireGatewayGrant({ ddb: table, tableName: 't' }, retirement);

    const { runner, completion } = start(world);
    await completeStage(runner, 'stage-cb-a', { ok: true, state: 'SUCCEEDED' });
    expect((await completion).getResult()).toEqual({ ok: true, intentId: 'i1', stages: 1 });
    expect(world.statusWrites).toContain('SUCCEEDED');

    const staleGrant = world.invokes.find((p) => p.command === 'run-stage-start').gatewayGrant;
    const store = {
      getExecution: vi.fn(async () => ({ ...META, status: 'SUCCEEDED' })),
      appendEvent: vi.fn(async () => ({ ok: true })),
    };
    const engineData = createStoreGateway({
      verifyGrant: (token) =>
        verifyGatewayGrant(token, {
          publicKeyFor: async (kid) => (kid === KID ? keys.publicKey : null),
          isRetired: (claims) =>
            isGatewayGrantRetired({ ddb: table, tableName: 't', processTableName: 'proc' }, claims),
        }),
      createStore: () => store,
      audit: () => {},
    });
    await expect(
      engineData({
        op: 'store.appendEvent',
        grant: staleGrant,
        args: [{ executionId: 'i1', type: 'v2.stage.note', summary: 'after the end' }],
      }),
    ).resolves.toMatchObject({ error: { code: 'grant_retired' } });
    expect(store.appendEvent).not.toHaveBeenCalled();

    // Grants other control-plane Lambdas issue after the run completed — a
    // discussion's and an artifact-edit derive's — are not born retired: the
    // run's end wrote no execution-level retirement, even within the same
    // second.
    const verify = (token) =>
      verifyGatewayGrant(token, {
        publicKeyFor: async (kid) => (kid === KID ? keys.publicKey : null),
        isRetired: (claims) =>
          isGatewayGrantRetired({ ddb: table, tableName: 't', processTableName: 'proc' }, claims),
      });
    const sign = (scope) =>
      issueGatewayGrant(scope, {
        keyId: KID,
        sign: async (message) => cryptoSign('sha256', message, keys.privateKey),
      });
    const ids = { projectId: 'p1', intentId: 'i1', executionId: 'i1' };
    await expect(verify(await sign({ mode: 'discussion', ...ids }))).resolves.toMatchObject({
      mode: 'discussion',
    });
    await expect(verify(await sign({ mode: 'execution', ...ids }))).resolves.toMatchObject({
      mode: 'execution',
    });
    expect([...items.keys()].some((pk) => pk.startsWith('EXEC#'))).toBe(false);
  });
});
