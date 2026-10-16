// The gate-time autonomy grant against the PRODUCTION process store on
// DynamoDB Local, not a fake that re-implements its conditions. The mocked
// store cannot prove the write is actually fenced: it is DynamoDB that
// evaluates `fromStatus` and `ifOrchestratorRunId`, and the claim under test is
// that a cancel which lands between the gate's un-park and the grant leaves no
// grant, no provenance and no approval on the row.
//
// The root test runner starts DynamoDB Local (test/dynamodb-setup.js).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { __durableHandler } from '../index.js';
import { createProcessStore } from '../../shared/v2-process-store.js';

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'off',
  skeleton: null,
  planApproval: null,
  loopBack: null,
  constructionAutonomy: 'native',
});

const constructionStage = (stageId) => ({
  stageId,
  stageInstanceId: `si-${stageId}`,
  phase: 'construction',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: `${stageId}-out` }],
  policy: POLICY,
});

describe.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'construction autonomy grant against the production process store',
  () => {
    const table = `v2-proc-autonomy-${randomUUID()}`;
    let raw;
    let store;

    beforeAll(async () => {
      raw = new DynamoDBClient({
        endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      await raw.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
        }),
      );
      store = createProcessStore({ ddb: DynamoDBDocumentClient.from(raw), tableName: table });
    }, 60_000);

    afterAll(async () => {
      await raw?.send(new DeleteTableCommand({ TableName: table })).catch(() => {});
      raw?.destroy();
    });

    const seed = async (executionId) => {
      await store.createExecution({
        executionId,
        intentId: executionId,
        projectId: 'p1',
        status: 'CREATED',
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
        startedAt: 'T',
        startedBy: 'u1',
        repos: ['owner/repo'],
        branch: `aidlc/${executionId}`,
        baseBranch: 'main',
        gitProvider: 'github',
        agentCli: 'kiro',
        constructionGateAutonomy: 'gated',
        environment: { runtimeArn: 'arn:runtime', runtimeEndpoint: 'revision_r_1' },
      });
    };

    // The run answers its own gate: the answer is written through the real
    // `answerHumanTask` once the run has bound its callback to the gate row,
    // which is the point the answer endpoint could first have reached it. The
    // gate row must still be `pending` when that binding happens, so the write
    // cannot be made any earlier.
    const makeCtx = (executionId, answeredGates) => {
      const stageCallbacks = new Map();
      const ctx = {
        logger: { info() {}, debug() {}, error() {} },
        step: async (name, fn) => {
          const value = await fn();
          if (String(name).startsWith('bind-callback-eg-')) {
            const humanTaskId = String(name).replace('bind-callback-', '');
            const answered = await store.answerHumanTask({
              executionId,
              humanTaskId,
              status: 'answered',
              answer: { decision: 'grant-autonomy' },
              answeredBy: 'u1',
              answeredByName: 'Ada',
            });
            if (answered) answeredGates.push(humanTaskId);
          }
          return value;
        },
        createCallback: async (name) => {
          if (String(name).startsWith('stage-cb-')) {
            let resolve;
            const promise = new Promise((r) => {
              resolve = r;
            });
            stageCallbacks.set(`cb-${name}`, resolve);
            return [promise, `cb-${name}`];
          }
          return [Promise.resolve({ answer: null }), `cb-${name}`];
        },
        wait: async () => undefined,
        promise: {
          race: async (_name, promises) => Promise.race(promises),
          allSettled: async (_name, promises) => Promise.allSettled(promises),
        },
        runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
        stageCallbackResolvers: stageCallbacks,
      };
      return ctx;
    };

    const makeDeps = (executionId, ctx, storeForRun) => ({
      store: storeForRun,
      loadPlan: vi.fn(async () => ({
        valid: true,
        plan: {
          stages: [constructionStage('functional-design'), constructionStage('build-and-test')],
        },
      })),
      invokeRuntime: vi.fn(async (payload) => {
        if (payload.command === 'run-stage-start') {
          ctx.stageCallbackResolvers.get(payload.stageCallbackId)?.({
            ok: true,
            state: 'SUCCEEDED',
            producedHeads: [
              {
                artifactType: `${payload.stageId}-out`,
                logicalKey: `${payload.stageId}-k`,
                snapshotHash: 'sha-1',
              },
            ],
          });
          return { ok: true, accepted: true, stageId: payload.stageId };
        }
        return { ok: true };
      }),
      issueAgentCredentialGrant: vi.fn(async () => 'grant'),
      stopSession: vi.fn(async () => ({ stopped: true })),
      broadcast: vi.fn(async () => {}),
      openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
      comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
      applicationUrl: 'https://aidlc.example.test/',
    });

    it('writes no grant when a cancel lands between the un-park and the grant', async () => {
      const executionId = `i-${randomUUID()}`;
      await seed(executionId);
      const answeredGates = [];
      const ctx = makeCtx(executionId, answeredGates);

      // The gate's un-park commits, and the cancel endpoint's own conditional
      // write lands against the real table before the separate grant step. The
      // run still carries the ownership token, so only status has moved.
      let cancels = 0;
      const fenced = {
        ...store,
        updateExecution: async (args) => {
          const result = await store.updateExecution(args);
          if (args.status === 'RUNNING' && args.fromStatus === 'WAITING') {
            cancels += 1;
            await store.updateExecution({
              executionId,
              status: 'CANCELLED',
              fromStatus: 'RUNNING',
              completedAt: 'T-cancel',
              pendingHumanTaskId: null,
            });
          }
          return result;
        },
      };

      const result = await __durableHandler(
        { action: 'start', intentId: executionId, executionId },
        ctx,
        makeDeps(executionId, ctx, fenced),
      );

      expect(cancels).toBe(1);
      expect(answeredGates).toHaveLength(1);
      expect(result).toMatchObject({ ok: false, reason: 'retired' });

      const meta = await store.getExecution(executionId, { consistentRead: true });
      expect(meta.status).toBe('CANCELLED');
      expect(meta.constructionGateAutonomy).toBe('gated');
      expect(meta.constructionGateAutonomyGrant ?? null).toBeNull();

      const events = await store.listEvents(executionId, { consistentRead: true });
      expect(events.filter((row) => row.eventType === 'v2.autonomy.mode_set')).toEqual([]);
      expect(events.filter((row) => row.eventType === 'v2.stage.validated')).toEqual([]);
      const receipts = await store.listReceipts(executionId, {
        stageInstanceId: 'si-functional-design',
        attempt: 0,
        consistentRead: true,
      });
      expect(receipts.filter((row) => row.kind === 'stage-approval')).toEqual([]);
    }, 60_000);

    // The test above interleaves AFTER the un-park has already committed
    // RUNNING. The maintainer's report is narrower and lands earlier: the
    // un-park's own write throttles — a transient error the SDK retries by
    // default, so this run never observes a lost condition, only a delay —
    // and the interleaving write lands in that delay, before the SDK's own
    // retry re-sends the identical conditional write. Reproduced by faulting
    // the first matching attempt at the client's `deserialize` step, which
    // sits inside the SDK's retry wrapper: nothing reaches DynamoDB Local on
    // that attempt, the interleaving write runs for real while the retry is
    // pending, and the SDK then re-sends the same request against the row
    // the interleaving write left behind.
    const throttleUnparkOnce = (client, forExecutionId, onThrottled) => {
      let fired = false;
      client.middlewareStack.add(
        (next) => async (args) => {
          const input = args.input ?? {};
          const isUnpark =
            input.Key?.pk?.S === `EXEC#${forExecutionId}` &&
            input.ExpressionAttributeValues?.[':fromStatus']?.S === 'WAITING';
          if (isUnpark && !fired) {
            fired = true;
            await onThrottled();
            throw Object.assign(new Error('simulated DynamoDB throttle'), {
              name: 'ThrottlingException',
            });
          }
          return next(args);
        },
        { name: 'throttle-unpark-once', step: 'deserialize', priority: 'high' },
      );
    };

    // A second client against the same table: the fault above is installed
    // on its middleware stack only, so it cannot affect the interleaving
    // write, which is issued through the describe block's own `store`.
    const makeFaultedStore = () => {
      const raw2 = new DynamoDBClient({
        endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      const store2 = createProcessStore({
        ddb: DynamoDBDocumentClient.from(raw2),
        tableName: table,
      });
      return { raw2, store2 };
    };

    it('writes no grant when a cancel wins the retry of a throttled un-park', async () => {
      const executionId = `i-${randomUUID()}`;
      await seed(executionId);
      const answeredGates = [];
      const ctx = makeCtx(executionId, answeredGates);
      const { raw2, store2 } = makeFaultedStore();

      let cancels = 0;
      throttleUnparkOnce(raw2, executionId, async () => {
        cancels += 1;
        // The real cancel endpoint's own conditional write: META still reads
        // WAITING, since the un-park's first attempt never reached the table.
        await store.updateExecution({
          executionId,
          status: 'CANCELLED',
          fromStatus: 'WAITING',
          completedAt: 'T-cancel',
          pendingHumanTaskId: null,
        });
      });

      try {
        const result = await __durableHandler(
          { action: 'start', intentId: executionId, executionId },
          ctx,
          makeDeps(executionId, ctx, store2),
        );

        expect(cancels).toBe(1);
        expect(answeredGates).toHaveLength(1);
        expect(result).toMatchObject({ ok: false, reason: 'retired' });

        const meta = await store.getExecution(executionId, { consistentRead: true });
        expect(meta.status).toBe('CANCELLED');
        expect(meta.constructionGateAutonomy).toBe('gated');
        expect(meta.constructionGateAutonomyGrant ?? null).toBeNull();

        const events = await store.listEvents(executionId, { consistentRead: true });
        expect(events.filter((row) => row.eventType === 'v2.autonomy.mode_set')).toEqual([]);
        expect(events.filter((row) => row.eventType === 'v2.stage.validated')).toEqual([]);
        const receipts = await store.listReceipts(executionId, {
          stageInstanceId: 'si-functional-design',
          attempt: 0,
          consistentRead: true,
        });
        expect(receipts.filter((row) => row.kind === 'stage-approval')).toEqual([]);
      } finally {
        raw2.destroy();
      }
    }, 60_000);

    it('writes no grant when a takeover wins the retry of a throttled un-park', async () => {
      const executionId = `i-${randomUUID()}`;
      await seed(executionId);
      const answeredGates = [];
      const ctx = makeCtx(executionId, answeredGates);
      const { raw2, store2 } = makeFaultedStore();

      let takeovers = 0;
      throttleUnparkOnce(raw2, executionId, async () => {
        takeovers += 1;
        // A rewind relaunch's own write: a new run claims the still-parked
        // intent under its own token before this run's un-park lands.
        await store.updateExecution({
          executionId,
          status: 'RUNNING',
          fromStatus: 'WAITING',
          orchestratorRunId: 'run-relaunched',
          pendingHumanTaskId: null,
          resumeRequired: null,
        });
      });

      try {
        const result = await __durableHandler(
          { action: 'start', intentId: executionId, executionId },
          ctx,
          makeDeps(executionId, ctx, store2),
        );

        expect(takeovers).toBe(1);
        expect(answeredGates).toHaveLength(1);
        expect(result).toMatchObject({ ok: false, reason: 'retired' });

        const meta = await store.getExecution(executionId, { consistentRead: true });
        expect(meta.status).toBe('RUNNING');
        expect(meta.orchestratorRunId).toBe('run-relaunched');
        expect(meta.constructionGateAutonomy).toBe('gated');
        expect(meta.constructionGateAutonomyGrant ?? null).toBeNull();

        const events = await store.listEvents(executionId, { consistentRead: true });
        expect(events.filter((row) => row.eventType === 'v2.autonomy.mode_set')).toEqual([]);
        expect(events.filter((row) => row.eventType === 'v2.stage.validated')).toEqual([]);
        const receipts = await store.listReceipts(executionId, {
          stageInstanceId: 'si-functional-design',
          attempt: 0,
          consistentRead: true,
        });
        expect(receipts.filter((row) => row.kind === 'stage-approval')).toEqual([]);
      } finally {
        raw2.destroy();
      }
    }, 60_000);
  },
);
