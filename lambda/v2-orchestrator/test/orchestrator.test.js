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
      // Human gate callbacks: answered immediately unless a test overrides.
      return [Promise.resolve({ answer: null }), `cb-${name}`];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
      allSettled: async (_name, promises) => Promise.allSettled(promises),
    },
    // WP5 lanes: a child context shares the fake's behavior (steps run,
    // callbacks resolve through the same registry) — the real SDK gives each
    // lane its own checkpoint namespace, which the replay suite covers.
    runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
    stageCallbackResolvers: stageCallbacks,
    ...over,
  };
  return ctx;
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
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      // Default: gate is answered (not pending) by the time we re-read it.
      getHumanTask: vi.fn(async () => ({ status: 'answered' })),
      appendEvent: vi.fn(async () => ({})),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
    },
    loadPlan: vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ stageId: 'a' }, { stageId: 'b' }] },
    })),
    invokeRuntime: null, // bound to ctx below
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
    openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
    comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
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
    expect(initWs).toMatchObject({
      projectId: 'p1',
      executionId: 'i1',
      gitProvider: 'github',
      repos: ['owner/repo'],
    });
    expect(initWs).not.toHaveProperty('gitToken');
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

  it('fails rather than overwriting a gate callback owned by another stage', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META)
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' });
    deps.store.setGateCallbackId.mockResolvedValueOnce(null);
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true };
      return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
    });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );

    expect(res).toMatchObject({ ok: false, reason: 'gate_callback_conflict' });
    expect(stageStarts()).toHaveLength(1);
  });

  it('fails instead of binding a human gate callback when the soft deadline is past', async () => {
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta
      .mockResolvedValue({
        ...META,
        pendingHumanTaskId: 'h1',
        orchestratorExpiresAt: '2000-01-01T00:00:00.000Z',
      });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.invokeRuntime = makeRuntime(ctx, (payload, n) => {
      if (n === 1) return { ok: true };
      return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
    });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );

    expect(res).toMatchObject({ ok: false, reason: 'durable_deadline_expired' });
    expect(deps.store.supersedeHumanTask).toHaveBeenCalledWith({
      executionId: 'i1',
      humanTaskId: 'h1',
      supersededBy: 'durable_deadline_expired',
    });
    expect(deps.store.setGateCallbackId).not.toHaveBeenCalled();
    expect(
      deps.store.updateExecution.mock.calls.some(
        ([input]) =>
          input.status === 'FAILED' &&
          input.pendingHumanTaskId === null &&
          String(input.failureReason).includes('durable_deadline_expired'),
      ),
    ).toBe(true);
  });

  it('opens a validation gate after a required humanValidation stage', async () => {
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: {
        stages: [
          {
            stageId: 'a',
            stageInstanceId: 'si-a',
            humanValidation: 'required',
            outputArtifacts: [{ artifact: 'requirements-analysis' }],
          },
        ],
      },
    });
    deps.store.getHumanTask = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        humanTaskId: 'eg-validation-si-a-0',
        status: 'approved',
        answer: { decision: 'approve' },
      });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );

    expect(res.ok).toBe(true);
    expect(deps.store.createHumanTask).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'i1',
        kind: 'validation',
        stageInstanceId: 'si-a',
        options: ['approve', 'request-changes'],
      }),
    );
    expect(invokes.map((p) => p.command)).toEqual([
      'init-ws',
      'run-stage-start',
      'derive-artifacts',
    ]);
  });

  it('request-changes validation feedback re-runs the stage through resumeFrom', async () => {
    deps.loadPlan.mockResolvedValue({
      valid: true,
      plan: {
        stages: [
          {
            stageId: 'a',
            stageInstanceId: 'si-a',
            humanValidation: 'required',
            outputArtifacts: [],
          },
        ],
      },
    });
    deps.store.getHumanTask = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        humanTaskId: 'eg-validation-si-a-0',
        status: 'rejected',
        answer: { decision: 'request-changes', feedback: 'tighten scope' },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        humanTaskId: 'eg-validation-si-a-1',
        status: 'approved',
        answer: { decision: 'approve' },
      });

    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      ctx,
      deps,
    );

    expect(res.ok).toBe(true);
    const starts = stageStarts();
    expect(starts).toHaveLength(2);
    expect(starts[0].resumeFrom).toBeNull();
    expect(starts[1].resumeFrom).toBe('eg-validation-si-a-0');
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
        projectId: 'p1',
        executionId: 'i1',
        repos: ['owner/repo'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      });
      expect(rs).not.toHaveProperty('gitToken');
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

  it('resumes IMMEDIATELY when the answer landed before the callback was bound (no release-timer stall)', async () => {
    // Field incident: the human answered ~100ms after the park, in the window
    // before bind-callback wrote the callbackId — the answer endpoint had no
    // callback to complete, and the run stalled for the FULL parkReleaseSeconds
    // until the release timer noticed the answered gate. The answered-early
    // re-read after binding must resume without touching timer or callback.
    deps.store.getExecution
      .mockResolvedValueOnce(META)
      .mockResolvedValue({ ...META, pendingHumanTaskId: 'h1' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.store.getHumanTask = vi.fn(async () => ({ status: 'answered' }));
    const base = makeCtx();
    const strictCtx = {
      ...base,
      // Reaching the park race or the release wait = regression (the stall).
      wait: () => {
        throw new Error('release timer must not be armed for an already-answered gate');
      },
      promise: {
        race: () => {
          throw new Error('park race must not run for an already-answered gate');
        },
      },
      createCallback: async (name) => {
        if (String(name).startsWith('stage-cb-')) return base.createCallback(name);
        // Gate callback: NEVER resolves — awaiting it would hang the test.
        return [new Promise(() => {}), `cb-${name}`];
      },
    };
    deps.invokeRuntime = makeRuntime(strictCtx, (payload, n) => {
      if (n === 1) return { ok: true };
      if (n === 2) return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1' },
      strictCtx,
      deps,
    );
    expect(res.ok).toBe(true);
    // The resume leg was dispatched (answer consumed) and no release happened.
    expect(invokes.filter((p) => p.resumeFrom === 'h1')).toHaveLength(1);
    expect(deps.stopSession).not.toHaveBeenCalled();
  });

  it('exits retired (no resume, no writes) when a rewind took ownership while parked', async () => {
    // Field incident: a retry/rewind relaunched under a new orchestratorRunId
    // while the old run was parked on an ANSWERED (not superseded) gate. The
    // old run woke and dispatched a resume against the freshly reset stage
    // rows (wiped CLI session → resume_no_session + a stale FAILED write).
    // The ownership check after the wake must exit retired instead.
    deps.store.getExecution
      .mockResolvedValueOnce(META) // load-meta at start
      .mockResolvedValue({ ...META, orchestratorRunId: 'run-of-the-NEW-relaunch' });
    deps.loadPlan.mockResolvedValue({ valid: true, plan: { stages: [{ stageId: 'a' }] } });
    deps.store.getHumanTask = vi.fn(async () => ({ status: 'answered' }));
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
    expect(res).toMatchObject({ ok: false, reason: 'retired' });
    // The retired run never dispatched the resume leg…
    expect(invokes.filter((p) => p.resumeFrom === 'h1')).toHaveLength(0);
    // …and wrote no terminal status over the new run's META.
    const statuses = deps.store.updateExecution.mock.calls.map((c) => c[0].status).filter(Boolean);
    expect(statuses).not.toContain('FAILED');
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
      'derive-artifacts', // projection before downstream consumers run
      'promote-units', // right after the producer succeeded
      'run-stage-start', // delivery-planning
      'derive-artifacts',
    ]);
    const derive = invokes.find((p) => p.command === 'derive-artifacts');
    expect(derive).toMatchObject({
      projectId: 'p1',
      intentId: 'i1',
      executionId: 'i1',
      stageInstanceId: 'si-units',
      artifactTypes: ['unit-of-work', 'unit-of-work-dependency'],
      // Enrichment defaults off when META carries no Admin snapshot; the CLI
      // selection rides along so an 'llm' derive can spawn the one-shot call.
      enrichment: 'off',
      requestedCli: 'kiro',
      cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
    });
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

  it('forwards the META enrichment snapshot to derive-artifacts (Admin toggle, no redeploy)', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, deriveEnrichment: 'llm' }));
    deps.loadPlan.mockResolvedValue(PLAN_WITH_DAG_PRODUCER);
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 1, batchCount: 1 };
      return { ok: true, state: 'SUCCEEDED' };
    });
    await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
    const derives = invokes.filter((p) => p.command === 'derive-artifacts');
    expect(derives.length).toBeGreaterThan(0);
    for (const d of derives) expect(d.enrichment).toBe('llm');
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
    // fresh leg → resume leg → THEN projection and promotion.
    expect(commands).toEqual([
      'init-ws',
      'run-stage-start',
      'run-stage-start',
      'derive-artifacts',
      'promote-units',
    ]);
  });
});

