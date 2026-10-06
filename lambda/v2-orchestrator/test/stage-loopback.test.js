// Build-and-Test loop-back at the validation gate.
//
// The rule itself is unit-tested in lambda/shared/test/stage-loopback.test.js.
// This file asserts what only the walk can show: the third gate option, stage-row
// resets with attempt bumps, the target re-running, the cap, the option's absence
// outside release mode, and the recommendation behavior at the cap.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';
import { LOOP_BACK_RECORDED_EVENT } from '../../shared/stage-loopback.js';
import { buildStageRow } from '../../shared/v2-process-keys.js';

const makeCtx = (over = {}) => {
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
    ...over,
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
  scope: 'express',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: 300,
  environment: { runtimeArn: 'arn:runtime', runtimeEndpoint: 'revision_r_1' },
};

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'none',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'off',
  skeleton: null,
  loopBack: 'human-offered',
});

// express's stage-level construction: code-generation and build-and-test sit in
// the SAME once-per-workflow segment, which is the shape a loop-back can rewind.
const CODE_GENERATION = {
  stageId: 'code-generation',
  stageInstanceId: 'si-cg',
  humanValidation: 'none',
  outputArtifacts: [{ artifact: 'code-generation-plan' }, { artifact: 'code-summary' }],
  // Plan Approval governs the code-generation stage, so its receipt is exactly the
  // one a loop-back must invalidate.
  policy: { ...POLICY, planApproval: 'required' },
};
const BUILD_AND_TEST = {
  stageId: 'build-and-test',
  stageInstanceId: 'si-bt',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: 'build-test-results' }],
  policy: POLICY,
};
const CODE_GENERATION_2 = {
  ...CODE_GENERATION,
  stageId: 'code-generation-2',
  stageInstanceId: 'si-cg-2',
};
const BUILD_AND_TEST_2 = {
  ...BUILD_AND_TEST,
  stageId: 'build-and-test-2',
  stageInstanceId: 'si-bt-2',
};

const REASON = 'integration tests fail against the generated payment code';

let deps;
let ctx;
let stageRuns;
let dispatches;
let recommending;
let recommendations;

