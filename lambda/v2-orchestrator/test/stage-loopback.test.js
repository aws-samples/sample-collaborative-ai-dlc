// Build-and-Test loop-back at the validation gate.
//
// The rule itself is unit-tested in lambda/shared/test/stage-loopback.test.js.
// This file asserts what only the walk can show: the third gate option, stage-row
// resets with attempt bumps, the target re-running, the cap, the option's absence
// outside release mode, and the recommendation behavior at the cap.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';
import {
  LOOP_BACK_RECOMMENDED_EVENT,
  LOOP_BACK_RECORDED_EVENT,
} from '../../shared/stage-loopback.js';
import { buildEventRow, buildStageRow } from '../../shared/v2-process-keys.js';

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

// Timeline fixtures go through the SAME row builder the process store persists
// with, so `listEvents` returns the production shape (`type: 'Event'`, the name
// in `eventType`) and a reader keyed on the wrong field fails here.
let eventSeq = 0;
const persistedEvent = (fields) => {
  eventSeq += 1;
  return buildEventRow({
    executionId: 'exec-1',
    actor: 'agentcore',
    summary: '',
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, eventSeq)).toISOString(),
    eventId: `ev-${eventSeq}`,
    ...fields,
  });
};

const recommendation = (attempt = 0, stageInstanceId = 'si-bt') =>
  persistedEvent({
    type: LOOP_BACK_RECOMMENDED_EVENT,
    stageInstanceId,
    detail: { attempt, reason: 'integration tests fail against the generated payment code' },
  });
let deps;
let ctx;
let stageRuns;

const makeRuntime = () => {
  return vi.fn(async (payload) => {
    if (payload.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
    if (payload.command === 'init-ws') return { ok: true };
    if (payload.command === 'run-stage-start') {
      stageRuns.push(payload.stageId);
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
      getStage: vi.fn(async (_e, stageInstanceId) => {
        return (
          stageRows.get(stageInstanceId) ?? {
            stageInstanceId,
            attempt: attempts.get(stageInstanceId) ?? 0,
          }
        );
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
      resetStageRow: vi.fn(async ({ stageInstanceId, loopBackId }) => {
        attempts.set(stageInstanceId, (attempts.get(stageInstanceId) ?? 0) + 1);
        if (loopBackId) loopBackState.count += 1;
        const row = {
          ...stageRows.get(stageInstanceId),
          stageInstanceId,
          state: 'PENDING',
          attempt: attempts.get(stageInstanceId),
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
    deps.store.listEvents = vi.fn(async () => [recommendation(0)]);
    await run();
    expect(gates()[0].options).toEqual(['approve', 'request-changes']);
    expect(gates()[0]).not.toHaveProperty('loopBackTarget');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
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
    deps.store.listEvents = vi.fn(async () => [recommendation(0)]);
    await run();
    expect(gates()[0].options).toEqual(['approve', 'request-changes']);
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });
});

describe('a recommended loop-back the human accepts', () => {
  beforeEach(() => {
    deps.store.listEvents = vi.fn(async () => [recommendation(0)]);
    deps.store.getHumanTask = gateScript([{ decision: 'loop-back' }, { decision: 'approve' }]);
  });

  it('offers the option naming the computed target, with the remaining budget', async () => {
    await run();
    const gate = gates()[0];
    expect(gate.options).toEqual(['approve', 'request-changes', 'loop-back']);
    expect(gate.loopBackTarget).toBe('code-generation');
    // The stages the loop-back re-runs, in run order, for the UI's confirmation.
    expect(gate.loopBackStages).toEqual(['code-generation', 'build-and-test']);
    expect(gate.prompt).toContain('## The agent recommends going back to the code');
    expect(gate.prompt).toContain('integration tests fail against the generated payment code');
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
    deps.store.listEvents = vi.fn(async () => [recommendation(deps.store.attempts.get('si-bt'))]);
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
    deps.store.listEvents = vi.fn(async () => [recommendation(0), recommendation(0, 'si-bt-2')]);
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

  it.each(['getStage', 'listEvents'])(
    'fails gate setup when the loop-back %s read fails',
    async (method) => {
      if (method === 'getStage') {
        let reads = 0;
        deps.store.getStage = vi.fn(async (executionId, stageInstanceId) => {
          reads += 1;
          if (reads === 2) throw new Error('getStage unavailable');
          return { executionId, stageInstanceId, attempt: 0 };
        });
      } else {
        let reads = 0;
        deps.store.listEvents = vi.fn(async () => {
          reads += 1;
          if (reads === 1) return [];
          throw new Error('listEvents unavailable');
        });
      }

      const result = await run();

      expect(result.ok).toBe(false);
      expect(gates()).toHaveLength(0);
    },
  );
});

describe('loop-back recommendation at the cap', () => {
  beforeEach(() => {
    deps.store.loopBackState.count = 3;
    deps.store.listEvents = vi.fn(async () => [recommendation(0)]);
  });

  it('withholds the option, says why, and leaves the gate answerable', async () => {
    const result = await run();
    expect(result.ok).not.toBe(false);
    const gate = gates()[0];
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate).not.toHaveProperty('loopBackTarget');
    expect(gate).not.toHaveProperty('loopBackStages');
    expect(gate.prompt).toContain('the loop-back limit is spent');
    expect(gate.prompt).toContain('already used all 3 loop-backs');
    expect(gate.prompt).toContain('rewind to code-generation yourself');
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
    expect(events().some((e) => e.type === 'v2.loopback.recorded')).toBe(false);
    expect(events().some((e) => e.type === 'v2.stage.validated')).toBe(true);
  });
});
