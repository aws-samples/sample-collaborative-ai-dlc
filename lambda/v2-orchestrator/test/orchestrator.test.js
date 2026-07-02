import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __durableHandler } from '../index.js';

// The orchestrator's control flow is driven through an injected `deps` bag and a
// fake DurableContext — no real AWS/Neptune. This isolates the sequencing logic
// (init-ws → stage loop → gate park/resume → terminal status) from I/O.
//
// ASYNC STAGE MODEL (docs/v2-parallel.md WP1): the orchestrator creates a
// durable callback per stage attempt (`stage-cb-<stageId>[-resume-<gate>]`),
// dispatches `run-stage-start` (a short accept), and suspends on the callback
// until the container's background job completes it with the stage verdict.
// The fake ctx mirrors that: stage callbacks are deferreds the fake runtime
// resolves (like the container's SendDurableExecutionCallbackSuccess); human
// gate callbacks (`await-<humanTaskId>`) resolve as if answered.
//
// True replay/suspend semantics are exercised separately in
// test/orchestrator-replay.test.js on the local durable test runner.

const makeCtx = (over = {}) => {
  // callbackId -> resolve, registered by createCallback, resolved by the fake
  // runtime when it "completes" the stage job.
  const stageCallbacks = new Map();
  return {
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
      // Human gate callbacks: answered immediately unless a test overrides.
      return [Promise.resolve({ answer: null }), `cb-${name}`];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
    },
    stageCallbackResolvers: stageCallbacks,
    ...over,
  };
};

// Build the deps.invokeRuntime fake: `script(payload, n)` returns the verdict
// for the nth runtime call (init-ws result or the stage result the container
// would deliver through the callback). For run-stage-start the verdict is
// routed through the ctx's stage callback — exactly the production path.
const makeRuntime = (ctx, script) => {
  let n = 0;
  return vi.fn(async (payload, sessionId) => {
    invokes.push(payload);
    sessions.push(sessionId);
    n += 1;
    const verdict = await script(payload, n);
    if (payload.command === 'run-stage-start') {
      const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
      if (!resolve) throw new Error(`no stage callback registered: ${payload.stageCallbackId}`);
      // Deliver the verdict via the callback (container background job) and
      // ACCEPT the dispatch.
      resolve(verdict);
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return verdict;
  });
};

// Default script: init-ws ok, every stage SUCCEEDED.
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
  cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
  parkReleaseSeconds: 300,
};

let deps;
let invokes;
let sessions;
let ctx;
beforeEach(() => {
  invokes = [];
  sessions = [];
  ctx = makeCtx();
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
    invokeRuntime: null, // bound to ctx below
    resolveToken: vi.fn(async () => 'tok'),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
  };
  deps.invokeRuntime = makeRuntime(ctx, okScript);
});

const stageStarts = () => invokes.filter((p) => p.command === 'run-stage-start');