const makeRuntime = () => {
  return vi.fn(async (payload) => {
    if (payload.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
    if (payload.command === 'init-ws') return { ok: true };
    if (payload.command === 'run-stage-start') {
      stageRuns.push(payload.stageId);
      dispatches.push(payload);
      // The agent records a recommendation through emit_stage_note on every run.
      if (recommending.has(payload.stageId)) {
        await deps.store.setLoopBackRecommendation({
          executionId: 'i1',
          stageInstanceId: payload.stageId === 'build-and-test' ? 'si-bt' : 'si-bt-2',
          reason: REASON,
        });
      }
      await deps.store.putStage({
        executionId: 'i1',
        stageInstanceId: payload.stageInstanceId,
        stageId: payload.stageId,
        state: 'RUNNING',
      });
      const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
      resolve({ ok: true, state: 'SUCCEEDED' });
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  });
};

// A gate script: one answer per gate the walk opens, in order. Each gate is read
// as pending-absent first (so createHumanTask is observable), then answered.
const gateScript = (answers) => {
  const byId = new Map();
  let cursor = 0;
  return vi.fn(async (_executionId, humanTaskId) => {
    if (byId.has(humanTaskId)) return byId.get(humanTaskId);
    const answer = answers[Math.min(cursor, answers.length - 1)];
    cursor += 1;
    byId.set(humanTaskId, {
      humanTaskId,
      status:
        answer?.decision === 'request-changes' || answer?.decision === 'loop-back'
          ? 'rejected'
          : 'answered',
      answer,
      answeredBy: 'u1',
      answeredByName: 'Ada',
      stageInstanceId: humanTaskId.includes('si-bt-2') ? 'si-bt-2' : 'si-bt',
    });
    return null;
  });
};

beforeEach(() => {
  ctx = makeCtx();
  stageRuns = [];
  dispatches = [];
  recommending = new Set();
  recommendations = new Map();
  const attempts = new Map([
    ['si-cg', 0],
    ['si-bt', 0],
    ['si-cg-2', 0],
    ['si-bt-2', 0],
  ]);
  const loopBackState = { count: 0 };
  const stageRows = new Map();
  // What the first pass left behind: the plan approval the human gave before any
  // code was written, and the reviewer's verdict on it. Both bound to attempt 0.
  const receipts = [
    { kind: 'plan-approval', stageInstanceId: 'si-cg', attempt: 0, sk: 'RECEIPT#plan-approval' },
    { kind: 'stage-approval', stageInstanceId: 'si-cg', attempt: 0, sk: 'RECEIPT#stage-approval' },
  ];
  deps = {
    store: {
      attempts,
      loopBackState,
      getExecution: vi.fn(async () => ({ ...META, loopBackCount: loopBackState.count })),
      updateExecution: vi.fn(async () => ({})),
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      getHumanTask: gateScript([{ decision: 'approve' }]),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (args) => args),
      failRunningStageAttempt: vi.fn(async () => null),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      getStage: vi.fn(async (_e, stageInstanceId) => ({
        ...(stageRows.get(stageInstanceId) ?? {
          stageInstanceId,
          attempt: attempts.get(stageInstanceId) ?? 0,
        }),
        ...(recommendations.has(stageInstanceId)
          ? { loopBackRecommendation: recommendations.get(stageInstanceId) }
          : {}),
      })),
      setLoopBackRecommendation: vi.fn(async ({ stageInstanceId, reason }) => {
        if (reason) recommendations.set(stageInstanceId, reason);
        else recommendations.delete(stageInstanceId);
      }),
      updateStageState: vi.fn(async (input) => input),
      putStage: vi.fn(async (input) => {
        const row = buildStageRow({
          ...input,
          attempt: attempts.get(input.stageInstanceId) ?? 0,
          now: 'T',
        });
        stageRows.set(input.stageInstanceId, row);
        return row;
      }),
      // Both rows of one loop-back are reset under the SAME gate id; only the
      // target's reset counts against the per-intent cap, and a replay of either
      // must not bump the attempt again.
      resetStageRow: vi.fn(async ({ stageInstanceId, loopBackId, countsAgainstCap = true }) => {
        const seen = stageRows.get(stageInstanceId);
        if (loopBackId && seen?.lastLoopBackId === loopBackId) {
          return { ...seen, loopBackCount: loopBackState.count };
        }
        attempts.set(stageInstanceId, (attempts.get(stageInstanceId) ?? 0) + 1);
        if (loopBackId && countsAgainstCap) loopBackState.count += 1;
        const row = {
          ...seen,
          stageInstanceId,
          state: 'PENDING',
          attempt: attempts.get(stageInstanceId),
          ...(loopBackId ? { lastLoopBackId: loopBackId } : {}),
        };
        stageRows.set(stageInstanceId, row);
        return {
          ...row,
          loopBackCount: loopBackState.count,
        };
      }),
      receipts,
      listReceipts: vi.fn(async (_e, { stageInstanceId, attempt } = {}) =>
        receipts.filter(
          (row) =>
            (stageInstanceId == null || row.stageInstanceId === stageInstanceId) &&
            (attempt == null || Number(row.attempt) === Number(attempt)),
        ),
      ),
      listEvents: vi.fn(async () => []),
      putReceipt: vi.fn(async (args) => args),
    },
    loadPlan: vi.fn(async () => ({
      valid: true,
      plan: { stages: [CODE_GENERATION, BUILD_AND_TEST] },
    })),
    invokeRuntime: null,
    issueAgentCredentialGrant: vi.fn(async () => 'grant'),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
    openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
    comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
    applicationUrl: 'https://aidlc.example.test/',
  };
  deps.invokeRuntime = makeRuntime();
});

const run = () =>
  __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
const gates = () => deps.store.createHumanTask.mock.calls.map(([args]) => args);
const events = () => deps.store.appendEvent.mock.calls.map(([args]) => args);

describe('without an agent recommendation', () => {
  it('opens the ordinary two-option gate and never reads a loop-back target', async () => {
    const result = await run();
    expect(result.ok).not.toBe(false);
    expect(gates()).toHaveLength(1);
    expect(gates()[0].options).toEqual(['approve', 'request-changes']);
    expect(gates()[0]).not.toHaveProperty('loopBackTarget');
    expect(gates()[0].prompt).not.toContain('loop-back');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });
});

describe('outside release mode', () => {
  it('withholds the option even when a recommendation event exists', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [
          { ...CODE_GENERATION, policy: null },
          { ...BUILD_AND_TEST, policy: null },
        ],
      },
    }));
    recommending.add('build-and-test');
    await run();
    expect(gates()[0].options).toEqual(['approve', 'request-changes']);
    expect(gates()[0]).not.toHaveProperty('loopBackTarget');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });

  it('records no loop-back durable step for a stage without a release policy', async () => {
    const names = [];
    ctx = makeCtx({
      step: async (name, fn) => {
        names.push(name);
        return fn();
      },
    });
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [
          { ...CODE_GENERATION, policy: null },
          { ...BUILD_AND_TEST, policy: null },
        ],
      },
    }));
    recommending.add('build-and-test');
    await run();
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name.startsWith('loop-back-'))).toEqual([]);
  });

  it('withholds the option for a release whose catalog has no construction loop-back', async () => {
    const policy = { ...POLICY, loopBack: null };
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [
          { ...CODE_GENERATION, policy },
          { ...BUILD_AND_TEST, policy },
        ],
      },
    }));
    recommending.add('build-and-test');
    await run();
    expect(gates()[0].options).toEqual(['approve', 'request-changes']);
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });
});

