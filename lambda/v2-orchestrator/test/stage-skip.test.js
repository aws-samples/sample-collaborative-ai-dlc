import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __durableHandler } from '../index.js';

// Stage-skipping behaviors of the durable orchestrator (shared/stage-skip.js):
//   - intent-level skips (META.skipStageIds) ride load-plan, get SKIPPED audit
//     rows + timeline events, and never dispatch;
//   - gate-time "skip to stage X" (an approve answer carrying `skipTo`) marks
//     the intermediates SKIPPED and jumps the walk to the target;
//   - a rejected/disabled skip degrades to a plain approve, loudly;
//   - rewinds accept SKIPPED upstream rows and re-seed the dispatch overlay.
// Same injected-deps harness as orchestrator.test.js.

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

const makeRuntime = (ctx, script) => {
  let n = 0;
  return vi.fn(async (payload) => {
    invokes.push(payload);
    n += 1;
    const verdict = await script(payload, n);
    if (payload.command === 'run-stage-start') {
      const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
      if (!resolve) throw new Error(`no stage callback registered: ${payload.stageCallbackId}`);
      resolve(verdict);
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return verdict;
  });
};

const okScript = (payload) =>
  payload.command === 'init-ws' ? { ok: true } : { ok: true, state: 'SUCCEEDED' };

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
  parkReleaseSeconds: 300,
};

// Three linear stages: a gates on human validation; b is a skippable
// CONDITIONAL stage; c is the jump target.
const linearStages = () => [
  {
    stageId: 'a',
    stageInstanceId: 'si-a',
    phase: 'inception',
    execution: 'ALWAYS',
    humanValidation: 'required',
    outputArtifacts: [],
  },
  {
    stageId: 'b',
    stageInstanceId: 'si-b',
    phase: 'inception',
    execution: 'CONDITIONAL',
    humanValidation: 'required',
    outputArtifacts: [],
  },
  {
    stageId: 'c',
    stageInstanceId: 'si-c',
    phase: 'inception',
    execution: 'CONDITIONAL',
    humanValidation: 'none',
    outputArtifacts: [],
  },
];

let deps;
let invokes;
let ctx;
beforeEach(() => {
  invokes = [];
  ctx = makeCtx();
  deps = {
    store: {
      getExecution: vi.fn(async () => META),
      updateExecution: vi.fn(async () => ({})),
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      getHumanTask: vi.fn(async () => ({ status: 'answered' })),
      getStage: vi.fn(async () => null),
      putStage: vi.fn(async (args) => args),
      appendEvent: vi.fn(async () => ({})),
    },
    loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: linearStages() } })),
    invokeRuntime: null,
    resolveToken: vi.fn(async () => 'tok'),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
  };
  deps.invokeRuntime = makeRuntime(ctx, okScript);
});

const start = (event = {}) =>
  __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1', ...event }, ctx, deps);
const stageStarts = () => invokes.filter((p) => p.command === 'run-stage-start');
const eventTypes = () => deps.store.appendEvent.mock.calls.map((c) => c[0].type);

// Answer stage a's validation gate with `answer` (gate-pre returns null, then
// the post-callback re-read returns the decided gate). Later gates (a rejected
// skip means b runs and gates too) auto-approve via the default.
const answerValidationGate = (answer) => {
  deps.store.getHumanTask = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ humanTaskId: 'eg-validation-si-a-0', status: 'approved', answer })
    .mockResolvedValue({
      humanTaskId: 'eg-later',
      status: 'approved',
      answer: { decision: 'approve' },
    });
};

describe('intent-level skips (META.skipStageIds)', () => {
  it('forwards the overlay to load-plan and marks the skipped stages SKIPPED with events', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      stageSkipping: 'enabled',
      skipStageIds: ['b'],
    }));
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [linearStages()[0], linearStages()[2]].map((s) => ({
          ...s,
          humanValidation: 'none',
        })),
        skippedStages: [{ stageId: 'b', phase: 'inception', stageInstanceId: 'si-b' }],
      },
    }));

    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.loadPlan).toHaveBeenCalledWith(expect.objectContaining({ skipStageIds: ['b'] }));
    expect(deps.store.putStage).toHaveBeenCalledWith(
      expect.objectContaining({ stageInstanceId: 'si-b', stageId: 'b', state: 'SKIPPED' }),
    );
    expect(eventTypes()).toContain('v2.stage.skipped');
    expect(stageStarts().map((s) => s.stageId)).toEqual(['a', 'c']);
    // The overlay rides every dispatch so the container resolves the same plan.
    for (const s of stageStarts()) expect(s.skipStageIds).toEqual(['b']);
  });

  it('does not re-emit the skipped event when the row is already SKIPPED (rewind relaunch)', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, skipStageIds: ['b'] }));
    deps.store.getStage = vi.fn(async (_e, id) => (id === 'si-b' ? { state: 'SKIPPED' } : null));
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [{ ...linearStages()[2], humanValidation: 'none' }],
        skippedStages: [{ stageId: 'b', phase: 'inception', stageInstanceId: 'si-b' }],
      },
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.store.putStage).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'SKIPPED' }),
    );
    expect(eventTypes()).not.toContain('v2.stage.skipped');
  });
});