describe('orchestrator durable handler', () => {
  it('ignores non-start invocations', async () => {
    const res = await __durableHandler({ action: 'answer', intentId: 'i1' }, ctx, deps);
    expect(res).toEqual({ ok: false, reason: 'not_a_start' });
  });

  it('runs init-ws then every stage to SUCCEEDED', async () => {
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 2 });
    expect(invokes.map((p) => p.command)).toEqual([
      'init-ws',
      'run-stage-start',
      'run-stage-start',
    ]);
    // init-ws carries the provider so the runtime picks the right clone scheme.
    const initWs = invokes.find((p) => p.command === 'init-ws');
    expect(initWs).toMatchObject({ gitProvider: 'github', gitToken: 'tok', repos: ['owner/repo'] });
    const statuses = deps.store.updateExecution.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain('RUNNING');
    expect(statuses).toContain('SUCCEEDED');
  });

  it('every stage dispatch carries a durable stage callback id', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const starts = stageStarts();
    expect(starts.length).toBe(2);
    for (const s of starts) expect(s.stageCallbackId).toMatch(/^cb-stage-cb-/);
    // Distinct callback per stage attempt (attribution).
    expect(new Set(starts.map((s) => s.stageCallbackId)).size).toBe(2);
  });

  it('parks on WAITING_FOR_HUMAN, binds a callback, then resumes', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' }); // park-loop gate lookup
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true }; // init-ws
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.store.setGateCallbackId).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'i1', humanTaskId: 'h1' }),
    );
    const starts = stageStarts();
    expect(starts).toHaveLength(2);
    expect(starts[1].resumeFrom).toBe('h1');
    // The resume leg is a fresh durable identity: new stage callback id.
    expect(starts[1].stageCallbackId).not.toBe(starts[0].stageCallbackId);
    // Gate answered before the release deadline → no StopRuntimeSession.
    expect(deps.stopSession).not.toHaveBeenCalled();
  });

  it('forwards the project cliModels to run-stage-start', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const starts = stageStarts();
    expect(starts.length).toBeGreaterThan(0);
    for (const rs of starts) {
      expect(rs.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    }
  });

  it('forwards the clone inputs to run-stage-start so it can self-heal a wiped checkout', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const starts = stageStarts();
    expect(starts.length).toBeGreaterThan(0);
    for (const rs of starts) {
      expect(rs).toMatchObject({
        repos: ['owner/repo'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitToken: 'tok',
        gitProvider: 'github',
      });
    }
  });

  it('forwards the project agentCli to run-stage-start as requestedCli', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const starts = stageStarts();
    expect(starts.length).toBeGreaterThan(0);
    for (const rs of starts) {
      expect(rs.requestedCli).toBe('kiro');
    }
  });

  it('omits requestedCli when the project has no selected CLI', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, agentCli: null }));
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const starts = stageStarts();
    expect(starts.length).toBeGreaterThan(0);
    for (const rs of starts) {
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
    // ctx where the release timer wins the race: gate callbacks resolve after a
    // tick; stage callbacks keep the deferred harness.
    const base = makeCtx();
    const raceCtx = {
      ...base,
      createCallback: async (name) => {
        if (String(name).startsWith('stage-cb-')) return base.createCallback(name);
        return [
          new Promise((resolve) => setTimeout(() => resolve({ answer: null }), 5)),
          `cb-${name}`,
        ];
      },
      promise: { race: async (_n, [, waitP]) => waitP },
    };
    deps.invokeRuntime = makeRuntime(raceCtx, (payload, n) => {
      if (n === 1) return { ok: true };
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      raceCtx,
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
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true };
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(deps.stopSession).not.toHaveBeenCalled();
  });

  it('fails the execution when a stage fails (verdict via callback)', async () => {
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) =>
      n === 1 ? { ok: true } : { ok: false, state: 'FAILED', reason: 'sensor_blocked' },
    );
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stage_failed');
    expect(deps.store.updateExecution.mock.calls.map((c) => c[0].status)).toContain('FAILED');
  });

  it('fails the stage when the container REFUSES the dispatch (accept-time failure)', async () => {
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      if (payload.command === 'init-ws') return { ok: true };
      // e.g. duplicate job / old container without run-stage-start.
      return { ok: false, reason: 'job_already_running' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stage_failed');
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall[0].failureReason).toContain('job_already_running');
  });

  it('fails (with reason + event) when init-ws returns ok:false instead of marching on', async () => {
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      // init-ws reports a checkout failure (the runtime returns, does not throw).
      return { ok: false, reason: 'checkout_failed', detail: 'auth' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
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
    // A run-stage-start transport error throws out of the dispatch step.
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
      ctx,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('orchestrator_error');
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall[0].failureReason).toContain('AgentCore 500');
  });

  it('fails the stage (not the whole run silently) when the stage callback rejects', async () => {
    // Callback timeout / heartbeat expiry: the container died mid-stage.
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    const dead = makeCtx({
      createCallback: async (name) => {
        if (String(name).startsWith('stage-cb-')) {
          return [Promise.reject(new Error('callback timed out')), `cb-${name}`];
        }
        return [Promise.resolve({ answer: null }), `cb-${name}`];
      },
    });
    deps.invokeRuntime = vi.fn(async (payload) => {
      invokes.push(payload);
      if (payload.command === 'init-ws') return { ok: true };
      return { ok: true, accepted: true };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      dead,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stage_failed');
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall[0].failureReason).toContain('stage_callback_failed');
  });

  it('emits workspace lifecycle events so init-ws is visible in the feed', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const evTypes = deps.store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.workspace.initializing');
    expect(evTypes).toContain('v2.workspace.initialized');
    expect(evTypes).toContain('v2.execution.succeeded');
  });

  it('fans out live realtime payloads the UI routes on (workspace + execution)', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
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
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const failed = deps.broadcast.mock.calls.find(
      (c) => c[1].action === 'agent.execution' && c[1].status === 'FAILED',
    );
    expect(failed).toBeTruthy();
  });

  it('fails closed when the plan is invalid', async () => {
    deps.loadPlan.mockResolvedValue({ valid: false, errors: [{ code: 'x' }], plan: null });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
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
    deps.invokeRuntime = makeRuntime(ctx, okScript);
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 3 });
    // init-ws + 3 stage dispatches, in plan order.
    expect(stageStarts().map((p) => p.stageId)).toEqual(['a', 'b', 'c']);
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
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true }; // init-ws
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      if (n === 3) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h2' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    // Both gates were bound to a durable callback, and each resumed the run.
    const boundGates = deps.store.setGateCallbackId.mock.calls.map((c) => c[0].humanTaskId);
    expect(boundGates).toEqual(['h1', 'h2']);
    const resumes = stageStarts().filter((p) => p.resumeFrom);
    expect(resumes.map((p) => p.resumeFrom)).toEqual(['h1', 'h2']);
  });

  it('replay discipline: no side effect runs outside a ctx.step (except createCallback/wait)', async () => {
    // A ctx that tracks whether we are currently inside a step. The injected
    // store/invoke fakes assert stepDepth>0 — a bare `await store.x()` or
    // `await invokeRuntime()` outside a step would re-execute on durable replay.
    let stepDepth = 0;
    const stageCallbacks = new Map();
    const strictCtx = {
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
      promise: { race: async (_n, promises) => Promise.race(promises) },
      stageCallbackResolvers: stageCallbacks,
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
    deps.invokeRuntime = vi.fn(async (payload) => {
      assertInStep(`invokeRuntime:${payload.command}`);
      if (payload.command === 'init-ws') return { ok: true };
      // Deliver the verdict via the stage callback like the harness does.
      const resolve = stageCallbacks.get(payload.stageCallbackId);
      resolve({ ok: true, state: 'SUCCEEDED' });
      return { ok: true, accepted: true };
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
      strictCtx,
      deps,
    );
    expect(res.ok).toBe(true); // completed without any assertInStep throw
  });
});