// ── WP4: plan fan-out — sequential unit lanes (docs/v2-parallel.md) ──────────

import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';

const SECTION_PLAN = () => ({
  valid: true,
  plan: {
    namespace: 'aidlc-v2@1',
    stages: [
      {
        stageId: 'units-gen',
        stageInstanceId: 'si-units-gen',
        parallelSection: null,
        outputArtifacts: [{ artifact: 'unit-of-work-dependency' }],
      },
      {
        stageId: 'fd',
        stageInstanceId: 'si-fd',
        parallelSection: 1,
        execution: 'CONDITIONAL',
        phase: 'construction',
        outputArtifacts: [],
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
    ],
  },
});

const UNIT_PLAN = (over = {}) => ({
  units: [
    { slug: 'auth', dependsOn: [] },
    { slug: 'billing', dependsOn: ['auth'] },
  ],
  batches: [['auth'], ['billing']],
  skipMatrix: {},
  ...over,
});

const sectionScript = (payload) => {
  if (payload.command === 'init-ws') return { ok: true };
  if (payload.command === 'promote-units')
    return { ok: true, unitCount: 2, batchCount: 2, walkingSkeleton: 'auth' };
  return { ok: true, state: 'SUCCEEDED' };
};

describe('WP5 — parallel sections: lanes, skeleton, ladder, halt-and-ask', () => {
  let unitStates;
  let stagePuts;
  beforeEach(() => {
    unitStates = [];
    stagePuts = [];
    deps.loadPlan = vi.fn(async () => SECTION_PLAN());
    deps.store.getUnitPlan = vi.fn(async () => UNIT_PLAN());
    deps.store.listUnits = vi.fn(async () => []);
    deps.store.getUnit = vi.fn(async () => null);
    deps.store.updateUnitState = vi.fn(async (args) => {
      unitStates.push(args);
      return { slug: args.slug, state: args.state };
    });
    deps.store.putStage = vi.fn(async (args) => {
      stagePuts.push(args);
      return args;
    });
    deps.store.getStage = vi.fn(async () => null);
    deps.invokeRuntime = makeRuntime(ctx, sectionScript);
  });

  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

  it('runs the full section lifecycle: skeleton lane solo, then remaining lanes, each with init-lane → stages → merge-lane', async () => {
    const res = await start();
    expect(res.ok).toBe(true);
    // auth is the skeleton (first slug of the first wave): its whole lane
    // (init → fd → cg → merge) completes before billing's lane opens; bt runs
    // after fan-in.
    expect(invokes.map((p) => `${p.command}:${p.stageId ?? p.unitSlug ?? '-'}`)).toEqual([
      'init-ws:-',
      'run-stage-start:units-gen',
      'derive-artifacts:-',
      'promote-units:-',
      'init-lane:auth',
      'run-stage-start:fd',
      'run-stage-start:cg',
      'merge-lane:auth',
      'init-lane:billing',
      'run-stage-start:fd',
      'run-stage-start:cg',
      'merge-lane:billing',
      'run-stage-start:bt',
    ]);
    // Lane dispatches run in the LANE's own session; merge-lane in the intent
    // session (A2 rule 3 / A3 merge-back).
    const bySession = invokes.map((p, i) => `${p.command}:${p.unitSlug ?? '-'}:${sessions[i]}`);
    expect(bySession).toContain(`init-lane:auth:${'aidlc-intent-i1-s1-auth'.padEnd(33, '0')}`);
    expect(bySession).toContain(
      `run-stage-start:billing:${'aidlc-intent-i1-s1-billing'.padEnd(33, '0')}`,
    );
    const mergeIdx = invokes.findIndex((p) => p.command === 'merge-lane');
    expect(sessions[mergeIdx]).toBe('aidlc-intent-i1'.padEnd(33, '0'));
    // Lane clone inputs point at the unit branch, based on the intent branch.
    const laneStart = stageStarts().find((p) => p.stageId === 'fd' && p.unitSlug === 'auth');
    expect(laneStart.branch).toBe('aidlc/i1--s1-unit-auth');
    expect(laneStart.baseBranch).toBe('aidlc/i1');
    const init = invokes.find((p) => p.command === 'init-lane');
    expect(init).toMatchObject({
      unitSlug: 'auth',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      sectionIndex: 1,
    });
    // The lane sessions were released after their merges.
    const stopped = deps.stopSession.mock.calls.map((c) => c[0]);
    expect(stopped).toContain('aidlc-intent-i1-s1-auth'.padEnd(33, '0'));
    expect(stopped).toContain('aidlc-intent-i1-s1-billing'.padEnd(33, '0'));
    // Non-lane dispatches carry unitSlug null explicitly (uniform contract).
    expect(stageStarts().find((p) => p.stageId === 'bt').unitSlug).toBeNull();
  });

  it('resumes after repair from persisted merged units without replaying the skeleton or its gate', async () => {
    deps.store.getUnitPlan = vi.fn(async () => UNIT_PLAN({ autonomyMode: 'autonomous' }));
    deps.store.listUnits = vi.fn(async () => [
      { sectionIndex: 1, slug: 'auth', state: 'MERGED' },
      { sectionIndex: 1, slug: 'billing', state: 'PENDING' },
    ]);

    const res = await start();

    expect(res.ok).toBe(true);
    expect(
      invokes.some((payload) => payload.command === 'init-lane' && payload.unitSlug === 'auth'),
    ).toBe(false);
    expect(
      invokes.some((payload) => payload.command === 'init-lane' && payload.unitSlug === 'billing'),
    ).toBe(true);
    const openedGateIds = deps.store.createHumanTask.mock.calls.map(([gate]) => gate.humanTaskId);
    expect(openedGateIds.some((id) => id.startsWith('eg-skeleton-s1'))).toBe(false);
  });

  it('tracks lane states RUNNING → MERGING → MERGED per unit with lifecycle events + agent.unit broadcasts', async () => {
    await start();
    expect(unitStates.map((u) => `${u.slug}:${u.state}`)).toEqual([
      'auth:RUNNING',
      'auth:MERGING',
      'auth:MERGED',
      'billing:RUNNING',
      'billing:MERGING',
      'billing:MERGED',
    ]);
    // Lane start stamps the UNIT branch + LANE session; merge stamps mergedAt.
    expect(unitStates[0]).toMatchObject({
      fromStates: ['PENDING', 'READY'],
      fields: {
        branch: 'aidlc/i1--s1-unit-auth',
        sessionId: 'aidlc-intent-i1-s1-auth'.padEnd(33, '0'),
        startedAt: true,
      },
    });
    expect(unitStates[2].fields).toMatchObject({ mergedAt: true });
    // Durable events carry the lane.
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    const unitEvents = eventCalls.filter((e) => e.type?.startsWith('v2.unit.'));
    expect(unitEvents.map((e) => `${e.type}:${e.unitSlug}`)).toEqual([
      'v2.unit.started:auth',
      'v2.unit.merged:auth',
      'v2.unit.started:billing',
      'v2.unit.merged:billing',
    ]);
    // Section lifecycle is auditable: fan-out approval, skeleton approval,
    // autonomy decision (default GATED on an unparseable answer), batch
    // approval, fan-in.
    const types = eventCalls.map((e) => e.type);
    for (const t of [
      'v2.units.fanout_approved',
      'v2.units.skeleton_approved',
      'v2.units.autonomy_set',
      'v2.units.batch_approved',
      'v2.units.fan_in',
    ]) {
      expect(types).toContain(t);
    }
    // Live broadcasts route on their own action with lane attribution.
    const unitBroadcasts = deps.broadcast.mock.calls
      .map((c) => c[1])
      .filter((p) => p.action === 'agent.unit');
    expect(unitBroadcasts.map((p) => `${p.state}:${p.unitSlug}`)).toEqual([
      'RUNNING:auth',
      'MERGED:auth',
      'RUNNING:billing',
      'MERGED:billing',
    ]);
  });

  it('honors the frozen skip matrix for CONDITIONAL stages only (SKIPPED row, no dispatch)', async () => {
    deps.store.getUnitPlan = vi.fn(async () =>
      UNIT_PLAN({ skipMatrix: { billing: ['fd'], auth: ['cg'] } }),
    );
    const res = await start();
    expect(res.ok).toBe(true);
    const lanes = stageStarts().map((p) => `${p.stageId}:${p.unitSlug ?? '-'}`);
    // billing's fd skipped (CONDITIONAL); auth's cg NOT skipped (ALWAYS is not skippable).
    expect(lanes).toEqual(['units-gen:-', 'fd:auth', 'cg:auth', 'cg:billing', 'bt:-']);
    // The skipped instance exists as an auditable SKIPPED row under its
    // per-unit instance id.
    expect(stagePuts).toEqual([
      {
        executionId: 'i1',
        stageInstanceId: planStageInstanceId('aidlc-v2@1', 'fd', 'billing', 1),
        stageId: 'fd',
        unitSlug: 'billing',
        sectionIndex: 1,
        phase: 'construction',
        state: 'SKIPPED',
      },
    ]);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.stage.skipped' && e.unitSlug === 'billing')).toBe(
      true,
    );
  });

  it('a lane failure halts-and-asks; an unanswered/abort decision fails the run with work preserved', async () => {
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units')
        return { ok: true, unitCount: 2, batchCount: 2, walkingSkeleton: 'auth' };
      if (payload.stageId === 'cg' && payload.unitSlug === 'auth')
        return { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    // Halt gate auto-answers with NO parseable choice → the gate RE-ASKS a
    // bounded number of times (abort must be explicit), then the deterministic
    // fallback is ABORT (never silent continuation).
    expect(res).toMatchObject({ ok: false, reason: 'section_aborted' });
    expect(res.detail).toContain('auth');
    const eventCallsHalt = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCallsHalt.some((e) => e.type === 'v2.units.halt_reask')).toBe(true);
    // Lane bookkeeping: auth FAILED with the failing stage recorded.
    expect(unitStates.map((u) => `${u.slug}:${u.state}`)).toEqual(['auth:RUNNING', 'auth:FAILED']);
    expect(unitStates[1].fields.failureReason).toContain('cg');
    // billing's lane never started (skeleton failed before fan-out widened).
    expect(stageStarts().some((p) => p.unitSlug === 'billing')).toBe(false);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.unit.failed' && e.unitSlug === 'auth')).toBe(true);
    expect(eventCalls.some((e) => e.type === 'v2.units.halt_decision')).toBe(true);
  });

  it('fails deterministically (unit_plan_missing) when a section starts without a promoted plan', async () => {
    deps.store.getUnitPlan = vi.fn(async () => null);
    // Drop the promote hook trigger so the missing plan is what's under test.
    const plan = SECTION_PLAN();
    plan.plan.stages[0].outputArtifacts = [];
    deps.loadPlan = vi.fn(async () => plan);
    const res = await start();
    expect(res).toMatchObject({ ok: false, reason: 'unit_plan_missing' });
    expect(res.detail).toContain('section 1');
    // No lane was ever dispatched.
    expect(stageStarts().map((p) => p.stageId)).toEqual(['units-gen']);
  });

  it('a lane park suspends on a lane-scoped callback and resumes the SAME lane', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, pendingHumanTaskId: 'h9' }));
    deps.store.getHumanTask = vi.fn(async () => ({ status: 'answered' }));
    let parked = false;
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.stageId === 'fd' && payload.unitSlug === 'auth' && !parked) {
        parked = true;
        return { ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h9', unitSlug: 'auth' };
      }
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    expect(res.ok).toBe(true);
    const fdAuth = stageStarts().filter((p) => p.stageId === 'fd' && p.unitSlug === 'auth');
    expect(fdAuth.map((p) => p.resumeFrom)).toEqual([null, 'h9']);
    // The resume leg's callback identity carries the unit dimension.
    expect(fdAuth.map((p) => p.stageCallbackId)).toEqual([
      'cb-stage-cb-fd-s1-u-auth',
      'cb-stage-cb-fd-s1-u-auth-resume-h9',
    ]);
  });

  it('rewind past a section verifies every unit instance (SUCCEEDED or SKIPPED)', async () => {
    const doneRow = { state: 'SUCCEEDED' };
    const rows = {
      'si-units-gen': doneRow,
      [planStageInstanceId('aidlc-v2@1', 'fd', 'auth', 1)]: doneRow,
      [planStageInstanceId('aidlc-v2@1', 'fd', 'billing', 1)]: { state: 'SKIPPED' },
      [planStageInstanceId('aidlc-v2@1', 'cg', 'auth', 1)]: doneRow,
      // cg/billing missing → incomplete
    };
    deps.store.getStage = vi.fn(async (_e, id) => rows[id] ?? null);
    const res = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'bt' },
      ctx,
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'rewind_upstream_incomplete' });
    expect(res.detail).toBe('cg [unit billing]');

    // Complete the missing lane instance → rewind proceeds straight to bt.
    rows[planStageInstanceId('aidlc-v2@1', 'cg', 'billing', 1)] = doneRow;
    invokes.length = 0;
    ctx = makeCtx();
    deps.invokeRuntime = makeRuntime(ctx, sectionScript);
    const res2 = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'bt' },
      ctx,
      deps,
    );
    expect(res2.ok).toBe(true);
    expect(stageStarts().map((p) => p.stageId)).toEqual(['bt']);
  });
});