describe('a recommended loop-back the human accepts', () => {
  beforeEach(() => {
    recommending.add('build-and-test');
    deps.store.getHumanTask = gateScript([{ decision: 'loop-back' }, { decision: 'approve' }]);
  });

  it('offers the option naming the computed target, with the remaining budget', async () => {
    await run();
    const gate = gates()[0];
    expect(gate.options).toEqual(['approve', 'request-changes', 'loop-back']);
    expect(gate.loopBackTarget).toBe('code-generation');
    expect(gate.loopBackReason).toBe(REASON);
    expect(gate.prompt).toContain('## The agent recommends going back to the code');
    expect(gate.prompt).toContain(REASON);
    expect(gate.prompt).toContain('Choose loop-back to send this work back to code-generation');
    expect(gate.prompt).toContain('3 of 3 loop-backs remain for this intent');
    expect(deps.store.getExecution).toHaveBeenCalledWith('i1', { consistentRead: true });
  });

  it('resets every row from the target through the current stage, bumping each attempt', async () => {
    await run();
    const reset = deps.store.resetStageRow.mock.calls.map(([args]) => args.stageInstanceId);
    expect(reset).toEqual(['si-bt', 'si-cg']);
    expect(deps.store.attempts.get('si-cg')).toBe(1);
    expect(deps.store.attempts.get('si-bt')).toBe(1);
    expect(deps.store.loopBackState.count).toBe(1);
  });

  it('invalidates the prior plan-approval and review receipts by attempt, deleting nothing', async () => {
    await run();
    // Nothing was deleted — both receipts are still in the table…
    expect(deps.store.receipts).toHaveLength(2);
    // …and both are unreachable, because the reset bumped the attempt they were
    // bound to. That is upstream's STAGE_JUMPED invalidation with no delete path.
    const after = await deps.store.listReceipts('i1', {
      stageInstanceId: 'si-cg',
      attempt: deps.store.attempts.get('si-cg'),
    });
    expect(after).toEqual([]);
    expect(
      await deps.store.listReceipts('i1', { stageInstanceId: 'si-cg', attempt: 0 }),
    ).toHaveLength(2);
    // The gate on the second pass reads the bumped attempt, not the stale one.
    const attemptsQueried = deps.store.listReceipts.mock.calls
      .filter(([, args]) => args?.stageInstanceId === 'si-bt')
      .map(([, args]) => args.attempt);
    expect(attemptsQueried).toEqual([0, 1]);
  });

  // The stage being sent BACK is invalidated the same way the target is. It was
  // reset without a loop-back id, so its read was eventually consistent and its
  // write carried no attempt condition: a stale read could have written an attempt
  // another writer already used, and `listReceipts` filters on exactly that number,
  // so this pass's own rejected evidence would have stayed reachable.
  it('invalidates the recommending stage’s own receipts from the rejected pass', async () => {
    deps.store.receipts.push({
      kind: 'stage-approval',
      stageInstanceId: 'si-bt',
      attempt: 0,
      sk: 'RECEIPT#stage-approval',
    });
    await run();
    expect(deps.store.attempts.get('si-bt')).toBe(1);
    expect(
      await deps.store.listReceipts('i1', {
        stageInstanceId: 'si-bt',
        attempt: deps.store.attempts.get('si-bt'),
      }),
    ).toEqual([]);
    // Nothing deleted: the receipt is still there, bound to the attempt it was
    // written under.
    expect(
      await deps.store.listReceipts('i1', { stageInstanceId: 'si-bt', attempt: 0 }),
    ).toHaveLength(1);
    // And it was reset with the guards the target gets: a consistent read, an
    // attempt CAS, and a replay identity — without a second tally against the cap.
    expect(
      deps.store.resetStageRow.mock.calls.find(([args]) => args.stageInstanceId === 'si-bt')[0],
    ).toMatchObject({ loopBackId: gates()[0].humanTaskId, countsAgainstCap: false });
  });

  // A lost CAS means another writer already moved the row. Continuing would leave
  // this pass's receipts reachable under the new attempt, so the walk fails closed.
  it('fails the loop-back when the recommending stage’s reset loses its attempt CAS', async () => {
    const real = deps.store.resetStageRow;
    deps.store.resetStageRow = vi.fn(async (args) =>
      args.stageInstanceId === 'si-bt' ? null : real(args),
    );
    const result = await run();
    expect(result).toMatchObject({ ok: false, reason: 'loopback_reset_failed' });
    // The target was never reset, so the cap was not spent on a jump that did not
    // happen.
    expect(deps.store.resetStageRow.mock.calls.map(([args]) => args.stageInstanceId)).toEqual([
      'si-bt',
    ]);
    expect(deps.store.loopBackState.count).toBe(0);
    expect(events().some((e) => e.type === LOOP_BACK_RECORDED_EVENT)).toBe(false);
  });

  // The failure belongs to the stage whose reset failed. The target was never
  // written, so reporting IT would send an operator to the wrong stage.
  it('blames the recommending stage, not the untouched target, when its own reset fails', async () => {
    const real = deps.store.resetStageRow;
    deps.store.resetStageRow = vi.fn(async (args) =>
      args.stageInstanceId === 'si-bt' ? null : real(args),
    );

    const result = await run();

    expect(result.reason).toBe('loopback_reset_failed');
    const failedStages = deps.store.updateStageState.mock.calls
      .map(([args]) => args)
      .filter((args) => args.state === 'FAILED')
      .map((args) => args.stageInstanceId);
    expect(failedStages).toEqual(['si-bt']);
    expect(failedStages).not.toContain('si-cg');
    expect(
      deps.store.updateStageState.mock.calls
        .map(([args]) => args)
        .find((args) => args.state === 'FAILED').runtimeError,
    ).toContain('loopback_reset_failed');
    // And the execution-level reason names that stage too.
    expect(
      deps.store.updateExecution.mock.calls
        .map(([args]) => args)
        .find((args) => args.status === 'FAILED').failureReason,
    ).toContain('build-and-test');
  });

  it('records the decision on the timeline and re-runs the target stage', async () => {
    const result = await run();
    expect(result.ok).not.toBe(false);
    const recorded = events().filter((e) => e.type === 'v2.loopback.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].summary).toContain('sent build-and-test back to code-generation');
    expect(recorded[0].summary).toContain('loop-back 1 of 3');
    // The walk actually went back: both stages ran twice, in order.
    expect(stageRuns).toEqual([
      'code-generation',
      'build-and-test',
      'code-generation',
      'build-and-test',
    ]);
  });

  it('re-runs code generation with the loop-back answer, so it gets the reason and the feedback', async () => {
    deps.store.getHumanTask = gateScript([
      { decision: 'loop-back', feedback: 'check the refund path' },
      { decision: 'approve' },
    ]);
    await run();
    const [gate] = gates();
    expect(gate.loopBackReason).toBe(REASON);
    const resumesOf = (stageId) =>
      dispatches
        .filter((payload) => payload.stageId === stageId)
        .map((payload) => payload.resumeFrom ?? null);
    expect(resumesOf('code-generation')).toEqual([null, gate.humanTaskId]);
    expect(resumesOf('build-and-test')).toEqual([null, null]);
  });

  it('records the loop-back under the gate id, which is unique to this run', async () => {
    await run();
    const gateId = gates()[0].humanTaskId;
    // BOTH rows are reset under that one id — the recommending stage needs the same
    // consistent read, attempt CAS and replay identity as the target — and only the
    // target's reset counts against the per-intent cap.
    expect(
      deps.store.resetStageRow.mock.calls.map(([args]) => [
        args.stageInstanceId,
        args.loopBackId,
        args.countsAgainstCap ?? true,
      ]),
    ).toEqual([
      ['si-bt', gateId, false],
      ['si-cg', gateId, true],
    ]);
    expect(gateId).toContain('-run-');
    expect(deps.store.loopBackState.count).toBe(1);
  });

  it('clears the recommendation once the gate has read it', async () => {
    await run();
    expect(deps.store.setLoopBackRecommendation).toHaveBeenCalledWith({
      executionId: 'i1',
      stageInstanceId: 'si-bt',
      reason: null,
    });
  });

  it('reads the recommendation without clearing it inside the offer step', async () => {
    let step = null;
    const writesDuringOffer = [];
    ctx = makeCtx({
      step: async (name, fn) => {
        const previous = step;
        step = name;
        try {
          return await fn();
        } finally {
          step = previous;
        }
      },
    });
    const write = deps.store.setLoopBackRecommendation;
    deps.store.setLoopBackRecommendation = vi.fn(async (args) => {
      if (String(step).startsWith('loop-back-offer-')) writesDuringOffer.push(args);
      return write(args);
    });

    await run();

    expect(writesDuringOffer).toEqual([]);
    expect(deps.store.setLoopBackRecommendation).toHaveBeenCalledWith({
      executionId: 'i1',
      stageInstanceId: 'si-bt',
      reason: null,
    });
  });

  it('still offers the loop-back when the offer step re-runs after a crash', async () => {
    // A Lambda that dies after the step body ran but before its result was
    // checkpointed replays the body. The second run must see the same state.
    ctx = makeCtx({
      step: async (name, fn) => {
        if (String(name).startsWith('loop-back-offer-')) await fn();
        return fn();
      },
    });

    await run();

    const gate = gates()[0];
    expect(gate.options).toEqual(['approve', 'request-changes', 'loop-back']);
    expect(gate.loopBackTarget).toBe('code-generation');
    expect(gate.loopBackReason).toBe(REASON);
  });

  it('fails rewindably without recording or applying a jump when a reset fails', async () => {
    const resetStageRow = deps.store.resetStageRow;
    deps.store.resetStageRow = vi.fn(async (input) => {
      if (input.stageInstanceId === 'si-cg') throw new Error('DynamoDB unavailable');
      return resetStageRow(input);
    });

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: 'loopback_reset_failed' });
    expect(events().some((event) => event.type === LOOP_BACK_RECORDED_EVENT)).toBe(false);
    expect(stageRuns).toEqual(['code-generation', 'build-and-test']);
    expect(deps.store.attempts.get('si-cg')).toBe(0);
    expect(deps.store.attempts.get('si-bt')).toBe(1);
    expect(deps.store.loopBackState.count).toBe(0);
    expect(deps.store.updateStageState).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'i1',
        stageInstanceId: 'si-cg',
        state: 'FAILED',
      }),
    );
  });

  it('opens a DISTINCT gate for the second pass, so no memoized answer is replayed', async () => {
    await run();
    const ids = gates().map((gate) => gate.humanTaskId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toContain('lb1');
  });

  it('keeps the three-loop cap when loop-back timeline writes are lost', async () => {
    recommending.add('build-and-test');
    deps.store.getHumanTask = gateScript([
      { decision: 'loop-back' },
      { decision: 'loop-back' },
      { decision: 'loop-back' },
      { decision: 'approve' },
    ]);

    const result = await run();

    expect(result).toMatchObject({ ok: true });
    expect(gates().filter((gate) => gate.options.includes('loop-back'))).toHaveLength(3);
    expect(stageRuns).toEqual([
      'code-generation',
      'build-and-test',
      'code-generation',
      'build-and-test',
      'code-generation',
      'build-and-test',
      'code-generation',
      'build-and-test',
    ]);
    expect(deps.store.loopBackState.count).toBe(3);
  });

  it('shares the loop-back budget across distinct code-generation targets', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [CODE_GENERATION, BUILD_AND_TEST, CODE_GENERATION_2, BUILD_AND_TEST_2] },
    }));
    // The agent recommends on the first run of each build-and-test only.
    const runtime = deps.invokeRuntime;
    const ran = new Set();
    deps.invokeRuntime = vi.fn(async (payload) => {
      if (payload.command === 'run-stage-start' && !ran.has(payload.stageId)) {
        ran.add(payload.stageId);
        if (payload.stageId.startsWith('build-and-test')) recommending.add(payload.stageId);
      }
      const result = await runtime(payload);
      recommending.clear();
      return result;
    });
    deps.store.getHumanTask = gateScript([
      { decision: 'loop-back' },
      { decision: 'approve' },
      { decision: 'loop-back' },
      { decision: 'approve' },
    ]);

    const result = await run();

    expect(result.ok).toBe(true);
    const offered = gates().filter((gate) => gate.options.includes('loop-back'));
    expect(offered.map((gate) => gate.loopBackTarget)).toEqual([
      'code-generation',
      'code-generation-2',
    ]);
    expect(offered[1].prompt).toContain('2 of 3 loop-backs remain for this intent');
    expect(deps.store.loopBackState.count).toBe(2);
  });

  it.each(['getStage', 'getExecution'])(
    'fails gate setup when the loop-back %s read fails',
    async (method) => {
      let step = null;
      ctx = makeCtx({
        step: async (name, fn) => {
          step = name;
          return fn();
        },
      });
      const read = deps.store[method];
      deps.store[method] = vi.fn(async (...args) => {
        if (String(step).startsWith('loop-back-offer-')) throw new Error(`${method} unavailable`);
        return read(...args);
      });

      const result = await run();

      expect(result.ok).toBe(false);
      expect(gates()).toHaveLength(0);
    },
  );
});

