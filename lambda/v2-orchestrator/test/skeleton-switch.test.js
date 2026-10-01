// `SCOPE.skeleton` — the ceremony switch.
//
// Upstream's `skeleton: off` removes the walking-skeleton RITUAL, not the work and
// not every gate: the picked unit still runs and merges, it just does not run
// alone ahead of its peers and gets no gate of its own, while the construction
// stage keeps its ordinary approval gate. That distinction is the whole test —
// an implementation that skipped the unit, or that skipped its peers' gates too,
// would pass a naive "no skeleton gate" assertion.
//
// The lane git commands are stubbed here (init-lane / merge-lane return ok):
// section-integration.test.js already covers them against real git, and what this
// file needs to observe is the ORDER and the GATES, not the merge mechanics.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { __durableHandler } from '../index.js';

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
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
  repos: ['o/r'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
};

const policyWith = (skeleton) => ({
  sensorsEnabled: true,
  reviewClass: 'none',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'off',
  skeleton,
});

const planFor = (skeleton) => ({
  valid: true,
  plan: {
    namespace: 'aidlc-v2@1',
    stages: [
      {
        stageId: 'gen',
        stageInstanceId: 'si-gen',
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
        ...(skeleton ? { policy: policyWith(skeleton) } : {}),
      },
    ],
  },
});

const makeWorld = (skeleton) => {
  const world = {
    invokes: [],
    events: [],
    gates: new Map(),
    laneOrder: [],
    runner: null,
  };
  const unitPlan = {
    units: [
      { slug: 'a', dependsOn: [] },
      { slug: 'b', dependsOn: [] },
    ],
    batches: [['a', 'b']],
    skipMatrix: {},
    walkingSkeleton: 'a',
    // Pre-decided so the autonomy-ladder gate is not part of this fixture.
    autonomyMode: 'autonomous',
  };
  const store = {
    getExecution: async () => ({ ...META }),
    updateExecution: async () => ({}),
    setGateCallbackId: async () => ({}),
    createHumanTask: async (args) => {
      if (!world.gates.has(args.humanTaskId)) {
        world.gates.set(args.humanTaskId, { ...args, status: 'pending' });
      }
      return world.gates.get(args.humanTaskId);
    },
    getHumanTask: async (_e, id) => world.gates.get(id) ?? null,
    appendEvent: async (e) => {
      world.events.push(e);
      return e;
    },
    getUnitPlan: async () => unitPlan,
    listUnits: async () => [],
    getUnit: async () => null,
    updateUnitPlanDecisions: async () => ({}),
    updateUnitState: async (args) => ({ slug: args.slug, state: args.state }),
    putStage: async (args) => args,
    getStage: async () => null,
  };

  const invokeRuntime = async (payload) => {
    world.invokes.push(payload);
    if (payload.command === 'promote-units') {
      return { ok: true, unitCount: 2, batchCount: 1 };
    }
    if (payload.command === 'run-stage-start') {
      if (payload.unitSlug) world.laneOrder.push(payload.unitSlug);
      const opName = `stage-cb-${payload.stageId}${
        payload.unitSlug ? `-s${payload.sectionIndex ?? 'legacy'}-u-${payload.unitSlug}` : ''
      }`;
      (async () => {
        const op = await world.runner
          .getOperation(opName)
          .waitForData(WaitingOperationStatus.STARTED);
        await op.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
      })();
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  };

  world.deps = {
    store,
    loadPlan: async () => planFor(skeleton),
    invokeRuntime,
    resolveToken: async () => '',
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    applicationUrl: 'https://aidlc.example.test/',
  };
  return world;
};

const answerEngineGate = async (world, prefix, patch = { status: 'answered' }) => {
  let id;
  for (let i = 0; i < 400 && !id; i++) {
    id = [...world.gates.keys()].find((k) => k.startsWith(prefix));
    if (!id) await new Promise((r) => setTimeout(r, 25));
  }
  expect(id, `engine gate ${prefix} was never opened`).toBeTruthy();
  const op = await world.runner
    .getOperation(`await-${id}`)
    .waitForData(WaitingOperationStatus.STARTED);
  world.gates.set(id, { ...world.gates.get(id), ...patch });
  await op.sendCallbackSuccess(JSON.stringify({ answer: patch.answer ?? null }));
  return id;
};

const startRun = (world) => {
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  world.runner = new LocalDurableTestRunner({ handlerFunction: handler });
  return world.runner.run({ payload: { action: 'start', intentId: 'i1', executionId: 'i1' } });
};

const gateIds = (world) => [...world.gates.keys()];
const eventTypes = (world) => world.events.map((e) => e.type);

describe('skeleton: on (and the unpinned default) — the ceremony runs', () => {
  it('runs the picked unit SOLO behind its own gate before the rest', async () => {
    const world = makeWorld('on');
    const run = startRun(world);
    await answerEngineGate(world, 'eg-validation-si-gen');
    await answerEngineGate(world, 'eg-skeleton-s1');
    const execution = await run;

    expect(execution.getResult()).toMatchObject({ ok: true, intentId: 'i1' });
    expect(gateIds(world).some((id) => id.startsWith('eg-skeleton-s1'))).toBe(true);
    // Solo means the skeleton dispatched alone and first.
    expect(world.laneOrder[0]).toBe('a');
    expect(world.laneOrder.toSorted()).toEqual(['a', 'b']);
    expect(eventTypes(world)).toContain('v2.units.skeleton_approved');
    expect(eventTypes(world)).not.toContain('v2.units.skeleton_skipped');
  });
});

describe('skeleton: off — the ceremony is skipped, the work is not', () => {
  it('opens no skeleton gate, records the skip, and still runs and merges the unit', async () => {
    const world = makeWorld('off');
    const run = startRun(world);
    await answerEngineGate(world, 'eg-validation-si-gen');
    const execution = await run;

    expect(execution.getResult()).toMatchObject({ ok: true, intentId: 'i1' });
    // No ceremony: no eg-skeleton-* row at all, and no approval to give.
    expect(gateIds(world).some((id) => id.startsWith('eg-skeleton'))).toBe(false);
    expect(eventTypes(world)).not.toContain('v2.units.skeleton_approved');
    expect(eventTypes(world)).toContain('v2.units.skeleton_skipped');
    // The WORK still happened — `off` drops the ritual, not the unit. Both lanes
    // ran, and the picked unit is one of them rather than being left behind.
    expect(world.laneOrder.toSorted()).toEqual(['a', 'b']);
    expect(eventTypes(world)).toContain('v2.units.fan_in');
  });

  it('names the skipped unit and the reason on the timeline', async () => {
    const world = makeWorld('off');
    const run = startRun(world);
    await answerEngineGate(world, 'eg-validation-si-gen');
    await run;
    const skipped = world.events.find((e) => e.type === 'v2.units.skeleton_skipped');
    expect(skipped.summary).toContain('skeleton: off');
    expect(skipped.summary).toContain('a');
  });
});