describe('PR per unit delivery', () => {
  let unitStates;
  let unitPrStates;
  let unitPrRows;
  let metrics;

  const configure = ({ repos = ['owner/repo'], statusFor }) => {
    unitStates = [];
    unitPrStates = [];
    unitPrRows = new Map();
    metrics = [];
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      repos,
      prStrategy: 'pr-per-unit',
    }));
    deps.loadPlan = vi.fn(async () => SECTION_PLAN());
    deps.store.getUnitPlan = vi.fn(async () =>
      UNIT_PLAN({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
      }),
    );
    deps.store.updateUnitState = vi.fn(async (args) => {
      unitStates.push(args);
      return { ...args, unitSlug: args.slug };
    });
    deps.store.putStage = vi.fn(async (args) => args);
    deps.store.getStage = vi.fn(async () => ({ state: 'SUCCEEDED' }));
    deps.store.getUnitPr = vi.fn(async (_executionId, _sectionIndex, _slug, repository) =>
      unitPrRows.get(repository),
    );
    deps.store.createUnitPr = vi.fn(async (args) => {
      const row = { ...args, unitSlug: args.slug };
      unitPrRows.set(args.repository, row);
      return row;
    });
    deps.store.updateUnitPr = vi.fn(async (args) => {
      unitPrStates.push(args);
      const row = {
        ...unitPrRows.get(args.repository),
        ...args,
        unitSlug: args.slug,
        ...args.fields,
      };
      unitPrRows.set(args.repository, row);
      return row;
    });
    deps.store.listFeedbackBatches = vi.fn(async () => []);
    deps.store.updateFeedbackBatch = vi.fn(async (args) => args);
    deps.store.bindUnitPrWait = vi.fn(async (args) => args);
    deps.store.recordMetric = vi.fn(async (args) => {
      metrics.push(args.metrics);
      return args;
    });
    deps.invokeRuntime = makeRuntime(ctx, sectionScript);

    let nextNumber = 7;
    deps.unitPrProvider = {
      compare: vi.fn(async () => ({ status: 'ahead' })),
      find: vi.fn(async () => null),
      createDraft: vi.fn(async ({ branch }) => {
        const number = nextNumber;
        nextNumber += 1;
        return {
          providerId: `provider-${number}`,
          prNumber: number,
          prUrl: `https://example.test/pr/${number}`,
          headSha: `head-${number}`,
          targetSha: 'intent-before',
          sourceBranch: branch,
        };
      }),
      status: vi.fn(statusFor),
      setDraft: vi.fn(async ({ number, draft }) => ({
        providerId: `provider-${number}`,
        number,
        url: `https://example.test/pr/${number}`,
        sourceBranch: 'aidlc/i1--s1-unit-auth',
        targetBranch: 'aidlc/i1',
        headSha: `head-${number}`,
        targetSha: 'intent-before',
        state: 'open',
        draft,
        mergeable: true,
      })),
      reopen: vi.fn(async () => null),
      isAncestor: vi.fn(async () => true),
      listComments: vi.fn(async () => []),
      addComment: vi.fn(async () => ({})),
    };
  };

  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

  it('opens a draft, releases lane compute, reconciles, promotes, and verifies integration', async () => {
    const calls = new Map();
    configure({
      statusFor: async ({ number }) => {
        const call = (calls.get(number) ?? 0) + 1;
        calls.set(number, call);
        return {
          providerId: `provider-${number}`,
          number,
          url: `https://example.test/pr/${number}`,
          sourceBranch: 'aidlc/i1--s1-unit-auth',
          targetBranch: 'aidlc/i1',
          headSha: `head-${number}`,
          targetSha: 'intent-before',
          state: call >= 3 ? 'merged' : 'open',
          draft: call < 3,
          mergeable: true,
        };
      },
    });

    const result = await start();
    expect(result.ok).toBe(true);
    expect(deps.unitPrProvider.createDraft).toHaveBeenCalledOnce();
    expect(deps.unitPrProvider.setDraft).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7, draft: false }),
    );
    expect(deps.unitPrProvider.isAncestor).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'owner/repo',
        ancestorSha: 'head-7',
        descendantRef: 'aidlc/i1',
      }),
    );
    expect(invokes.map((payload) => payload.command)).toContain('reconcile-lane');
    expect(invokes.map((payload) => payload.command)).toContain('refresh-intent');
    expect(invokes).toContainEqual(
      expect.objectContaining({
        command: 'record-unit-pr',
        unitPrs: [
          expect.objectContaining({
            sectionIndex: 1,
            unitSlug: 'auth',
            repoId: 'owner/repo',
            provider: 'github',
            prNumber: 7,
          }),
        ],
      }),
    );
    expect(unitStates.map((row) => row.state)).toEqual(
      expect.arrayContaining(['PR_DRAFT', 'RECONCILING', 'PR_READY', 'MERGED']),
    );
    expect(deps.stopSession).toHaveBeenCalledWith('aidlc-intent-i1-s1-auth'.padEnd(33, '0'));
  });

  it('parks one callback for a long unchanged PR wait without growing durable operations', async () => {
    const originalCreateCallback = ctx.createCallback;
    let resolvePrWait;
    ctx.step = vi.fn(async (_name, fn) => fn());
    ctx.wait = vi.fn(async () => undefined);
    ctx.createCallback = async (name) => {
      if (!String(name).startsWith('unit-pr-wait-')) return originalCreateCallback(name);
      const promise = new Promise((resolve) => {
        resolvePrWait = resolve;
      });
      return [promise, `cb-${name}`];
    };
    let merged = false;
    configure({
      statusFor: async ({ number }) => ({
        providerId: `provider-${number}`,
        number,
        url: `https://example.test/pr/${number}`,
        sourceBranch: 'aidlc/i1--s1-unit-auth',
        targetBranch: 'aidlc/i1',
        headSha: `head-${number}`,
        targetSha: 'intent-before',
        state: merged ? 'merged' : 'open',
        draft: false,
        mergeable: true,
      }),
    });

    const running = start();
    await vi.waitFor(() => expect(deps.store.bindUnitPrWait).toHaveBeenCalledOnce());
    const operationCount = ctx.step.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ctx.step).toHaveBeenCalledTimes(operationCount);
    expect(ctx.wait).not.toHaveBeenCalled();

    merged = true;
    resolvePrWait({ answer: { reason: 'merged' } });
    await expect(running).resolves.toMatchObject({ ok: true });
    expect(deps.store.bindUnitPrWait).toHaveBeenCalledOnce();
  });

  it('resumes an existing draft PR after repair without rerunning successful construction', async () => {
    let statusCalls = 0;
    configure({
      statusFor: async ({ number }) => {
        statusCalls += 1;
        return {
          providerId: `provider-${number}`,
          number,
          url: `https://example.test/pr/${number}`,
          sourceBranch: 'aidlc/i1--s1-unit-auth',
          targetBranch: 'aidlc/i1',
          headSha: 'head-12',
          targetSha: 'intent-before',
          state: statusCalls >= 2 ? 'merged' : 'open',
          draft: statusCalls < 2,
          mergeable: true,
        };
      },
    });
    const existing = {
      executionId: 'i1',
      sectionIndex: 1,
      unitSlug: 'auth',
      repository: 'owner/repo',
      provider: 'github',
      number: 12,
      sourceBranch: 'aidlc/i1--s1-unit-auth',
      targetBranch: 'aidlc/i1',
      headSha: 'head-12',
      state: 'DRAFT',
    };
    unitPrRows.set('owner/repo', existing);
    deps.store.listUnits = vi.fn(async () => [
      { executionId: 'i1', sectionIndex: 1, slug: 'auth', state: 'PR_DRAFT' },
    ]);
    deps.store.listUnitPrs = vi.fn(async () => [existing]);
    deps.store.getStage = vi.fn(async () => ({ state: 'SUCCEEDED' }));
    deps.store.getUnitPlan = vi.fn(async () =>
      UNIT_PLAN({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
        autonomyMode: 'autonomous',
      }),
    );

    const result = await __durableHandler(
      { action: 'start', intentId: 'i1', executionId: 'i1', startAtStageId: 'cg' },
      ctx,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.unitPrProvider.createDraft).not.toHaveBeenCalled();
    expect(invokes.filter((payload) => payload.command === 'init-lane')).toHaveLength(0);
    expect(
      stageStarts().filter((payload) => payload.stageId === 'cg' && payload.unitSlug === 'auth'),
    ).toHaveLength(0);
    expect(unitPrStates).toContainEqual(
      expect.objectContaining({ repository: 'owner/repo', state: 'MERGED' }),
    );
  });

  it('claims selected feedback, revises the last successful stage, and posts one summary', async () => {
    const calls = new Map();
    configure({
      statusFor: async ({ number }) => {
        const call = (calls.get(number) ?? 0) + 1;
        calls.set(number, call);
        return {
          providerId: `provider-${number}`,
          number,
          url: `https://example.test/pr/${number}`,
          sourceBranch: 'aidlc/i1--s1-unit-auth',
          targetBranch: 'aidlc/i1',
          headSha: `head-${number}`,
          targetSha: 'intent-before',
          state: call >= 5 ? 'merged' : 'open',
          draft: call < 5,
          mergeable: true,
        };
      },
    });
    const batch = {
      batchId: 'batch-1',
      state: 'QUEUED',
      comments: [
        {
          repository: 'owner/repo',
          prNumber: 7,
          id: '101',
          version: '2026-01-01T00:00:00Z',
          path: 'src/auth.js',
          line: 12,
          body: 'Handle the empty token',
          user: { login: 'reviewer' },
        },
      ],
    };
    deps.store.listFeedbackBatches = vi.fn(async (_executionId, { state }) =>
      batch.state === state ? [batch] : [],
    );
    deps.store.updateFeedbackBatch = vi.fn(async (args) => {
      batch.state = args.state;
      Object.assign(batch, args.fields ?? {});
      return { ...batch };
    });

    const result = await start();
    expect(result.ok).toBe(true);
    expect(deps.store.updateFeedbackBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        state: 'RUNNING',
        fromStates: ['QUEUED'],
      }),
    );
    expect(deps.store.updateFeedbackBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        state: 'SUCCEEDED',
        fromStates: ['RUNNING'],
      }),
    );
    const revision = stageStarts().find((payload) =>
      payload.stageCallbackId.includes('feedback-batch-1'),
    );
    expect(revision).toMatchObject({
      unitSlug: 'auth',
      sectionIndex: 1,
      reviewFeedback: {
        batchId: 'batch-1',
        prompt: expect.stringContaining('Handle the empty token'),
        targets: [
          expect.objectContaining({
            repoId: 'owner/repo',
            number: 7,
            headSha: 'head-7',
            targetSha: 'intent-before',
          }),
        ],
      },
    });
    expect(deps.unitPrProvider.addComment).toHaveBeenCalledOnce();
    expect(deps.unitPrProvider.addComment.mock.calls[0][0].body).toContain(
      'AI-DLC feedback batch: batch-1',
    );
    expect(metrics).toContainEqual({ feedbackCycles: 1 });
  });

  it('preserves a partial multi-repository merge, records outcomes, and halts', async () => {
    const calls = new Map();
    configure({
      repos: ['owner/api', 'owner/web'],
      statusFor: async ({ number }) => {
        const call = (calls.get(number) ?? 0) + 1;
        calls.set(number, call);
        return {
          providerId: `provider-${number}`,
          number,
          url: `https://example.test/pr/${number}`,
          sourceBranch: 'aidlc/i1--s1-unit-auth',
          targetBranch: 'aidlc/i1',
          headSha: `head-${number}`,
          targetSha: 'intent-before',
          state: call >= 3 ? (number === 7 ? 'merged' : 'closed') : 'open',
          draft: call < 3,
          mergeable: true,
        };
      },
    });

    const result = await start();
    expect(result).toMatchObject({ ok: false, reason: 'section_aborted' });
    expect(unitPrStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: 'owner/api', state: 'PARTIALLY_MERGED' }),
        expect.objectContaining({ repository: 'owner/web', state: 'CLOSED' }),
      ]),
    );
    expect(unitStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'auth',
          state: 'FAILED',
          fields: expect.objectContaining({
            failureReason: expect.stringContaining('partial_merge'),
          }),
        }),
      ]),
    );
    expect(metrics).toContainEqual({ partialMerges: 1 });
  });

  it('keeps an already integrated repository out of retry readiness and normalizes its outcome', async () => {
    const calls = new Map();
    configure({
      repos: ['owner/api', 'owner/web'],
      statusFor: async ({ number }) => {
        const call = (calls.get(number) ?? 0) + 1;
        calls.set(number, call);
        return {
          providerId: `provider-${number}`,
          number,
          url: `https://example.test/pr/${number}`,
          sourceBranch: 'aidlc/i1--s1-unit-auth',
          targetBranch: 'aidlc/i1',
          headSha: `head-${number}`,
          targetSha: 'intent-before',
          state: number === 6 || call >= 3 ? 'merged' : 'open',
          draft: number !== 6 && call < 3,
          mergeable: true,
        };
      },
    });
    unitPrRows.set('owner/api', {
      executionId: 'i1',
      sectionIndex: 1,
      unitSlug: 'auth',
      repository: 'owner/api',
      provider: 'github',
      number: 6,
      sourceBranch: 'aidlc/i1--s1-unit-auth',
      targetBranch: 'aidlc/i1',
      headSha: 'head-6',
      state: 'PARTIALLY_MERGED',
      repositoryOutcome: 'merged',
    });
    deps.unitPrProvider.compare.mockImplementation(async ({ repoId }) => ({
      status: repoId === 'owner/api' ? 'identical' : 'ahead',
    }));

    const result = await start();
    expect(result.ok).toBe(true);
    expect(deps.unitPrProvider.createDraft).toHaveBeenCalledOnce();
    expect(deps.unitPrProvider.setDraft).not.toHaveBeenCalledWith(
      expect.objectContaining({ number: 6, draft: false }),
    );
    expect(unitPrStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repository: 'owner/api',
          state: 'MERGED',
          fields: expect.objectContaining({ repositoryOutcome: 'merged' }),
        }),
      ]),
    );
    expect(
      unitPrStates.some((row) => row.repository === 'owner/api' && row.state === 'UNCHANGED'),
    ).toBe(false);
  });
});

