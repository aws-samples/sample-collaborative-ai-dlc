import { describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';

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

describe('lane gate resume ownership', () => {
  it('does not dispatch a lane resume if ownership changes after the read', async () => {
    const stageCallbacks = new Map();
    const ctx = {
      logger: { info() {}, debug() {}, error() {} },
      step: async (_name, fn) => fn(),
      createCallback: async (name) => {
        if (String(name).startsWith('stage-cb-')) {
          let resolve;
          const promise = new Promise((accept) => {
            resolve = accept;
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
    const meta = { ...META };
    const invokes = [];
    let gateReads = 0;
    let ownerReplaced = false;
    let replaceOwnerAtFence = false;
    let staleOwnerId = null;
    const ownershipUpdates = [];
    const store = {
      getExecution: vi.fn(async () => {
        const snapshot = { ...meta };
        if (gateReads > 1 && !replaceOwnerAtFence) {
          staleOwnerId = snapshot.orchestratorRunId;
          replaceOwnerAtFence = true;
        }
        return snapshot;
      }),
      updateExecution: vi.fn(async (input) => {
        if (input.ifOrchestratorRunId) {
          ownershipUpdates.push(input);
          if (input.orchestratorRunId && !input.fromStatus && replaceOwnerAtFence) {
            meta.orchestratorRunId = 'run-replacement';
            ownerReplaced = true;
            replaceOwnerAtFence = false;
          }
          if (meta.orchestratorRunId !== input.ifOrchestratorRunId) {
            throw Object.assign(new Error('conditional check failed'), {
              name: 'ConditionalCheckFailedException',
            });
          }
        }
        if (input.orchestratorRunId) meta.orchestratorRunId = input.orchestratorRunId;
        if (input.status) meta.status = input.status;
        if (input.pendingHumanTaskId !== undefined) {
          meta.pendingHumanTaskId = input.pendingHumanTaskId;
        }
        return meta;
      }),
      createHumanTask: vi.fn(async (input) => ({ ...input, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      getHumanTask: vi.fn(async () => {
        gateReads += 1;
        if (gateReads === 1) return null;
        return {
          humanTaskId: 'h9',
          status: 'approved',
          answer: { decision: 'approve' },
          callbackId: 'cb-h9',
          stageInstanceId: 'si-cg',
          unitSlug: 'auth',
        };
      }),
      supersedeHumanTask: vi.fn(async () => ({})),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (input) => input),
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
      updateUnitState: vi.fn(async (input) => ({ slug: input.slug, state: input.state })),
      updateUnitPlanDecisions: vi.fn(async () => ({})),
      putStage: vi.fn(async (input) => input),
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
      invokeRuntime: vi.fn(async (input) => {
        invokes.push(input);
        if (input.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
        if (input.command === 'init-ws') return { ok: true };
        if (input.command === 'promote-units') {
          return { ok: true, unitCount: 2, batchCount: 2, walkingSkeleton: 'auth' };
        }
        if (input.command === 'run-stage-start') {
          const verdict =
            input.stageId === 'cg' && input.unitSlug === 'auth'
              ? {
                  ok: true,
                  state: 'WAITING_FOR_HUMAN',
                  humanTaskId: 'h9',
                  unitSlug: 'auth',
                }
              : { ok: true, state: 'SUCCEEDED' };
          const resolve = stageCallbacks.get(input.stageCallbackId);
          if (!resolve) throw new Error(`no stage callback registered: ${input.stageCallbackId}`);
          resolve(verdict);
          return { ok: true, accepted: true, stageId: input.stageId };
        }
        return { ok: true };
      }),
      stopSession: vi.fn(async () => ({ stopped: true })),
      broadcast: vi.fn(async () => {}),
      openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
      comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
      applicationUrl: 'https://aidlc.example.test/',
    };

    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

    expect(ownerReplaced).toBe(true);
    expect(ownershipUpdates).toContainEqual({
      executionId: 'i1',
      orchestratorRunId: staleOwnerId,
      ifOrchestratorRunId: staleOwnerId,
    });
    expect(
      invokes.some((input) => input.command === 'run-stage-start' && input.resumeFrom === 'h9'),
    ).toBe(false);
  });
});