// ── Steering (docs/v2-steering.md) ──

describe('rewind relaunch (startAtStageId)', () => {
  it('slices the stage loop to start at the rewound stage when upstream is SUCCEEDED', async () => {
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: {
        stages: [
          { stageId: 'a', stageInstanceId: 'si-a' },
          { stageId: 'b', stageInstanceId: 'si-b' },
          { stageId: 'c', stageInstanceId: 'si-c' },
        ],
      },
    });
    deps.store.getStage = vi.fn(async () => ({ state: 'SUCCEEDED' }));
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'b' },
      ctx,
      deps,
    );
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 2 });
    // init-ws still runs (idempotent workspace heal); the loop starts at 'b'.
    expect(invokes.map((p) => p.command)).toEqual([
      'init-ws',
      'run-stage-start',
      'run-stage-start',
    ]);
    expect(stageStarts().map((p) => p.stageId)).toEqual(['b', 'c']);
    // Only the upstream stage 'a' was verified.
    expect(deps.store.getStage).toHaveBeenCalledTimes(1);
    expect(deps.store.getStage).toHaveBeenCalledWith('i1', 'si-a');
  });

  it('fails rewind_stage_not_found for a stage outside the plan', async () => {
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'nope' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('rewind_stage_not_found');
  });

  it('fails rewind_upstream_incomplete when a stage before the rewind point never succeeded', async () => {
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: {
        stages: [
          { stageId: 'a', stageInstanceId: 'si-a' },
          { stageId: 'b', stageInstanceId: 'si-b' },
        ],
      },
    });
    deps.store.getStage = vi.fn(async () => null); // 'a' never ran
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'b' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('rewind_upstream_incomplete');
    expect(stageStarts()).toHaveLength(0);
  });
});

