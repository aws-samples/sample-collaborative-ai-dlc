import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __durableHandler } from '../index.js';

// The orchestrator's control flow is driven through an injected `deps` bag and a
// fake DurableContext — no real AWS/Neptune. This isolates the sequencing logic
// (init-ws → stage loop → gate park/resume → terminal status) from I/O.

// A fake DurableContext: step runs the fn; createCallback returns an
// immediately-resolved promise so the park loop proceeds as if answered.
// promise.race/wait model the durable combinators (callback resolves first by
// default, so the release path is not taken unless a test forces it).
const makeCtx = (over = {}) => ({
  logger: { info() {}, debug() {} },
  step: async (_name, fn) => fn(),
  createCallback: async (name) => [Promise.resolve({ answer: null }), `cb-${name}`],
  wait: async () => undefined,
  promise: {
    race: async (_name, promises) => Promise.race(promises),
  },
  ...over,
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
  cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
  parkReleaseSeconds: 300,
};

let deps;
let invokes;
beforeEach(() => {
  invokes = [];
  deps = {
    store: {
      getExecution: vi.fn(async () => META),
      updateExecution: vi.fn(async () => ({})),
      setGateCallbackId: vi.fn(async () => ({})),
      // Default: gate is answered (not pending) by the time we re-read it.
      getHumanTask: vi.fn(async () => ({ status: 'answered' })),
    },
    loadPlan: vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ stageId: 'a' }, { stageId: 'b' }] },
    })),
    invokeRuntime: vi.fn(async (payload) => {
      invokes.push(payload);
      return { ok: true, state: 'SUCCEEDED' };
    }),
    resolveToken: vi.fn(async () => 'tok'),
    stopSession: vi.fn(async () => ({ stopped: true })),
  };
});

describe('orchestrator durable handler', () => {
  it('ignores non-start invocations', async () => {
    const res = await __durableHandler({ action: 'answer', intentId: 'i1' }, makeCtx(), deps);
    expect(res).toEqual({ ok: false, reason: 'not_a_start' });
  });

  it('runs init-ws then every stage to SUCCEEDED', async () => {
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 2 });
    expect(invokes.map((p) => p.command)).toEqual(['init-ws', 'run-stage', 'run-stage']);
    const statuses = deps.store.updateExecution.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain('RUNNING');
    expect(statuses).toContain('SUCCEEDED');
  });

  it('parks on WAITING_FOR_HUMAN, binds a callback, then resumes', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' }); // park-loop gate lookup
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      if (n === 1) return { ok: true }; // init-ws
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.store.setGateCallbackId).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'i1', humanTaskId: 'h1' }),
    );
    const runStages = invokes.filter((p) => p.command === 'run-stage');
    expect(runStages).toHaveLength(2);
    expect(runStages[1].resumeFrom).toBe('h1');
    // Gate answered before the release deadline → no StopRuntimeSession.
    expect(deps.stopSession).not.toHaveBeenCalled();
  });

  it('forwards the project cliModels to run-stage', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const runStages = invokes.filter((p) => p.command === 'run-stage');
    expect(runStages.length).toBeGreaterThan(0);
    for (const rs of runStages) {
      expect(rs.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    }
  });

  it('releases the warm session (StopRuntimeSession) when the park deadline wins', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META)
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    // The gate is STILL pending when re-read after the race → the timer won.
    deps.store.getHumanTask = vi.fn(async () => ({ status: 'pending' }));
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      if (n === 1) return { ok: true };
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    // ctx where the release timer wins the race (resolves before the callback).
    const ctx = makeCtx({
      createCallback: async (name) => [
        new Promise((resolve) => setTimeout(() => resolve({ answer: null }), 5)),
        `cb-${name}`,
      ],
      wait: async () => undefined,
      promise: { race: async (_n, [, waitP]) => waitP },
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.stopSession).toHaveBeenCalledWith(expect.stringContaining('aidlc-intent-i1'));
  });

  it('skips release when parkReleaseSeconds is null', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce({ ...META, parkReleaseSeconds: null })
      .mockResolvedValue({ ...META, parkReleaseSeconds: null, pendingHumanTaskId: 'h1' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      if (n === 1) return { ok: true };
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.stopSession).not.toHaveBeenCalled();
  });

  it('fails the execution when a stage fails', async () => {
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      return n === 1 ? { ok: true } : { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stage_failed');
    expect(deps.store.updateExecution.mock.calls.map((c) => c[0].status)).toContain('FAILED');
  });

  it('fails closed when the plan is invalid', async () => {
    deps.loadPlan.mockResolvedValue({ valid: false, errors: [{ code: 'x' }], plan: null });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('plan_invalid');
  });
});
