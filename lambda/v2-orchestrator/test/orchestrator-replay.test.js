import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { __durableHandler } from '../index.js';

// ---------------------------------------------------------------------------
// REAL replay coverage for the orchestrator's async stage flow (WP1).
//
// orchestrator.test.js drives the control flow with a fake ctx that never
// replays. This suite runs the ACTUAL handler on the local durable test runner
// (real checkpointing, suspend, replay) with the runtime/container faked at
// the deps seam:
//
//   - `run-stage-start` dispatches are ACCEPT-only; the stage verdict is
//     delivered OUT-OF-BAND by the test completing the stage callback —
//     exactly how the container's background job resumes the orchestrator in
//     production (SendDurableExecutionCallbackSuccess with a JSON body);
//   - human gates are answered out-of-band against the `await-<gate>` callback
//     with the same JSON shape lambda/intents sends;
//   - every suspend → resume is a genuine handler re-invocation (replay).
//
// Traceability assertions: exactly-once side effects across all replays
// (init-ws, dispatches, terminal write), the gate's durable callbackId stamped
// on the HUMAN# row matches the callback the test resumed, and each stage
// attempt dispatched exactly once with its own stage callback id.
// ---------------------------------------------------------------------------

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
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
  // No release timer in the replay suite — the park/release race has dedicated
  // unit coverage; here we only exercise suspend/replay mechanics.
  parkReleaseSeconds: null,
};

// A mutable "container + store" world shared between the handler (via deps)
// and the test (which mutates it before completing callbacks). All handler
// reads happen inside durable steps, so replays see memoized values — the
// world only needs to be right at first-execution time.
const makeWorld = ({ stages = [{ stageId: 'a' }, { stageId: 'b' }] } = {}) => {
  const world = {
    pendingHumanTaskId: null,
    gateStatus: 'answered',
    gateCallbackBindings: [],
    invokes: [],
    events: [],
    statusWrites: [],
  };
  world.deps = {
    store: {
      getExecution: async () => ({ ...META, pendingHumanTaskId: world.pendingHumanTaskId }),
      updateExecution: async (input) => {
        if (input.status) world.statusWrites.push(input.status);
        return { orchestratorRunId: input.orchestratorRunId ?? null };
      },
      setGateCallbackId: async (input) => {
        world.gateCallbackBindings.push(input);
        return {};
      },
      getHumanTask: async () => ({ status: world.gateStatus }),
      appendEvent: async (e) => {
        world.events.push(e.type);
        return {};
      },
    },
    loadPlan: async () => ({ valid: true, plan: { stages } }),
    invokeRuntime: async (payload) => {
      world.invokes.push(payload);
      if (payload.command === 'init-ws') return { ok: true };
      // ACCEPT only — the verdict arrives via the stage callback, later.
      return { ok: true, accepted: true, stageId: payload.stageId };
    },
    resolveToken: async () => 'tok',
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
  };
  return world;
};

// Complete a durable callback the way production does: a JSON body.
const completeStage = async (runner, opName, result) => {
  const op = await runner.getOperation(opName).waitForData(WaitingOperationStatus.STARTED);
  await op.sendCallbackSuccess(JSON.stringify(result));
  return op;
};