// ── WP5: gate-driven decisions (retry / skip / overrides / autonomy) ─────────

describe('WP5 — engine-gate decisions', () => {
  let unitStates;
  // The UNITPLAN row is the scheduling truth: the fan-out approval patches it
  // (updateUnitPlanDecisions) and the section runner re-reads it — the mock
  // mirrors that persistence.
  let unitPlanRow;
  // Route engine-gate reads (eg-*) by prefix; everything else stays 'answered'
  // (stage question gates in the park loop). Rows carry their id — the
  // orchestrator threads gate.humanTaskId into revision resumes.
  const gateReads = (byPrefix) =>
    vi.fn(async (_e, id) => {
      for (const [prefix, val] of Object.entries(byPrefix)) {
        if (String(id).startsWith(prefix)) return { humanTaskId: id, status: 'answered', ...val };
      }
      return { humanTaskId: id, status: 'answered' };
    });

  beforeEach(() => {
    unitStates = [];
    unitPlanRow = UNIT_PLAN();
    deps.loadPlan = vi.fn(async () => SECTION_PLAN());
    deps.store.getUnitPlan = vi.fn(async () => unitPlanRow);
    deps.store.createHumanTask = vi.fn(async (args) => args);
    deps.store.updateUnitPlanDecisions = vi.fn(async (patch) => {
      unitPlanRow = { ...unitPlanRow, ...patch };
      return unitPlanRow;
    });
    deps.store.updateUnitState = vi.fn(async (args) => {
      unitStates.push(args);
      return { slug: args.slug, state: args.state };
    });
    deps.store.putStage = vi.fn(async (args) => args);
    deps.store.getStage = vi.fn(async () => null);
    deps.invokeRuntime = makeRuntime(ctx, sectionScript);
  });

  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

  it('halt-and-ask RETRY re-runs the failed lane under fresh round identities and completes the run', async () => {
    let cgBillingAttempts = 0;
    deps.store.getHumanTask = gateReads({ 'eg-halt': { answer: { decision: 'retry' } } });
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.stageId === 'cg' && payload.unitSlug === 'billing') {
        cgBillingAttempts += 1;
        if (cgBillingAttempts === 1)
          return { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
      }
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // billing's cg ran twice: the failed round-0 attempt and the round-1 retry
    // under a DISTINCT durable callback identity.
    const cgBilling = stageStarts().filter((p) => p.stageId === 'cg' && p.unitSlug === 'billing');
    expect(cgBilling.map((p) => p.stageCallbackId)).toEqual([
      'cb-stage-cb-cg-s1-u-billing',
      'cb-stage-cb-cg-s1-u-billing-r1',
    ]);
    const billingSessionId = 'aidlc-intent-i1-s1-billing'.padEnd(33, '0');
    const billingSessionStops = deps.stopSession.mock.calls.filter(
      ([sessionId]) => sessionId === billingSessionId,
    );
    expect(billingSessionStops).toHaveLength(2);
    const retryReleaseOrder = deps.stopSession.mock.invocationCallOrder.find(
      (_, index) => deps.stopSession.mock.calls[index][0] === billingSessionId,
    );
    const retryStageOrder = deps.invokeRuntime.mock.invocationCallOrder.filter((_, index) => {
      const payload = deps.invokeRuntime.mock.calls[index][0];
      return payload.stageId === 'cg' && payload.unitSlug === 'billing';
    })[1];
    expect(retryReleaseOrder).toBeLessThan(retryStageOrder);
    // Lane states: billing FAILED (round 0) then revived RUNNING → MERGED.
    const billing = unitStates.filter((u) => u.slug === 'billing').map((u) => u.state);
    expect(billing).toEqual(['RUNNING', 'FAILED', 'RUNNING', 'MERGING', 'MERGED']);
    // The retry-round revive CAS accepts FAILED/BLOCKED lanes.
    const revive = unitStates.filter((u) => u.slug === 'billing' && u.state === 'RUNNING')[1];
    expect(revive.fromStates).toContain('FAILED');
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.find((e) => e.type === 'v2.units.halt_decision')?.summary).toContain('retry');
  });

  it('halt-and-ask SKIP preserves merged lanes and lets the run continue without the failed unit', async () => {
    deps.store.getHumanTask = gateReads({ 'eg-halt': { answer: { decision: 'skip' } } });
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.stageId === 'cg' && payload.unitSlug === 'billing')
        return { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    // The run reaches SUCCEEDED: auth merged, billing failed-and-skipped, bt ran.
    expect(res.ok).toBe(true);
    expect(stageStarts().map((p) => `${p.stageId}:${p.unitSlug ?? '-'}`)).toContain('bt:-');
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.units.lanes_skipped')).toBe(true);
    expect(eventCalls.find((e) => e.type === 'v2.units.fan_in')?.summary).toContain('1/2');
  });

  it('AUTONOMOUS wavefront: a failed lane BLOCKS its dependents while independents finish', async () => {
    // 3 units: auth (skeleton), b, c (depends on b). Ladder → autonomous.
    deps.store.getUnitPlan = vi.fn(async () => ({
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'b', dependsOn: [] },
        { slug: 'c', dependsOn: ['b'] },
      ],
      batches: [['auth', 'b'], ['c']],
      skipMatrix: {},
      walkingSkeleton: 'auth',
    }));
    deps.store.getHumanTask = gateReads({
      'eg-ladder': { answer: { mode: 'autonomous' } },
      'eg-halt': { answer: { decision: 'skip' } },
    });
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 3, batchCount: 2 };
      if (payload.stageId === 'cg' && payload.unitSlug === 'b')
        return { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    expect(res.ok).toBe(true); // human skipped after the failure
    // c never dispatched a stage — it blocked on b.
    expect(stageStarts().some((p) => p.unitSlug === 'c')).toBe(false);
    const cStates = unitStates.filter((u) => u.slug === 'c').map((u) => u.state);
    expect(cStates).toEqual(['BLOCKED']);
    expect(unitStates.find((u) => u.slug === 'c' && u.state === 'BLOCKED').fields).toMatchObject({
      blockedOn: 'b',
    });
    // In autonomous mode there is NO batch gate.
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.units.batch_approved')).toBe(false);
    expect(eventCalls.find((e) => e.type === 'v2.units.autonomy_set')?.summary).toContain(
      'autonomous',
    );
  });

  it('AUTONOMOUS wavefront dispatches independent sibling stages concurrently', async () => {
    unitPlanRow = {
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'asset', dependsOn: [] },
        { slug: 'charts', dependsOn: [] },
      ],
      batches: [['auth', 'asset', 'charts']],
      skipMatrix: {},
      walkingSkeleton: 'auth',
      autonomyMode: 'autonomous',
    };
    let releaseWhenChartsStarts;
    const chartsStarted = new Promise((resolve) => {
      releaseWhenChartsStarts = resolve;
    });
    let assetWaitedForCharts = false;
    deps.invokeRuntime = makeRuntime(ctx, async (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') {
        return { ok: true, unitCount: 3, batchCount: 1 };
      }
      if (payload.stageId === 'fd' && payload.unitSlug === 'asset') {
        await chartsStarted;
        assetWaitedForCharts = true;
      }
      if (payload.stageId === 'fd' && payload.unitSlug === 'charts') {
        releaseWhenChartsStarts();
      }
      return { ok: true, state: 'SUCCEEDED' };
    });

    const res = await start();

    expect(res.ok).toBe(true);
    expect(assetWaitedForCharts).toBe(true);
    expect(
      stageStarts().filter(
        (payload) => payload.stageId === 'fd' && ['asset', 'charts'].includes(payload.unitSlug),
      ),
    ).toHaveLength(2);
  });

  it('fan-out overrides on the unit-DAG stage gate re-pick the skeleton and extend the skip matrix (validated)', async () => {
    // Independent units: a dependency-free skeleton override is valid. The
    // overrides ride the units-gen stage's validation gate (the fan-out
    // approval) — there is no separate fan-out engine gate.
    unitPlanRow = {
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'billing', dependsOn: [] },
      ],
      batches: [['auth', 'billing']],
      skipMatrix: {},
    };
    deps.store.getHumanTask = gateReads({
      'eg-validation-si-units-gen': {
        answer: {
          decision: 'approve',
          walkingSkeleton: 'billing',
          // fd is CONDITIONAL (skippable); cg is ALWAYS (must be rejected);
          // 'ghost' is not a unit (must be rejected).
          skipMatrix: { auth: ['fd', 'cg'], ghost: ['fd'] },
        },
      },
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // billing ran FIRST (the overridden skeleton), solo.
    const laneOrder = invokes.filter((p) => p.command === 'init-lane').map((p) => p.unitSlug);
    expect(laneOrder).toEqual(['billing', 'auth']);
    // auth's fd was skipped (valid override), its cg still ran (ALWAYS).
    const authStages = stageStarts()
      .filter((p) => p.unitSlug === 'auth')
      .map((p) => p.stageId);
    expect(authStages).toEqual(['cg']);
    // The frozen decisions were persisted and invalid entries audited.
    expect(deps.store.updateUnitPlanDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ walkingSkeleton: 'billing', skipMatrix: { auth: ['fd'] } }),
    );
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    const invalid = eventCalls.find((e) => e.type === 'v2.units.decisions_invalid');
    expect(invalid?.summary).toContain('cg');
    expect(invalid?.summary).toContain('ghost');
  });

  it('rejects a DEPENDENT unit as the skeleton override (it must run solo first)', async () => {
    // billing depends on auth (the default UNIT_PLAN) → override invalid,
    // the default (auth) stays the skeleton.
    deps.store.getHumanTask = gateReads({
      'eg-validation-si-units-gen': { answer: { decision: 'approve', walkingSkeleton: 'billing' } },
    });
    const res = await start();
    expect(res.ok).toBe(true);
    const laneOrder = invokes.filter((p) => p.command === 'init-lane').map((p) => p.unitSlug);
    expect(laneOrder).toEqual(['auth', 'billing']);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.find((e) => e.type === 'v2.units.decisions_invalid')?.summary).toContain(
      'dependency-free',
    );
  });

  it('the unit-DAG stage gate is REQUIRED (fan-out approval) even without humanValidation, and request-changes re-runs the stage', async () => {
    // units-gen carries no humanValidation flag, yet a section consumes its
    // DAG → the gate opens anyway (A2 rule 2). A rejected round-0 gate is a
    // request-changes: the stage re-runs with the feedback, re-promotes, and
    // the round-1 approval fans out — the run never fails on a reject.
    deps.store.getHumanTask = gateReads({
      'eg-validation-si-units-gen-0': {
        status: 'rejected',
        answer: { decision: 'request-changes', feedback: 'split the auth unit' },
      },
      'eg-validation-si-units-gen-1': { answer: { decision: 'approve' } },
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // The stage ran twice — the revision leg resumed from the answered gate.
    const genRuns = stageStarts().filter((p) => p.stageId === 'units-gen');
    expect(genRuns).toHaveLength(2);
    expect(genRuns[1].resumeFrom).toContain('eg-validation-si-units-gen-0');
    // Promotion re-ran for the re-produced DAG (once per round).
    expect(invokes.filter((p) => p.command === 'promote-units')).toHaveLength(2);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.stage.revision_requested')).toBe(true);
    expect(eventCalls.filter((e) => e.type === 'v2.units.fanout_approved')).toHaveLength(1);
    // Lanes only started after the approval.
    expect(invokes.some((p) => p.command === 'init-lane')).toBe(true);
  });

  it('request-changes on the skeleton gate re-runs the skeleton lane with feedback, then re-asks (never terminal)', async () => {
    deps.store.getHumanTask = gateReads({
      // Revision gate (v1) approves; the round-0 gate requests changes.
      'eg-skeleton-s1-v1': { answer: { decision: 'approve' } },
      'eg-skeleton-s1': {
        answer: { decision: 'request-changes', feedback: 'wire real auth, not a stub' },
      },
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // The skeleton lane ran twice: original + revision (re-init, re-merge).
    expect(invokes.filter((p) => p.command === 'init-lane' && p.unitSlug === 'auth')).toHaveLength(
      2,
    );
    expect(invokes.filter((p) => p.command === 'merge-lane' && p.unitSlug === 'auth')).toHaveLength(
      2,
    );
    // Revision stages resumed from the answered skeleton gate (feedback in).
    const revisionRuns = stageStarts().filter(
      (p) => p.unitSlug === 'auth' && String(p.resumeFrom ?? '').startsWith('eg-skeleton-s1'),
    );
    expect(revisionRuns.length).toBeGreaterThan(0);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.units.skeleton_revision_requested')).toBe(true);
    // Approved on the revision gate; the remaining lane then ran.
    expect(eventCalls.some((e) => e.type === 'v2.units.skeleton_approved')).toBe(true);
    expect(invokes.some((p) => p.command === 'init-lane' && p.unitSlug === 'billing')).toBe(true);
  });

  it('request-changes on a batch gate re-runs the batch lanes with feedback, then re-asks (gated mode)', async () => {
    // Ladder answer unparseable → deterministic 'gated'. Wave 1 = billing:
    // round-0 batch gate requests changes; the v1 gate approves.
    deps.store.getHumanTask = gateReads({
      'eg-batch-s1-w1-v1': { answer: { decision: 'approve' } },
      'eg-batch-s1-w1': {
        answer: { decision: 'request-changes', feedback: 'billing misses the refund path' },
      },
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // billing's lane ran twice: original + revision (re-init, re-merge).
    expect(
      invokes.filter((p) => p.command === 'init-lane' && p.unitSlug === 'billing'),
    ).toHaveLength(2);
    expect(
      invokes.filter((p) => p.command === 'merge-lane' && p.unitSlug === 'billing'),
    ).toHaveLength(2);
    // The revision leg resumed from the answered batch gate (feedback in).
    const revisionRuns = stageStarts().filter(
      (p) => p.unitSlug === 'billing' && String(p.resumeFrom ?? '').startsWith('eg-batch-s1-w1'),
    );
    expect(revisionRuns.length).toBeGreaterThan(0);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.some((e) => e.type === 'v2.units.batch_revision_requested')).toBe(true);
    expect(eventCalls.some((e) => e.type === 'v2.units.batch_approved')).toBe(true);
  });

  it('an uninterpretable halt-and-ask answer RE-ASKS; the follow-up choice is honored', async () => {
    deps.store.getHumanTask = gateReads({
      'eg-halt-s1-r0-a1': { answer: { decision: 'skip' } },
      'eg-halt-s1-r0': { answer: { decision: 'garbage' } },
    });
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.stageId === 'cg' && payload.unitSlug === 'billing')
        return { ok: false, state: 'FAILED', reason: 'sensor_blocked' };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    // The re-asked gate's skip was honored — the run completed without billing.
    expect(res.ok).toBe(true);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(eventCalls.filter((e) => e.type === 'v2.units.halt_reask')).toHaveLength(1);
    expect(eventCalls.find((e) => e.type === 'v2.units.halt_decision')?.summary).toContain('skip');
    expect(eventCalls.some((e) => e.type === 'v2.units.lanes_skipped')).toBe(true);
  });

  it('a pre-set autonomyMode on the UNITPLAN skips the ladder prompt (deterministic resume)', async () => {
    deps.store.getUnitPlan = vi.fn(async () => UNIT_PLAN({ autonomyMode: 'autonomous' }));
    const opened = [];
    deps.store.createHumanTask = vi.fn(async (args) => {
      opened.push(args.humanTaskId);
      return args;
    });
    // Engine gates must actually open (pre-read finds nothing) to observe them.
    deps.store.getHumanTask = vi.fn(async (_e, id) => {
      if (String(id).startsWith('eg-') && !opened.some((o) => o === id)) return null;
      return { status: 'answered' };
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // The unit-DAG stage's validation gate (fan-out approval) + skeleton gate
    // opened; NO ladder gate, NO batch gates.
    expect(opened.some((id) => id.startsWith('eg-validation-si-units-gen'))).toBe(true);
    expect(opened.some((id) => id.startsWith('eg-skeleton'))).toBe(true);
    expect(opened.some((id) => id.startsWith('eg-ladder'))).toBe(false);
    expect(opened.some((id) => id.startsWith('eg-batch'))).toBe(false);
  });
});

// ── WP6: conflict-resolution stage wiring (docs/v2-parallel.md) ──────────────

describe('WP6 — merge conflict → resolution stage → retry → halt on repeat failure', () => {
  let unitStates;
  beforeEach(() => {
    unitStates = [];
    deps.loadPlan = vi.fn(async () => SECTION_PLAN());
    deps.store.getUnitPlan = vi.fn(async () => UNIT_PLAN());
    deps.store.createHumanTask = vi.fn(async (args) => args);
    deps.store.updateUnitPlanDecisions = vi.fn(async () => ({}));
    deps.store.updateUnitState = vi.fn(async (args) => {
      unitStates.push(`${args.slug}:${args.state}`);
      return { slug: args.slug, state: args.state };
    });
    deps.store.putStage = vi.fn(async (args) => args);
    deps.store.getStage = vi.fn(async () => null);
  });

  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

  it('one conflicted lane: resolve-conflict runs in the LANE session, the merge retry lands, lane MERGED', async () => {
    let authMerges = 0;
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.command === 'merge-lane' && payload.unitSlug === 'auth') {
        authMerges += 1;
        if (authMerges === 1)
          return {
            ok: false,
            reason: 'merge_conflict',
            conflicts: ['o/r:shared.txt'],
            detail: 'o/r: conflict',
          };
        return { ok: true };
      }
      if (payload.command === 'resolve-conflict')
        return { ok: true, unitSlug: payload.unitSlug, resolvedFiles: ['o/r:shared.txt'] };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    expect(res.ok).toBe(true);
    // Dispatch order for auth: merge (conflict) → resolve → merge retry.
    const authOps = invokes
      .map((p, i) => ({ p, s: sessions[i] }))
      .filter(
        ({ p }) => ['merge-lane', 'resolve-conflict'].includes(p.command) && p.unitSlug === 'auth',
      );
    expect(authOps.map(({ p }) => p.command)).toEqual([
      'merge-lane',
      'resolve-conflict',
      'merge-lane',
    ]);
    // The resolution runs in the LANE session; merges in the intent session.
    expect(authOps[1].s).toBe('aidlc-intent-i1-s1-auth'.padEnd(33, '0'));
    expect(authOps[0].s).toBe('aidlc-intent-i1'.padEnd(33, '0'));
    // The resolution payload carries everything the command needs.
    expect(authOps[1].p).toMatchObject({
      unitSlug: 'auth',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      sectionIndex: 1,
      requestedCli: 'kiro',
    });
    // Lane still ended MERGED; the conflict is on the audit trail.
    expect(unitStates.filter((s) => s.startsWith('auth:'))).toEqual([
      'auth:RUNNING',
      'auth:MERGING',
      'auth:MERGED',
    ]);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(
      eventCalls.find((e) => e.type === 'v2.unit.conflict' && e.unitSlug === 'auth')?.summary,
    ).toContain('shared.txt');
  });

  it('a failed resolution does NOT retry the merge — it escalates to halt-and-ask (human gate on repeat failure)', async () => {
    deps.store.getHumanTask = vi.fn(async (_e, id) =>
      String(id).startsWith('eg-halt')
        ? { status: 'answered', answer: { decision: 'abort' } }
        : { status: 'answered' },
    );
    deps.invokeRuntime = makeRuntime(ctx, (payload) => {
      if (payload.command === 'init-ws') return { ok: true };
      if (payload.command === 'promote-units') return { ok: true, unitCount: 2, batchCount: 2 };
      if (payload.command === 'merge-lane' && payload.unitSlug === 'auth')
        return { ok: false, reason: 'merge_conflict', conflicts: ['o/r:shared.txt'] };
      if (payload.command === 'resolve-conflict')
        return { ok: false, reason: 'markers_remain', remaining: ['shared.txt'] };
      return { ok: true, state: 'SUCCEEDED' };
    });
    const res = await start();
    expect(res).toMatchObject({ ok: false, reason: 'section_aborted' });
    // Exactly ONE merge attempt + ONE resolution attempt — no blind retries.
    const authCmds = invokes
      .filter(
        (p) => p.unitSlug === 'auth' && ['merge-lane', 'resolve-conflict'].includes(p.command),
      )
      .map((p) => p.command);
    expect(authCmds).toEqual(['merge-lane', 'resolve-conflict']);
    // The lane failure carries the RESOLUTION verdict (full traceability).
    expect(unitStates.filter((s) => s.startsWith('auth:'))).toEqual([
      'auth:RUNNING',
      'auth:MERGING',
      'auth:FAILED',
    ]);
    const eventCalls = deps.store.appendEvent.mock.calls.map((c) => c[0]);
    expect(
      eventCalls.find((e) => e.type === 'v2.unit.failed' && e.unitSlug === 'auth')?.summary,
    ).toContain('markers_remain');
    expect(eventCalls.some((e) => e.type === 'v2.units.halt_decision')).toBe(true);
  });
});

// ── WP6: PR at fan-in (intent-pr strategy) ───────────────────────────────────

describe('WP6 — PR opened on SUCCEEDED (intent-pr)', () => {
  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
  const events = () => deps.store.appendEvent.mock.calls.map((c) => c[0]);

  it('opens one PR per repo from the intent branch with execution provenance in the body', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      title: 'Bookstore API',
      prStrategy: 'intent-pr',
      repos: ['o/r', 'o/web'],
    }));
    deps.store.listUnits = vi.fn(async () => [
      { slug: 'auth', state: 'MERGED' },
      { slug: 'billing', state: 'MERGED' },
    ]);
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    // One provider call per repo, with the intent branch + base + provenance.
    expect(deps.openPr).toHaveBeenCalledTimes(2);
    expect(deps.openPr.mock.calls[0][0]).toMatchObject({
      projectId: 'p1',
      gitProvider: 'github',
      repoId: 'o/r',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      title: 'Bookstore API',
    });
    expect(deps.openPr.mock.calls[0][0].body).toContain('Execution ID: i1');
    expect(deps.openPr.mock.calls[0][0].body).toContain('strategy: intent-pr');
    expect(deps.openPr.mock.calls[0][0].body).toContain('2 total, 2 merged');
    const opened = events().filter((e) => e.type === 'v2.pr.opened');
    expect(opened).toHaveLength(2);
    expect(opened[0].summary).toContain('https://github.com/o/r/pull/7');
  });

  it('dispatches record-pr to the runtime with the structured PR data for each opened PR', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      repos: ['o/r', 'o/web'],
      baseBranch: 'main',
    }));
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    const recordCall = invokes.find((p) => p.command === 'record-pr');
    expect(recordCall).toBeTruthy();
    expect(recordCall).toMatchObject({ intentId: 'i1', executionId: 'i1', projectId: 'p1' });
    expect(recordCall.prs).toHaveLength(2);
    expect(recordCall.prs[0]).toMatchObject({
      repoId: 'o/r',
      prUrl: 'https://github.com/o/r/pull/7',
      prNumber: 7,
      branch: 'aidlc/i1',
      baseBranch: 'main',
    });
  });

  it('emits v2.pr.recorded after a successful record-pr (so the UI refetches live)', async () => {
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(events().some((e) => e.type === 'v2.pr.recorded')).toBe(true);
  });

  it('records the retargeted base when the provider retargets an invalid base', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, repos: ['o/r'], baseBranch: 'gone' }));
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
      // The requested base was invalid; the provider retargeted to the default.
      retargetedBase: 'main',
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    const recordCall = invokes.find((p) => p.command === 'record-pr');
    expect(recordCall.prs[0]).toMatchObject({ repoId: 'o/r', baseBranch: 'main' });
  });

  it('does NOT dispatch record-pr when no PR opened (skipped)', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'identical', base: 'main' }));
    deps.openPr = vi.fn(async () => ({ skipped: true, reason: 'no_changes' }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(invokes.find((p) => p.command === 'record-pr')).toBeUndefined();
  });

  it('a failed record-pr dispatch never un-succeeds the run', async () => {
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
    }));
    const realRuntime = deps.invokeRuntime;
    deps.invokeRuntime = vi.fn(async (payload, sessionId) => {
      if (payload.command === 'record-pr') throw new Error('runtime cold');
      return realRuntime(payload, sessionId);
    });
    const res = await start();
    expect(res.ok).toBe(true);
  });

  it('resolves each repo base branch from the per-repo baseBranches map, falling back to the legacy single baseBranch', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      repos: ['o/r', 'o/web'],
      baseBranch: 'main',
      baseBranches: { 'o/web': 'develop' },
    }));
    deps.openPr = vi.fn(async ({ repoId }) => ({
      prUrl: `https://github.com/${repoId}/pull/7`,
      prNumber: 7,
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr.mock.calls[0][0]).toMatchObject({ repoId: 'o/r', baseBranch: 'main' });
    expect(deps.openPr.mock.calls[1][0]).toMatchObject({ repoId: 'o/web', baseBranch: 'develop' });
  });

  it('names skipped/unmerged units in the PR body (honest partial delivery)', async () => {
    deps.store.listUnits = vi.fn(async () => [
      { slug: 'auth', state: 'MERGED' },
      { slug: 'billing', state: 'FAILED', failureReason: 'merge-lane: markers_remain' },
      { slug: 'checkout', state: 'BLOCKED' },
    ]);
    deps.openPr = vi.fn(async () => ({ prUrl: 'https://x/pr/1', prNumber: 1 }));
    await start();
    const body = deps.openPr.mock.calls[0][0].body;
    expect(body).toContain('3 total, 1 merged');
    expect(body).toContain('unit `billing` NOT merged (FAILED: merge-lane: markers_remain)');
    expect(body).toContain('unit `checkout` NOT merged (BLOCKED)');
  });

  it('an identical branch records v2.pr.skipped without calling the provider create API', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'identical', base: 'main' }));
    deps.openPr = vi.fn();
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr).not.toHaveBeenCalled();
    const skipped = events().find((e) => e.type === 'v2.pr.skipped');
    expect(skipped?.summary).toContain('no changes');
  });

  it('a provider failure / guard conflict never un-succeeds the run — loud events only', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, repos: ['o/r', 'o/web'] }));
    deps.openPr = vi
      .fn()
      .mockResolvedValueOnce({
        conflict: true,
        error: 'unmerged branches',
        unmergedBranches: ['x'],
      })
      .mockRejectedValueOnce(new Error('provider 500'));
    const res = await start();
    expect(res).toEqual({ ok: true, intentId: 'i1', stages: 2 });
    const failed = events().filter((e) => e.type === 'v2.pr.failed');
    expect(failed).toHaveLength(2);
    expect(failed[0].summary).toContain('unmerged branches');
    expect(failed[1].summary).toContain('provider 500');
  });

  it('a no-changes result records v2.pr.skipped (v1 semantics preserved)', async () => {
    deps.openPr = vi.fn(async () => ({ skipped: true, reason: 'no_changes' }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(events().some((e) => e.type === 'v2.pr.skipped')).toBe(true);
  });

  // ── PR-time verification (the 2026-07 "no changes" lost-work incident) ─────

  it('a missing head branch is v2.pr.failed ("never pushed"), NOT a benign skip', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'missing_head', base: 'main' }));
    deps.openPr = vi.fn();
    const res = await start();
    expect(res.ok).toBe(true); // PR problems never un-succeed the run
    expect(deps.openPr).not.toHaveBeenCalled();
    const failed = events().find((e) => e.type === 'v2.pr.failed');
    expect(failed?.summary).toContain('does not exist on the remote');
    expect(failed?.summary).toContain('never pushed');
    expect(events().some((e) => e.type === 'v2.pr.skipped')).toBe(false);
  });

  it('an identical branch WITH recorded engine push failures is v2.pr.failed (likely lost work)', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'identical', base: 'main' }));
    deps.store.listEvents = vi.fn(async () => [
      {
        eventType: 'v2.git.push_failed',
        summary: 'Engine push failed for code-generation: owner/repo (commit_failed: ENOSPC)',
      },
    ]);
    deps.openPr = vi.fn();
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr).not.toHaveBeenCalled();
    const failed = events().find((e) => e.type === 'v2.pr.failed');
    expect(failed?.summary).toContain('no commits ahead of main');
    expect(failed?.summary).toContain('push FAILURES');
    expect(failed?.summary).toContain('likely lost work');
  });

  it('an identical branch with NO recorded repo work stays a benign v2.pr.skipped', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'identical', base: 'main' }));
    deps.store.listEvents = vi.fn(async () => [
      { eventType: 'v2.stage.succeeded', summary: 'Stage a succeeded' },
    ]);
    deps.openPr = vi.fn();
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr).not.toHaveBeenCalled();
    const skipped = events().find((e) => e.type === 'v2.pr.skipped');
    expect(skipped?.summary).toContain('no changes');
    expect(events().some((e) => e.type === 'v2.pr.failed')).toBe(false);
  });

  it('an ahead branch passes the pre-check and opens the PR normally', async () => {
    deps.comparePrBranches = vi.fn(async () => ({ status: 'ahead', aheadBy: 3, base: 'main' }));
    deps.openPr = vi.fn(async () => ({ prUrl: 'https://x/pr/9', prNumber: 9 }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    expect(events().some((e) => e.type === 'v2.pr.opened')).toBe(true);
  });

  it('an unavailable comparison (throw) falls through to the PR call — never a new block', async () => {
    deps.comparePrBranches = vi.fn(async () => {
      throw new Error('compare 500');
    });
    deps.openPr = vi.fn(async () => ({ prUrl: 'https://x/pr/9', prNumber: 9 }));
    const res = await start();
    expect(res.ok).toBe(true);
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    expect(events().some((e) => e.type === 'v2.pr.opened')).toBe(true);
  });

  it("the provider's own no_changes skip is overridden to v2.pr.failed when the run recorded engine pushes", async () => {
    // Compare unavailable (unknown) so the provider verdict is the only signal.
    deps.comparePrBranches = vi.fn(async () => ({ status: 'unknown' }));
    deps.store.listEvents = vi.fn(async () => [
      {
        eventType: 'v2.git.pushed',
        summary: 'Engine committed + pushed work for code-generation (owner/repo@abc12345)',
      },
    ]);
    deps.openPr = vi.fn(async () => ({ skipped: true, reason: 'no_changes' }));
    const res = await start();
    expect(res.ok).toBe(true);
    const failed = events().find((e) => e.type === 'v2.pr.failed');
    expect(failed?.summary).toContain('likely lost work');
    expect(events().some((e) => e.type === 'v2.pr.skipped')).toBe(false);
  });

  it('a provider head_missing failure result records v2.pr.failed with the detail', async () => {
    deps.openPr = vi.fn(async () => ({
      failed: true,
      reason: 'head_missing',
      error:
        'Head branch "aidlc/i1" does not exist on the remote — the intent branch was never pushed',
    }));
    const res = await start();
    expect(res.ok).toBe(true);
    const failed = events().find((e) => e.type === 'v2.pr.failed');
    expect(failed?.summary).toContain('head_missing');
    expect(failed?.summary).toContain('never pushed');
  });

  it('git activity attribution is PER REPO — a push failure in one repo does not poison the other', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, repos: ['o/r', 'o/web'] }));
    deps.comparePrBranches = vi.fn(async () => ({ status: 'identical', base: 'main' }));
    deps.store.listEvents = vi.fn(async () => [
      {
        eventType: 'v2.git.push_failed',
        summary: 'Engine push failed for code-generation: o/r (commit_failed)',
      },
    ]);
    deps.openPr = vi.fn();
    const res = await start();
    expect(res.ok).toBe(true);
    const failed = events().filter((e) => e.type === 'v2.pr.failed');
    const skipped = events().filter((e) => e.type === 'v2.pr.skipped');
    expect(failed).toHaveLength(1);
    expect(failed[0].summary).toContain('o/r');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].summary).toContain('o/web');
  });
});