describe('a recommendation from an earlier validation round', () => {
  it('is not offered again after request-changes unless the agent repeats it', async () => {
    const runtime = deps.invokeRuntime;
    let buildAndTestRuns = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      if (payload.command === 'run-stage-start' && payload.stageId === 'build-and-test') {
        buildAndTestRuns += 1;
        if (buildAndTestRuns === 1) recommendations.set('si-bt', REASON);
      }
      return runtime(payload);
    });
    deps.store.getHumanTask = gateScript([
      { decision: 'request-changes', feedback: 'tidy the report' },
      { decision: 'approve' },
    ]);
    await run();
    expect(gates().map((gate) => gate.options)).toEqual([
      ['approve', 'request-changes', 'loop-back'],
      ['approve', 'request-changes'],
    ]);
  });
});

describe('a recommendation the plan cannot offer', () => {
  it('says so at the gate instead of dropping it', async () => {
    // Per-unit code generation runs in a parallel section, so build-and-test is
    // the first stage of its segment and has nothing linear to go back to.
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: [BUILD_AND_TEST] } }));
    recommending.add('build-and-test');
    await run();
    const [gate] = gates();
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate).not.toHaveProperty('loopBackTarget');
    expect(gate.prompt).toContain(REASON);
    expect(gate.prompt).toContain('Loop-back is not offered here');
  });
});

