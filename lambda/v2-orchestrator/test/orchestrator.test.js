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
  agentCli: 'kiro',
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
      appendEvent: vi.fn(async () => ({})),
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
    broadcast: vi.fn(async () => {}),
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
    // init-ws carries the provider so the runtime picks the right clone scheme.
    const initWs = invokes.find((p) => p.command === 'init-ws');
    expect(initWs).toMatchObject({ gitProvider: 'github', gitToken: 'tok', repos: ['owner/repo'] });
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

  it('forwards the clone inputs to run-stage so it can self-heal a wiped checkout', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const runStages = invokes.filter((p) => p.command === 'run-stage');
    expect(runStages.length).toBeGreaterThan(0);
    for (const rs of runStages) {
      expect(rs).toMatchObject({
        repos: ['owner/repo'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitToken: 'tok',
        gitProvider: 'github',
      });
    }
  });

  it('forwards the project agentCli to run-stage as requestedCli', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const runStages = invokes.filter((p) => p.command === 'run-stage');
    expect(runStages.length).toBeGreaterThan(0);
    for (const rs of runStages) {
      expect(rs.requestedCli).toBe('kiro');
    }
  });

  it('omits requestedCli when the project has no selected CLI', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, agentCli: null }));
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const runStages = invokes.filter((p) => p.command === 'run-stage');
    expect(runStages.length).toBeGreaterThan(0);
    for (const rs of runStages) {
      expect(rs.requestedCli).toBeUndefined();
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

  it('fails (with reason + event) when init-ws returns ok:false instead of marching on', async () => {
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      // init-ws reports a checkout failure (the runtime returns, does not throw).
      return { ok: false, reason: 'checkout_failed', detail: 'auth' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('init_ws_failed');
    // Never advanced past init-ws into the stage loop.
    expect(invokes.map((p) => p.command)).toEqual(['init-ws']);
    // Status FAILED with a human-readable reason was persisted...
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall).toBeTruthy();
    expect(failCall[0].failureReason).toContain('init_ws_failed');
    // ...and a failure event was emitted for the activity feed.
    const evTypes = deps.store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.execution.failed');
  });

  it('records FAILED + reason when a durable step throws (no silent death)', async () => {
    // A run-stage transport error throws out of the step.
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      if (n === 1) return { ok: true }; // init-ws
      throw new Error('AgentCore 500');
    });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('orchestrator_error');
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall[0].failureReason).toContain('AgentCore 500');
  });

  it('emits workspace lifecycle events so init-ws is visible in the feed', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const evTypes = deps.store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.workspace.initializing');
    expect(evTypes).toContain('v2.workspace.initialized');
    expect(evTypes).toContain('v2.execution.succeeded');
  });

  it('fans out live realtime payloads the UI routes on (workspace + execution)', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    // Every broadcast targets the intent channel and carries a UI routing action.
    for (const call of deps.broadcast.mock.calls) {
      expect(call[0]).toBe('i1'); // intentId (channel key)
      expect(call[1]).toMatchObject({ intentId: 'i1', projectId: 'p1' });
      expect(call[1].action).toMatch(/^agent\.(workspace|execution|note)$/);
    }
    const actions = deps.broadcast.mock.calls.map((c) => c[1].action);
    expect(actions).toContain('agent.workspace'); // init-ws lifecycle
    expect(actions).toContain('agent.execution'); // RUNNING + SUCCEEDED status flips
    // The RUNNING + SUCCEEDED execution transitions both went live.
    const execStatuses = deps.broadcast.mock.calls
      .filter((c) => c[1].action === 'agent.execution')
      .map((c) => c[1].status);
    expect(execStatuses).toContain('RUNNING');
    expect(execStatuses).toContain('SUCCEEDED');
  });

  it('broadcasts FAILED live so the UI flips without a manual refresh', async () => {
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      return { ok: false, reason: 'checkout_failed' }; // init-ws fails
    });
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, makeCtx(), deps);
    const failed = deps.broadcast.mock.calls.find(
      (c) => c[1].action === 'agent.execution' && c[1].status === 'FAILED',
    );
    expect(failed).toBeTruthy();
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

  it('advances a 3-stage plan in order on ONE reused session id', async () => {
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: { stages: [{ stageId: 'a' }, { stageId: 'b' }, { stageId: 'c' }] },
    });
    // Capture the session id every runtime invoke used.
    const sessions = [];
    const ctx = makeCtx();
    deps.invokeRuntime = vi.fn(async (payload, sessionId) => {
      invokes.push(payload);
      sessions.push(sessionId);
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 3 });
    // init-ws + 3 run-stages, in plan order.
    expect(invokes.filter((p) => p.command === 'run-stage').map((p) => p.stageId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    // The warm checkout is kept: every invoke shares the same session id.
    expect(new Set(sessions).size).toBe(1);
    expect(sessions[0]).toContain('aidlc-intent-i1');
  });

  it('re-parks across two gates on the same stage before succeeding (D3)', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta
      // park-loop re-reads: first park points at h1, second at h2.
      .mockResolvedValueOnce({ ...META, pendingHumanTaskId: 'h1' })
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h2' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      n += 1;
      if (n === 1) return { ok: true }; // init-ws
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      if (n === 3) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h2' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      makeCtx(),
      deps,
    );
    expect(res.ok).toBe(true);
    // Both gates were bound to a durable callback, and each resumed the run.
    const boundGates = deps.store.setGateCallbackId.mock.calls.map((c) => c[0].humanTaskId);
    expect(boundGates).toEqual(['h1', 'h2']);
    const resumes = invokes.filter((p) => p.command === 'run-stage' && p.resumeFrom);
    expect(resumes.map((p) => p.resumeFrom)).toEqual(['h1', 'h2']);
  });

  it('replay discipline: no side effect runs outside a ctx.step (except createCallback/wait)', async () => {
    // A ctx that tracks whether we are currently inside a step. The injected
    // store/invoke fakes assert stepDepth>0 — a bare `await store.x()` or
    // `await invokeRuntime()` outside a step would re-execute on durable replay.
    let stepDepth = 0;
    const ctx = {
      logger: { info() {}, debug() {} },
      step: async (_name, fn) => {
        stepDepth += 1;
        try {
          return await fn();
        } finally {
          stepDepth -= 1;
        }
      },
      // createCallback + wait are durable primitives, legitimately called outside
      // a step (they ARE the checkpoint), so they don't assert.
      createCallback: async (name) => [Promise.resolve({ answer: null }), `cb-${name}`],
      wait: async () => undefined,
      promise: { race: async (_n, promises) => Promise.race(promises) },
    };
    const assertInStep = (label) => {
      if (stepDepth === 0) throw new Error(`side effect "${label}" ran OUTSIDE a ctx.step`);
    };
    deps.store = {
      getExecution: vi.fn(async () => {
        assertInStep('getExecution');
        return META;
      }),
      updateExecution: vi.fn(async () => {
        assertInStep('updateExecution');
        return {};
      }),
      setGateCallbackId: vi.fn(async () => {
        assertInStep('setGateCallbackId');
        return {};
      }),
      getHumanTask: vi.fn(async () => {
        assertInStep('getHumanTask');
        return { status: 'answered' };
      }),
    };
    deps.loadPlan = vi.fn(async () => {
      assertInStep('loadPlan');
      return { valid: true, plan: { stages: [{ stageId: 'a' }] } };
    });
    deps.resolveToken = vi.fn(async () => {
      assertInStep('resolveToken');
      return 'tok';
    });
    let n = 0;
    deps.invokeRuntime = vi.fn(async (payload) => {
      assertInStep(`invokeRuntime:${payload.command}`);
      n += 1;
      if (payload.command === 'init-ws') return { ok: true };
      return n > 2 ? { ok: true, state: 'SUCCEEDED' } : { ok: true, state: 'SUCCEEDED' };
    });
    deps.stopSession = vi.fn(async () => {
      assertInStep('stopSession');
      return { stopped: true };
    });
    deps.broadcast = vi.fn(async () => {
      assertInStep('broadcast');
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true); // completed without any assertInStep throw
  });
});
