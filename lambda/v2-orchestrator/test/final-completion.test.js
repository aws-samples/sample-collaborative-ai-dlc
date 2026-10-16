import { expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';
import { unitPlanIdentity } from '../../shared/unit-completion.js';

const setup = () => {
  const meta = {
    executionId: 'intent',
    intentId: 'intent',
    projectId: 'project',
    status: 'RUNNING',
    workflowId: 'workflow',
    workflowVersion: 1,
    scope: 'feature',
    repos: ['owner/repo'],
    branch: 'intent-branch',
    startedAt: '2026-10-01T00:00:00.000Z',
  };
  const unitPlan = {
    units: [
      { slug: 'a', dependsOn: [] },
      { slug: 'b', dependsOn: ['a'] },
    ],
    batches: [['a'], ['b']],
    autonomyMode: 'autonomous',
  };
  const units = unitPlan.units.map(({ slug }) => ({ sectionIndex: 1, slug, state: 'MERGED' }));
  const records = { meta, unitPlan, units: structuredClone(units) };
  const events = [];
  const store = {
    getExecution: async () => meta,
    updateExecution: vi.fn(async (input) => {
      Object.assign(meta, input);
      return { ...meta };
    }),
    getUnitPlan: async () => unitPlan,
    listUnits: async () => units, // scheduler's earlier state, independent of final read
    getCompletionRecords: vi.fn(async () => records),
    appendEvent: async (event) => {
      events.push(event.type);
    },
  };
  const deps = {
    store,
    loadPlan: async () => ({
      valid: true,
      plan: { stages: [{ stageId: 'build', parallelSection: 1 }] },
    }),
    invokeRuntime: vi.fn(async () => ({ ok: true })),
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    comparePrBranches: async () => ({ status: 'ahead' }),
    openPr: vi.fn(async () => ({ number: 1, url: 'https://example.test/pr/1' })),
  };
  const ctx = {
    step: async (name, fn) =>
      name.startsWith('section-completion-v1-') || name.startsWith('load-completion-v1-')
        ? { state: 'complete', unresolved: [] }
        : fn(),
    logger: { info() {}, error() {} },
  };
  return {
    deps,
    records,
    events,
    run: () =>
      __durableHandler(
        {
          action: 'start',
          intentId: 'intent',
          executionId: 'intent',
        },
        ctx,
        deps,
      ),
  };
};

it.each(['BLOCKED', 'RUNNING', 'FAILED', 'PENDING', 'missing'])(
  'withholds both success and final PR for an independent final %s observation',
  async (state) => {
    const world = setup();
    if (state === 'missing') world.records.units = [];
    else world.records.units[1].state = state;
    const result = await world.run();
    expect(result).toMatchObject({ ok: false, reason: 'completion_inconsistent' });
    expect(world.records.meta.status).toBe('FAILED');
    expect(world.events).not.toContain('v2.execution.succeeded');
    expect(world.deps.openPr).not.toHaveBeenCalled();
    expect(world.deps.invokeRuntime.mock.calls.some(([p]) => p.command === 'run-stage-start')).toBe(
      false,
    );
  },
);

it('publishes complete work and plan-bound approved omissions', async () => {
  for (const skipped of [false, true]) {
    const world = setup();
    if (skipped) {
      world.records.units[1].state = 'BLOCKED';
      world.records.units[1].completionSkip = {
        humanTaskId: 'approved-skip',
        planIdentity: unitPlanIdentity(world.records.unitPlan),
      };
    }
    expect(await world.run()).toMatchObject({ ok: true });
    expect(world.records.meta.completionValidation.state).toBe(skipped ? 'partial' : 'complete');
    expect(world.deps.openPr).toHaveBeenCalledOnce();
  }
});

it('fails visibly without publication when final reads fail', async () => {
  const world = setup();
  world.deps.store.getCompletionRecords.mockRejectedValue(new Error('DynamoDB unavailable'));
  expect(await world.run()).toMatchObject({ ok: false, reason: 'completion_unverified' });
  expect(world.records.meta.status).toBe('FAILED');
  expect(world.deps.openPr).not.toHaveBeenCalled();
  expect(world.events).not.toContain('v2.execution.succeeded');
});

it('rechecks publication after saved success without rewriting that decision', async () => {
  const world = setup();
  let reads = 0;
  world.deps.store.getCompletionRecords.mockImplementation(async () => {
    if (++reads === 2) world.records.units[1].state = 'BLOCKED';
    return world.records;
  });
  await world.run();
  expect(world.deps.openPr).not.toHaveBeenCalled();
  expect(world.events).toContain('v2.pr.failed');
  expect(world.records.meta.completionValidation.state).toBe('complete');
  expect(world.records.meta.status).toBe('SUCCEEDED');
});