describe('credential-free runtime payloads', () => {
  const start = () =>
    __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);

  it('never sends source-control credential fields to AgentCore', async () => {
    const result = await start();
    expect(result.ok).toBe(true);
    for (const payload of invokes) {
      expect(payload).not.toHaveProperty('gitToken');
      expect(payload).not.toHaveProperty('accessToken');
      expect(payload).not.toHaveProperty('refreshToken');
      expect(payload).not.toHaveProperty('credential');
    }
  });

  it('uses the snapshotted starter as git author on every git-backed dispatch', async () => {
    const author = { name: 'Jane Starter', email: 'jane@example.com' };
    deps.store.getExecution = vi.fn(async () => ({
      ...META,
      starterName: author.name,
      starterEmail: author.email,
    }));
    const result = await start();
    expect(result.ok).toBe(true);
    const gitPayloads = invokes.filter((payload) =>
      ['init-ws', 'run-stage-start'].includes(payload.command),
    );
    expect(gitPayloads.length).toBeGreaterThan(0);
    for (const payload of gitPayloads) expect(payload.gitAuthor).toEqual(author);
  });

  it('omits gitAuthor when no starter identity was snapshotted', async () => {
    const result = await start();
    expect(result.ok).toBe(true);
    for (const payload of invokes) expect(payload).not.toHaveProperty('gitAuthor');
  });
});
