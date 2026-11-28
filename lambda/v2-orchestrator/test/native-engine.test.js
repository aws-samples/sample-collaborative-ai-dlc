import { describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';

// A native intent (`engine: "native"`) is not run by the stage engine. The
// intents API refuses to start one; this covers the orchestrator's own guard
// for an execution that arrives anyway.
const setup = (metaOverrides = {}) => {
  const meta = {
    executionId: 'intent',
    intentId: 'intent',
    projectId: 'project',
    status: 'CREATED',
    engine: 'native',
    workflowId: null,
    workflowVersion: null,
    scope: null,
    repos: ['owner/repo'],
    primaryRepo: 'owner/repo',
    branch: 'aidlc/native',
    startedAt: '2026-11-26T00:00:00.000Z',
    ...metaOverrides,
  };
  const store = {
    getExecution: vi.fn(async () => ({ ...meta })),
    updateExecution: vi.fn(async (input) => ({ ...meta, ...input })),
    appendEvent: vi.fn(async () => {}),
    putStage: vi.fn(async () => {}),
    getStage: vi.fn(async () => null),
  };
  const deps = {
    store,
    loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: [] } })),
    invokeRuntime: vi.fn(async () => ({ ok: true })),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
    openPr: vi.fn(async () => null),
    comparePrBranches: vi.fn(async () => ({ status: 'ahead' })),
  };
  const steps = [];
  const ctx = {
    step: async (name, fn) => {
      steps.push(name);
      return fn();
    },
    createCallback: vi.fn(async (name) => [Promise.resolve(JSON.stringify({ ok: true })), name]),
    logger: { info() {}, error() {} },
  };
  return {
    deps,
    steps,
    ctx,
    run: (event = {}) =>
      __durableHandler(
        { action: 'start', intentId: 'intent', executionId: 'intent', ...event },
        ctx,
        deps,
      ),
  };
};

describe('a native execution that reaches the orchestrator', () => {
  it.each(['CREATED', 'DRAFT', 'RUNNING', 'FAILED'])(
    'fails closed for a %s execution without loading a stage plan',
    async (status) => {
      const world = setup({ status });

      await expect(world.run()).resolves.toEqual({
        ok: false,
        reason: 'native_engine_unsupported',
      });

      // The read of the execution is the only durable step: the run is never
      // claimed, the workspace is never initialized and no plan is resolved.
      expect(world.steps).toEqual(['load-meta']);
      expect(world.deps.loadPlan).not.toHaveBeenCalled();
      expect(world.deps.invokeRuntime).not.toHaveBeenCalled();
      expect(world.ctx.createCallback).not.toHaveBeenCalled();
      expect(world.deps.store.updateExecution).not.toHaveBeenCalled();
      expect(world.deps.store.appendEvent).not.toHaveBeenCalled();
      expect(world.deps.store.putStage).not.toHaveBeenCalled();
      expect(world.deps.broadcast).not.toHaveBeenCalled();
      expect(world.deps.openPr).not.toHaveBeenCalled();
    },
  );

  it('fails closed on a rewind relaunch as well', async () => {
    const world = setup();

    await expect(world.run({ startAtStageId: 'requirements-analysis' })).resolves.toEqual({
      ok: false,
      reason: 'native_engine_unsupported',
    });

    expect(world.deps.loadPlan).not.toHaveBeenCalled();
    expect(world.deps.store.updateExecution).not.toHaveBeenCalled();
  });

  it('leaves a platform execution on the stage engine', async () => {
    // The same harness without `engine` reaches the plan: the guard keys on the
    // stored engine only, and the step sequence starts as it always did.
    const world = setup({ engine: undefined, workflowId: 'workflow', workflowVersion: 1 });
    world.deps.loadPlan.mockResolvedValue({ valid: false, errors: [{ code: 'broken' }] });

    await expect(world.run()).resolves.toMatchObject({ ok: false, reason: 'plan_invalid' });

    expect(world.steps.slice(0, 2)).toEqual(['load-meta', 'mint-run-id']);
    expect(world.steps).toContain('load-plan');
    expect(world.deps.loadPlan).toHaveBeenCalledOnce();
  });
});