describe('loop-back recommendation at the cap', () => {
  beforeEach(() => {
    deps.store.loopBackState.count = 3;
    recommending.add('build-and-test');
  });

  it('withholds the option, says why, and leaves the gate answerable', async () => {
    const result = await run();
    expect(result.ok).not.toBe(false);
    const gate = gates()[0];
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate).not.toHaveProperty('loopBackTarget');
    expect(gate).not.toHaveProperty('loopBackReason');
    expect(gate.prompt).toContain('the loop-back limit is spent');
    expect(gate.prompt).toContain('already used all 3 loop-backs');
    expect(gate.prompt).toContain('rewind to code-generation yourself');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
    expect(events().some((e) => e.type === 'v2.loopback.recorded')).toBe(false);
    expect(events().some((e) => e.type === 'v2.stage.validated')).toBe(true);
  });
});

// The forward walk and the gate's skip targets both read
// `[...intentSkipIds, ...dynamicSkipIds]`; the target derivation read only the
// dynamic half, so the two disagreed about what this run skips. A target the run
// never enters must not be offered, whichever half skipped it.
describe('a target skipped at the intent level', () => {
  it('is not offered, exactly as a gate-flipped skip is not', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      skipStageIds: ['code-generation'],
      loopBackCount: deps.store.loopBackState.count,
    }));
    recommending.add('build-and-test');
    await run();
    const [gate] = gates();
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate).not.toHaveProperty('loopBackTarget');
    expect(gate.prompt).toContain(REASON);
    expect(gate.prompt).toContain('Loop-back is not offered here');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });
});