describe('orchestrator on the real durable runner (replay semantics)', () => {
  it('runs init-ws → stage a (park → human answer → resume) → stage b to SUCCEEDED with exactly-once side effects', async () => {
    const world = makeWorld();
    const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const executionPromise = runner.run({
      payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
    });

    // Stage a parks on a human gate: set the world so the park loop's re-read
    // finds the pending gate, then deliver the WAITING_FOR_HUMAN verdict.
    world.pendingHumanTaskId = 'h1';
    world.gateStatus = 'pending';
    await completeStage(runner, 'stage-cb-a', {
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      humanTaskId: 'h1',
    });

    // The orchestrator suspends on the gate callback. Answer it like
    // lambda/intents does (JSON {answer}); after the answer the gate reads
    // answered so the park loop exits into the resume leg.
    const gateOp = await runner
      .getOperation('await-h1')
      .waitForData(WaitingOperationStatus.STARTED);
    world.gateStatus = 'answered';
    await gateOp.sendCallbackSuccess(JSON.stringify({ answer: 'approved' }));

    // Resume leg completes, then stage b.
    await completeStage(runner, 'stage-cb-a-resume-h1', { ok: true, state: 'SUCCEEDED' });
    await completeStage(runner, 'stage-cb-b', { ok: true, state: 'SUCCEEDED' });

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 2 });

    // NOTE: whether each callback completion arrives in-flight (same
    // invocation) or after a suspend (re-drive) is runner-internal timing; the
    // exactly-once assertions below must hold under BOTH regimes (replay
    // mechanics themselves are proven in test/poc/). Assert only that the
    // execution went through the real durable machinery.
    expect(execution.getInvocations().length).toBeGreaterThanOrEqual(1);

    // Exactly-once side effects across every replay:
    expect(world.invokes.map((p) => p.command)).toEqual([
      'init-ws',
      'run-stage-start', // a (fresh)
      'run-stage-start', // a (resume h1)
      'run-stage-start', // b
    ]);
    const starts = world.invokes.filter((p) => p.command === 'run-stage-start');
    expect(starts.map((p) => p.stageId)).toEqual(['a', 'a', 'b']);
    expect(starts.map((p) => p.resumeFrom)).toEqual([null, 'h1', null]);
    // Every attempt carries its own real durable callback id.
    const cbIds = starts.map((p) => p.stageCallbackId);
    expect(cbIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(cbIds).size).toBe(3);

    // The gate row was bound to the ACTUAL callback the test resumed.
    expect(world.gateCallbackBindings).toHaveLength(1);
    expect(world.gateCallbackBindings[0]).toMatchObject({ executionId: 'i1', humanTaskId: 'h1' });
    expect(world.gateCallbackBindings[0].callbackId).toBe(gateOp.getCallbackDetails().callbackId);

    // Terminal status written exactly once.
    expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
    expect(world.events).toContain('v2.execution.succeeded');
  });

  it('a stage verdict of FAILED delivered through the callback fails the run after replay', async () => {
    const world = makeWorld({ stages: [{ stageId: 'a' }] });
    const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const executionPromise = runner.run({
      payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
    });

    await completeStage(runner, 'stage-cb-a', {
      ok: false,
      state: 'FAILED',
      reason: 'sensor_blocked',
      detail: 'lint failed',
    });

    const execution = await executionPromise;
    expect(execution.getResult()).toMatchObject({ ok: false, reason: 'stage_failed' });
    expect(world.statusWrites).toContain('FAILED');
    expect(world.events).toContain('v2.execution.failed');
    // Only one dispatch — the failure verdict was not retried implicitly.
    expect(world.invokes.filter((p) => p.command === 'run-stage-start')).toHaveLength(1);
  });

  it('a cancel sentinel on the gate callback retires the run without terminal writes', async () => {
    const world = makeWorld({ stages: [{ stageId: 'a' }] });
    const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });

    const executionPromise = runner.run({
      payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
    });

    world.pendingHumanTaskId = 'h1';
    world.gateStatus = 'pending';
    await completeStage(runner, 'stage-cb-a', {
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      humanTaskId: 'h1',
    });

    // Cancel/rewind path: supersede the gate, wake the callback with the
    // sentinel lambda/intents sends.
    const gateOp = await runner
      .getOperation('await-h1')
      .waitForData(WaitingOperationStatus.STARTED);
    world.gateStatus = 'superseded';
    await gateOp.sendCallbackSuccess(JSON.stringify({ cancelled: true, reason: 'cancel' }));

    const execution = await executionPromise;
    expect(execution.getResult()).toMatchObject({ ok: false, reason: 'retired' });
    // No resume leg, no terminal status — the cancel/rewind path owns META.
    expect(
      world.invokes.filter((p) => p.command === 'run-stage-start' && p.resumeFrom),
    ).toHaveLength(0);
    expect(world.statusWrites).not.toContain('SUCCEEDED');
    expect(world.statusWrites).not.toContain('FAILED');
  });
});