describe('retired-run ownership', () => {
  it('exits quietly (no META write) when the parked gate was superseded by cancel/rewind', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    // After the callback resolves (cancel sentinel), the gate reads superseded.
    deps.store.getHumanTask = vi.fn(async () => ({ status: 'superseded' }));
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true }; // init-ws
      return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'retired', humanTaskId: 'h1' });
    // No resume was issued and NO terminal status was written — the cancel/
    // rewind path owns META from here.
    expect(invokes.filter((p) => p.resumeFrom)).toHaveLength(0);
    const statuses = deps.store.updateExecution.mock.calls.map((c) => c[0].status);
    expect(statuses).not.toContain('SUCCEEDED');
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('CANCELLED');
  });

  it('claims the run with an ownership token and CASes terminal writes on it', async () => {
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const calls = deps.store.updateExecution.mock.calls.map((c) => c[0]);
    const claim = calls.find((c) => c.orchestratorRunId);
    expect(claim).toBeTruthy();
    const finish = calls.find((c) => c.status === 'SUCCEEDED');
    expect(finish.ifOrchestratorRunId).toBe(claim.orchestratorRunId);
  });

  it('a terminal write losing the ownership CAS returns retired without an event', async () => {
    const cas = Object.assign(new Error('cas'), { name: 'ConditionalCheckFailedException' });
    deps.store.updateExecution = vi.fn(async (input) => {
      if (input.ifOrchestratorRunId) throw cas; // a relaunch re-stamped the token
      return { orchestratorRunId: input.orchestratorRunId ?? null };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'retired' });
    const evTypes = deps.store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).not.toContain('v2.execution.succeeded');
  });
});

// ── WP3: unit DAG promotion (docs/v2-parallel.md) ──

describe('unit DAG promotion after the producing stage succeeds', () => {
  const PLAN_WITH_DAG_PRODUCER = {
    valid: true,
    plan: {
      stages: [
        {
          stageId: 'units-generation',
          stageInstanceId: 'si-units',
          outputArtifacts: [
            { artifact: 'unit-of-work', terminal: false },
            { artifact: 'unit-of-work-dependency', terminal: false },
          ],
        },
        {
          stageId: 'delivery-planning',
          stageInstanceId: 'si-dp',
          outputArtifacts: [{ artifact: 'bolt-plan', terminal: false }],
        },
      ],
    },
  };

  it('dispatches promote-units exactly once, after the producing stage, before the next stage', async () => {
    deps.loadPlan.mockResolvedValue(PLAN_WITH_DAG_PRODUCER);
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units')
        return { ok: true, unitCount: 3, batchCount: 2, walkingSkeleton: 'auth' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    const commands = invokes.map((p) => p.command);
    expect(commands).toEqual([
      'init-ws',
      'run-stage-start', // units-generation
      'promote-units', // right after the producer succeeded
      'run-stage-start', // delivery-planning
    ]);
    const promote = invokes.find((p) => p.command === 'promote-units');
    expect(promote).toMatchObject({
      projectId: 'p1',
      intentId: 'i1',
      executionId: 'i1',
      stageInstanceId: 'si-units',
    });
    // The plan-ready event landed for the activity feed.
    const evTypes = deps.store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.units.plan_ready');
  });

  it('never dispatches promote-units when no stage produces the DAG artifact', async () => {
    // Default plan (stages a, b — no outputArtifacts).
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    expect(invokes.map((p) => p.command)).not.toContain('promote-units');
  });

  it('fails the run (units_promotion_failed) when promotion is refused', async () => {
    deps.loadPlan.mockResolvedValue(PLAN_WITH_DAG_PRODUCER);
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units')
        return { ok: false, reason: 'dag_malformed', detail: 'duplicate: auth' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'units_promotion_failed' });
    // The run stopped before the next stage.
    expect(invokes.filter((p) => p.command === 'run-stage-start')).toHaveLength(1);
    const failCall = deps.store.updateExecution.mock.calls.find((c) => c[0].status === 'FAILED');
    expect(failCall[0].failureReason).toContain('dag_malformed');
    expect(failCall[0].failureReason).toContain('duplicate: auth');
  });

  it('promotion runs after the park loop drains (gate answered first)', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META)
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' });
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: { stages: [PLAN_WITH_DAG_PRODUCER.plan.stages[0]] },
    });
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units')
        return { ok: true, unitCount: 1, batchCount: 1, walkingSkeleton: 'auth' };
      // First stage leg parks (approval question), resume leg succeeds.
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );
    expect(res.ok).toBe(true);
    const commands = invokes.map((p) => p.command);
    // fresh leg → resume leg → THEN promotion.
    expect(commands).toEqual(['init-ws', 'run-stage-start', 'run-stage-start', 'promote-units']);
  });
});