// Every durable step name in a stage the walk revisits must carry the pass, or
// pass 1's name collides with pass 0's and the replayed step returns the earlier
// result instead of re-emitting. Two names took the bare validation round. The
// pass-0 control proves the token is byte-identical when no loop-back happened,
// so unpinned and 2.3.3 runs keep the exact step names they had.
describe('durable step names in a revisited stage', () => {
  const stepNames = () => {
    const names = [];
    ctx = makeCtx({
      step: async (name, fn) => {
        names.push(name);
        return fn();
      },
    });
    return names;
  };
  // An approve answer may carry a recompose delta; a stage this run has no plan
  // for is rejected per entry, which is the second name under test.
  const APPROVE_WITH_BAD_RECOMPOSE = {
    decision: 'approve',
    recompose: { skip: ['not-in-this-plan'] },
  };

  beforeEach(() => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      stageSkipping: 'enabled',
      loopBackCount: deps.store.loopBackState.count,
    }));
  });

  it('names them by the bare validation round when no loop-back happened', async () => {
    const names = stepNames();
    deps.store.getHumanTask = gateScript([
      { decision: 'request-changes', feedback: 'tidy the report' },
      APPROVE_WITH_BAD_RECOMPOSE,
    ]);

    await run();

    expect(names).toContain('stage-validation-revision-build-and-test-1');
    expect(names).toContain('recompose-rejected-build-and-test-1-not-in-this-plan');
    expect(names.filter((name) => name.includes('lb1-'))).toEqual([]);
  });

  it('carries the pass once a loop-back has sent the stage back', async () => {
    const names = stepNames();
    recommending.add('build-and-test');
    deps.store.getHumanTask = gateScript([
      { decision: 'loop-back' },
      { decision: 'request-changes', feedback: 'still red' },
      APPROVE_WITH_BAD_RECOMPOSE,
    ]);

    const result = await run();

    expect(result.ok).toBe(true);
    expect(names).toContain('stage-validation-revision-build-and-test-lb1-1');
    expect(names).toContain('recompose-rejected-build-and-test-lb1-1-not-in-this-plan');
    // Pass 0 of the same stage already used the bare names, so reusing them in
    // pass 1 is the collision this rule exists to prevent.
    expect(names.filter((name) => name === 'stage-validation-revision-build-and-test-1')).toEqual(
      [],
    );
    expect(
      names.filter((name) => name === 'recompose-rejected-build-and-test-1-not-in-this-plan'),
    ).toEqual([]);
  });
});
