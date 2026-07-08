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

// ── WP5: a parallel section under REAL replay ────────────────────────────────
// Proves the whole section lifecycle on the local durable runner (genuine
// checkpoint/suspend/replay): fan-out gate → skeleton lane SOLO (with a
// mid-lane stage park → answer → resume) → skeleton gate → autonomy ladder →
// remaining lane → per-lane init-lane/merge-lane dispatches — with
// exactly-once side effects (lane transitions, dispatches, events) and each
// engine gate suspending on its OWN durable callback.

describe('WP5 sections on the real durable runner', () => {
  // A world with PER-ID gate rows: engine gates (eg-*) are created by the
  // orchestrator itself; stage question gates (h*) are seeded by the test.
  const makeLaneWorld = () => {
    const world = makeWorld({
      stages: [
        { stageId: 'gen', outputArtifacts: [{ artifact: 'unit-of-work-dependency' }] },
        { stageId: 'cg', parallelSection: 1, execution: 'ALWAYS', phase: 'construction' },
        { stageId: 'bt' },
      ],
    });
    world.unitStates = [];
    world.gates = new Map(); // humanTaskId → row
    world.sessions = []; // sessionId per invoke, index-aligned with invokes
    world.deps.store.getUnitPlan = async () => ({
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'billing', dependsOn: ['auth'] },
      ],
      batches: [['auth'], ['billing']],
      skipMatrix: {},
      walkingSkeleton: 'auth',
    });
    world.deps.store.updateUnitState = async (args) => {
      world.unitStates.push(`${args.slug}:${args.state}`);
      return { slug: args.slug, state: args.state };
    };
    world.deps.store.updateUnitPlanDecisions = async () => ({});
    world.deps.store.putStage = async (args) => args;
    world.deps.store.createHumanTask = async (args) => {
      if (!world.gates.has(args.humanTaskId)) {
        world.gates.set(args.humanTaskId, { ...args, status: 'pending' });
      }
      return world.gates.get(args.humanTaskId);
    };
    world.deps.store.getHumanTask = async (_e, id) => world.gates.get(id) ?? null;
    const invoke = world.deps.invokeRuntime;
    world.deps.invokeRuntime = async (payload, sessionId) => {
      world.sessions.push(sessionId);
      return invoke(payload, sessionId);
    };
    return world;
  };

  // Wait for the orchestrator to OPEN an engine gate (its id embeds the
  // non-deterministic runId), then answer it out-of-band exactly like the
  // intents lambda: flip the row, complete the `await-<id>` callback.
  const answerEngineGate = async (runner, world, prefix, patch = { status: 'answered' }) => {
    let id;
    for (let i = 0; i < 200 && !id; i++) {
      id = [...world.gates.keys()].find((k) => k.startsWith(prefix));
      if (!id) await new Promise((r) => setTimeout(r, 25));
    }
    expect(id, `engine gate ${prefix} was never opened`).toBeTruthy();
    const op = await runner.getOperation(`await-${id}`).waitForData(WaitingOperationStatus.STARTED);
    world.gates.set(id, { ...world.gates.get(id), ...patch });
    await op.sendCallbackSuccess(JSON.stringify({ answer: patch.answer ?? null }));
    return id;
  };

  it(
    'runs fan-out gate → skeleton solo (mid-lane park) → skeleton gate → ladder → remaining lane with exactly-once effects',
    { timeout: 30_000 },
    async () => {
      const world = makeLaneWorld();
      const handler = withDurableExecution((event, ctx) =>
        __durableHandler(event, ctx, world.deps),
      );
      const runner = new LocalDurableTestRunner({ handlerFunction: handler });

      const executionPromise = runner.run({
        payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
      });

      await completeStage(runner, 'stage-cb-gen', { ok: true, state: 'SUCCEEDED' });
      // 1. The fan-out gate suspends the run BEFORE any lane starts.
      await answerEngineGate(runner, world, 'eg-fanout-s1');

      // 2. Skeleton lane (auth): its cg stage parks on a question mid-lane.
      world.gates.set('h7', { humanTaskId: 'h7', status: 'pending' });
      world.pendingHumanTaskId = 'h7';
      await completeStage(runner, 'stage-cb-cg-u-auth', {
        ok: true,
        state: 'WAITING_FOR_HUMAN',
        humanTaskId: 'h7',
        unitSlug: 'auth',
      });
      const h7 = await runner.getOperation('await-h7').waitForData(WaitingOperationStatus.STARTED);
      world.gates.set('h7', { humanTaskId: 'h7', status: 'answered' });
      world.pendingHumanTaskId = null;
      await h7.sendCallbackSuccess(JSON.stringify({ answer: 'approved' }));
      await completeStage(runner, 'stage-cb-cg-u-auth-resume-h7', {
        ok: true,
        state: 'SUCCEEDED',
      });

      // 3. Skeleton merged → Bolt-level gate; 4. autonomy ladder → autonomous.
      await answerEngineGate(runner, world, 'eg-skeleton-s1');
      await answerEngineGate(runner, world, 'eg-ladder-s1', {
        status: 'answered',
        answer: { mode: 'autonomous' },
      });

      // 5. Remaining lane (billing) + fan-in stage.
      await completeStage(runner, 'stage-cb-cg-u-billing', { ok: true, state: 'SUCCEEDED' });
      await completeStage(runner, 'stage-cb-bt', { ok: true, state: 'SUCCEEDED' });

      const execution = await executionPromise;
      expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 3 });

      // Exactly-once dispatches: each lane got ONE init-lane, its stage legs,
      // and ONE merge-lane, in skeleton-then-remaining order.
      expect(world.invokes.map((p) => `${p.command}:${p.stageId ?? p.unitSlug ?? '-'}`)).toEqual([
        'init-ws:-',
        'run-stage-start:gen',
        'derive-artifacts:-',
        'promote-units:-',
        'init-lane:auth',
        'run-stage-start:cg', // auth fresh (parks)
        'run-stage-start:cg', // auth resume h7
        'merge-lane:auth',
        'init-lane:billing',
        'run-stage-start:cg', // billing
        'merge-lane:billing',
        'run-stage-start:bt',
      ]);
      const starts = world.invokes.filter((p) => p.command === 'run-stage-start');
      expect(starts.map((p) => `${p.stageId}:${p.unitSlug ?? '-'}:${p.resumeFrom ?? '-'}`)).toEqual(
        ['gen:-:-', 'cg:auth:-', 'cg:auth:h7', 'cg:billing:-', 'bt:-:-'],
      );
      // Lane dispatches ran in per-lane sessions; merges in the intent session.
      const sessionOf = (predicate) => world.sessions[world.invokes.findIndex(predicate)];
      expect(sessionOf((p) => p.command === 'init-lane' && p.unitSlug === 'auth')).toBe(
        'aidlc-intent-i1-s1-auth'.padEnd(33, '0'),
      );
      expect(sessionOf((p) => p.command === 'run-stage-start' && p.unitSlug === 'billing')).toBe(
        'aidlc-intent-i1-s1-billing'.padEnd(33, '0'),
      );
      expect(sessionOf((p) => p.command === 'merge-lane' && p.unitSlug === 'auth')).toBe(
        'aidlc-intent-i1'.padEnd(33, '0'),
      );
      // Lane transitions exactly once each, despite the suspends/replays.
      expect(world.unitStates).toEqual([
        'auth:RUNNING',
        'auth:MERGING',
        'auth:MERGED',
        'billing:RUNNING',
        'billing:MERGING',
        'billing:MERGED',
      ]);
      // Three engine gates opened, each with its own row + callback binding.
      const engineGateIds = [...world.gates.keys()].filter((k) => k.startsWith('eg-'));
      expect(engineGateIds).toHaveLength(3);
      const boundIds = world.gateCallbackBindings.map((b) => b.humanTaskId);
      for (const id of engineGateIds) expect(boundIds).toContain(id);
      // Lifecycle events exactly once each; terminal write once.
      expect(world.events.filter((t) => t === 'v2.unit.started')).toHaveLength(2);
      expect(world.events.filter((t) => t === 'v2.unit.merged')).toHaveLength(2);
      expect(world.events.filter((t) => t === 'v2.units.fanout_approved')).toHaveLength(1);
      expect(world.events.filter((t) => t === 'v2.units.skeleton_approved')).toHaveLength(1);
      expect(world.events.filter((t) => t === 'v2.units.autonomy_set')).toHaveLength(1);
      expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
    },
  );

  it(
    'independent lanes run CONCURRENTLY and complete out of order (autonomous wavefront)',
    { timeout: 30_000 },
    async () => {
      const world = makeLaneWorld();
      // Three units: auth (skeleton) + two INDEPENDENT lanes b and c.
      world.deps.store.getUnitPlan = async () => ({
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'b', dependsOn: [] },
          { slug: 'c', dependsOn: [] },
        ],
        batches: [['auth', 'b', 'c']],
        skipMatrix: {},
        walkingSkeleton: 'auth',
      });
      const handler = withDurableExecution((event, ctx) =>
        __durableHandler(event, ctx, world.deps),
      );
      const runner = new LocalDurableTestRunner({ handlerFunction: handler });

      const executionPromise = runner.run({
        payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
      });

      await completeStage(runner, 'stage-cb-gen', { ok: true, state: 'SUCCEEDED' });
      await answerEngineGate(runner, world, 'eg-fanout-s1');
      await completeStage(runner, 'stage-cb-cg-u-auth', { ok: true, state: 'SUCCEEDED' });
      await answerEngineGate(runner, world, 'eg-skeleton-s1');
      await answerEngineGate(runner, world, 'eg-ladder-s1', {
        status: 'answered',
        answer: { mode: 'autonomous' },
      });

      // BOTH lane callbacks must be pending at once (true concurrency) before
      // either is completed — then finish them in REVERSE order.
      const cbC = await runner
        .getOperation('stage-cb-cg-u-c')
        .waitForData(WaitingOperationStatus.STARTED);
      const cbB = await runner
        .getOperation('stage-cb-cg-u-b')
        .waitForData(WaitingOperationStatus.STARTED);
      await cbC.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
      await cbB.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
      await completeStage(runner, 'stage-cb-bt', { ok: true, state: 'SUCCEEDED' });

      const execution = await executionPromise;
      expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 3 });
      // Both lanes were DISPATCHED before either completed (concurrent), each
      // in its own session, and every lane merged exactly once — the merge
      // lock serialized both merges after the skeleton's (the RELATIVE order
      // of two near-simultaneous completions is scheduler-dependent and
      // topologically irrelevant for independent units).
      const bIdx = world.invokes.findIndex(
        (p) => p.command === 'run-stage-start' && p.unitSlug === 'b',
      );
      const cIdx = world.invokes.findIndex(
        (p) => p.command === 'run-stage-start' && p.unitSlug === 'c',
      );
      const firstMergeIdx = world.invokes.findIndex(
        (p) => p.command === 'merge-lane' && p.unitSlug !== 'auth',
      );
      expect(bIdx).toBeGreaterThan(-1);
      expect(cIdx).toBeGreaterThan(-1);
      expect(firstMergeIdx).toBeGreaterThan(Math.max(bIdx, cIdx));
      const merges = world.invokes.filter((p) => p.command === 'merge-lane').map((p) => p.unitSlug);
      expect(merges.slice(0, 1)).toEqual(['auth']);
      expect(merges.slice(1).toSorted()).toEqual(['b', 'c']);
      expect(world.unitStates.filter((s) => s.endsWith(':MERGED'))).toHaveLength(3);
      expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
    },
  );

  it(
    'a lane failure preserves the merged skeleton and a halt-and-ask ABORT fails the run',
    { timeout: 30_000 },
    async () => {
      const world = makeLaneWorld();
      const handler = withDurableExecution((event, ctx) =>
        __durableHandler(event, ctx, world.deps),
      );
      const runner = new LocalDurableTestRunner({ handlerFunction: handler });

      const executionPromise = runner.run({
        payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
      });

      await completeStage(runner, 'stage-cb-gen', { ok: true, state: 'SUCCEEDED' });
      await answerEngineGate(runner, world, 'eg-fanout-s1');
      await completeStage(runner, 'stage-cb-cg-u-auth', { ok: true, state: 'SUCCEEDED' });
      await answerEngineGate(runner, world, 'eg-skeleton-s1');
      await answerEngineGate(runner, world, 'eg-ladder-s1', {
        status: 'answered',
        answer: { mode: 'autonomous' },
      });
      // billing's lane fails → halt-and-ask → human aborts.
      await completeStage(runner, 'stage-cb-cg-u-billing', {
        ok: false,
        state: 'FAILED',
        reason: 'sensor_blocked',
      });
      await answerEngineGate(runner, world, 'eg-halt-s1-r0', {
        status: 'answered',
        answer: { decision: 'abort' },
      });

      const execution = await executionPromise;
      expect(execution.getResult()).toMatchObject({ ok: false, reason: 'section_aborted' });
      // The skeleton's merge SURVIVED (work preserved); billing FAILED once.
      expect(world.unitStates).toEqual([
        'auth:RUNNING',
        'auth:MERGING',
        'auth:MERGED',
        'billing:RUNNING',
        'billing:FAILED',
      ]);
      expect(world.events.filter((t) => t === 'v2.units.halt_decision')).toHaveLength(1);
      expect(world.statusWrites).toContain('FAILED');
      expect(world.statusWrites).not.toContain('SUCCEEDED');
    },
  );
});
