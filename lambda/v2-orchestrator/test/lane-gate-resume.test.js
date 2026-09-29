import { describe, it, expect, vi } from 'vitest';
import { __durableHandler } from '../index.js';

const makeCtx = () => {
  const stageCallbacks = new Map();
  const ctx = {
    logger: { info() {}, debug() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      if (String(name).startsWith('stage-cb-')) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        const callbackId = `cb-${name}`;
        stageCallbacks.set(callbackId, resolve);
        return [promise, callbackId];
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
  environment: {
    runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/managed',
    runtimeEndpoint: 'revision_r_1',
  },
};

describe('lane gate resume', () => {
  it.each([false, true])(
    'keeps META running and fences ownership on lane resume (owner changes: %s)',
    async (ownerChanges) => {
      const ctx = makeCtx();
      const meta = { ...META };
      const invokes = [];
      const unparkWrites = [];
      const ownershipUpdates = [];
      let parked = false;
      let pointerDuringResume;
      let statusDuringResume;
      let getExecutionReads = 0;
      let replaceOwnerAtFence = false;
      let ownerReplaced = false;
      let staleOwnerId = null;

      const store = {
        getExecution: vi.fn(async () => {
          const snapshot = { ...meta };
          getExecutionReads += 1;
          if (ownerChanges && getExecutionReads >= 2 && !replaceOwnerAtFence) {
            staleOwnerId = snapshot.orchestratorRunId;
            replaceOwnerAtFence = true;
          }
          return snapshot;
        }),
        updateExecution: vi.fn(async (args) => {
          if (args.ifOrchestratorRunId) {
            ownershipUpdates.push(args);
            if (ownerChanges && args.orchestratorRunId && !args.fromStatus && replaceOwnerAtFence) {
              meta.orchestratorRunId = 'run-replacement';
              ownerReplaced = true;
              replaceOwnerAtFence = false;
            }
            if (meta.orchestratorRunId !== args.ifOrchestratorRunId) {
              throw Object.assign(new Error('conditional check failed'), {
                name: 'ConditionalCheckFailedException',
              });
            }
          }
          if (args.fromStatus === 'WAITING') {
            unparkWrites.push(args);
            if (meta.status !== 'WAITING') {
              const error = new Error('conditional check failed');
              error.name = 'ConditionalCheckFailedException';
              throw error;
            }
          }
          Object.assign(meta, args.status ? { status: args.status } : {});
          if (args.orchestratorRunId) meta.orchestratorRunId = args.orchestratorRunId;
          if (args.status === 'RUNNING' && args.fromStatus === 'CREATED') {
            meta.pendingHumanTaskId = 'sibling-gate';
          } else if (args.pendingHumanTaskId !== undefined) {
            meta.pendingHumanTaskId = args.pendingHumanTaskId;
          }
          return meta;
        }),
        createHumanTask: vi.fn(async (args) => ({ ...args, status: 'answered' })),
        setGateCallbackId: vi.fn(async () => ({})),
        getHumanTask: vi.fn(async () => ({ status: 'answered' })),
        supersedeHumanTask: vi.fn(async () => ({})),
        appendEvent: vi.fn(async () => ({})),
        putTrackerSync: vi.fn(async (args) => args),
        failRunningStageAttempt: vi.fn(async () => null),
        listUnits: vi.fn(async () => []),
        getUnit: vi.fn(async () => null),
        getUnitPlan: vi.fn(async () => ({
          units: [
            { slug: 'auth', dependsOn: [] },
            { slug: 'billing', dependsOn: ['auth'] },
          ],
          batches: [['auth'], ['billing']],
          skipMatrix: {},
          walkingSkeleton: 'auth',
          autonomyMode: 'autonomous',
        })),
        updateUnitState: vi.fn(async (args) => ({ slug: args.slug, state: args.state })),
        updateUnitPlanDecisions: vi.fn(async () => ({})),
        putStage: vi.fn(async (args) => args),
        getStage: vi.fn(async () => null),
      };

      const stages = [
        {
          stageId: 'units-gen',
          stageInstanceId: 'si-units-gen',
          parallelSection: null,
          outputArtifacts: [{ artifact: 'unit-of-work-dependency' }],
        },
        {
          stageId: 'cg',
          stageInstanceId: 'si-cg',
          parallelSection: 1,
          execution: 'ALWAYS',
          phase: 'construction',
          outputArtifacts: [],
        },
        { stageId: 'bt', stageInstanceId: 'si-bt', parallelSection: null, outputArtifacts: [] },
      ];
      const deps = {
        store,
        loadPlan: vi.fn(async () => ({
          valid: true,
          plan: { namespace: 'aidlc-v2@1', stages },
        })),
        invokeRuntime: vi.fn(async (payload) => {
          if (payload.command === 'create-workflow-checkpoint')
            return { ok: true, checkpointId: `cp-${invokes.length}` };
          invokes.push(payload);
          if (payload.command === 'init-ws') return { ok: true };
          if (payload.command === 'promote-units')
            return { ok: true, unitCount: 2, batchCount: 2, walkingSkeleton: 'auth' };
          if (payload.command === 'run-stage-start') {
            let verdict = { ok: true, state: 'SUCCEEDED' };
            if (payload.stageId === 'cg' && payload.unitSlug === 'auth' && !parked) {
              parked = true;
              verdict = {
                ok: true,
                state: 'WAITING_FOR_HUMAN',
                humanTaskId: 'h9',
                unitSlug: 'auth',
              };
            }
            if (payload.resumeFrom === 'h9') {
              pointerDuringResume = meta.pendingHumanTaskId;
              statusDuringResume = meta.status;
            }
            const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
            if (!resolve)
              throw new Error(`no stage callback registered: ${payload.stageCallbackId}`);
            resolve(verdict);
            return { ok: true, accepted: true, stageId: payload.stageId };
          }
          return { ok: true };
        }),
        stopSession: vi.fn(async () => ({ stopped: true })),
        broadcast: vi.fn(async () => {}),
        openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
        comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
        applicationUrl: 'https://aidlc.example.test/',
      };

      const result = await __durableHandler(
        { action: 'start', intentId: 'i1', executionId: 'i1' },
        ctx,
        deps,
      );

      const authStages = invokes.filter(
        (payload) =>
          payload.command === 'run-stage-start' &&
          payload.stageId === 'cg' &&
          payload.unitSlug === 'auth',
      );
      if (ownerChanges) {
        expect(ownerReplaced).toBe(true);
        expect(ownershipUpdates).toContainEqual({
          executionId: 'i1',
          orchestratorRunId: staleOwnerId,
          ifOrchestratorRunId: staleOwnerId,
        });
        expect(authStages.map((payload) => [payload.unitSlug, payload.resumeFrom])).toEqual([
          ['auth', null],
        ]);
        expect(meta.status).toBe('RUNNING');
        expect(meta.pendingHumanTaskId).toBe('sibling-gate');
        expect(pointerDuringResume).toBeUndefined();
      } else {
        expect(result.ok).toBe(true);
        expect(authStages.map((payload) => [payload.unitSlug, payload.resumeFrom])).toEqual([
          ['auth', null],
          ['auth', 'h9'],
        ]);
        expect(pointerDuringResume).toBe('sibling-gate');
        expect(statusDuringResume).toBe('RUNNING');
      }
      expect(unparkWrites).toHaveLength(0);
    },
  );
});