describe('gate-time "skip to stage X"', () => {
  it('offers skipTargets on the validation gate when the run has skipping enabled', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, stageSkipping: 'enabled' }));
    answerValidationGate({ decision: 'approve' });
    await start();
    expect(deps.store.createHumanTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'validation', skipTargets: ['c'] }),
    );
  });

  it('omits skipTargets when the run has skipping disabled', async () => {
    answerValidationGate({ decision: 'approve' });
    await start();
    const call = deps.store.createHumanTask.mock.calls.find((c) => c[0].kind === 'validation');
    expect(call[0].skipTargets).toBeUndefined();
  });

  it('an approved skipTo marks the intermediates SKIPPED and jumps to the target', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, stageSkipping: 'enabled' }));
    answerValidationGate({ decision: 'approve', skipTo: 'c' });

    const res = await start();
    expect(res.ok).toBe(true);
    // b was never dispatched; c ran.
    expect(stageStarts().map((s) => s.stageId)).toEqual(['a', 'c']);
    expect(deps.store.putStage).toHaveBeenCalledWith(
      expect.objectContaining({ stageInstanceId: 'si-b', stageId: 'b', state: 'SKIPPED' }),
    );
    expect(eventTypes()).toContain('v2.stage.skipped');
    // The target's dispatch carries the accumulated overlay.
    expect(stageStarts()[1].skipStageIds).toEqual(['b']);
  });

  it('a skipTo on a run with skipping disabled degrades to a plain approve, loudly', async () => {
    answerValidationGate({ decision: 'approve', skipTo: 'c' });
    const res = await start();
    expect(res.ok).toBe(true);
    expect(eventTypes()).toContain('v2.stage.skip_rejected');
    // b still runs (it gates too — answer its own validation gate).
    expect(stageStarts().map((s) => s.stageId)).toContain('b');
    expect(deps.store.putStage).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'SKIPPED' }),
    );
  });

  it('an invalid skipTo (non-skippable intermediate) is rejected and the walk continues', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, stageSkipping: 'enabled' }));
    // Make b ALWAYS — jumping over it must be refused.
    const stages = linearStages();
    stages[1].execution = 'ALWAYS';
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages } }));
    answerValidationGate({ decision: 'approve', skipTo: 'c' });

    const res = await start();
    expect(res.ok).toBe(true);
    expect(eventTypes()).toContain('v2.stage.skip_rejected');
    expect(stageStarts().map((s) => s.stageId)).toContain('b');
  });
});

// Upstream 2.2.6: the validation gate names the COMPUTED next stage — read
// from the flat plan order, never guessed. string = next stageId, null = this
// gate completes the workflow. The prompt carries the same name so chat-only
// surfaces read identically.
describe('validation gate names the computed next stage (2.2.6)', () => {
  it('carries nextStageId = the following plan stage on an intermediate gate', async () => {
    answerValidationGate({ decision: 'approve' });
    await start();
    const call = deps.store.createHumanTask.mock.calls.find(
      (c) => c[0].kind === 'validation' && c[0].stageInstanceId === 'si-a',
    );
    expect(call[0].nextStageId).toBe('b');
    expect(call[0].prompt).toContain('approve to continue to b');
  });

  it('carries nextStageId = null (complete workflow) on the final gating stage', async () => {
    // Make the LAST stage the gating one.
    const stages = linearStages();
    stages[0].humanValidation = 'none';
    stages[1].humanValidation = 'none';
    stages[2].humanValidation = 'required';
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages } }));
    deps.store.getHumanTask = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        humanTaskId: 'eg-any',
        status: 'approved',
        answer: { decision: 'approve' },
      });

    const res = await start();
    expect(res.ok).toBe(true);
    const call = deps.store.createHumanTask.mock.calls.find(
      (c) => c[0].kind === 'validation' && c[0].stageInstanceId === 'si-c',
    );
    expect(call[0].nextStageId).toBeNull();
    expect(call[0].prompt).toContain('final stage');
    expect(call[0].prompt).toContain('complete the workflow');
  });

  it('the live gate broadcast carries the same nextStageId as the row', async () => {
    answerValidationGate({ decision: 'approve' });
    await start();
    const broadcastGate = deps.broadcast.mock.calls
      .map((c) => c[1])
      .find((p) => p?.action === 'agent.question' && p.kind === 'validation');
    expect(broadcastGate.nextStageId).toBe('b');
  });
});

describe('rewind over SKIPPED rows', () => {
  it('accepts a SKIPPED linear upstream row and re-seeds the dispatch overlay', async () => {
    deps.store.getStage = vi.fn(async (_e, id) => {
      if (id === 'si-a') return { state: 'SUCCEEDED' };
      if (id === 'si-b') return { state: 'SKIPPED' };
      return null;
    });
    const stages = linearStages().map((s) => ({ ...s, humanValidation: 'none' }));
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages } }));

    const res = await start({ startAtStageId: 'c' });
    expect(res.ok).toBe(true);
    expect(eventTypes()).not.toContain('v2.execution.failed');
    expect(stageStarts().map((s) => s.stageId)).toEqual(['c']);
    // The prior run's gate-skip is re-seeded so c's prompt still treats b's
    // outputs as expected-absent.
    expect(stageStarts()[0].skipStageIds).toEqual(['b']);
  });

  it('still fails the rewind when an upstream linear stage is neither SUCCEEDED nor SKIPPED', async () => {
    deps.store.getStage = vi.fn(async (_e, id) => (id === 'si-a' ? { state: 'SUCCEEDED' } : null));
    const stages = linearStages().map((s) => ({ ...s, humanValidation: 'none' }));
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages } }));

    const res = await start({ startAtStageId: 'c' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('rewind_upstream_incomplete');
  });
});
