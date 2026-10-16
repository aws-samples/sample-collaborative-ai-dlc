import { describe, it, expect, vi } from 'vitest';
import {
  effectiveSkeleton,
  skeletonProblem,
  unitCompletion,
  unitPlanIdentity,
  completionSections,
  finalizeUnitCompletion,
  assessExecutionCompletion,
} from '../unit-completion.js';

const unitPlan = {
  units: [
    { slug: 'foundation', dependsOn: [] },
    { slug: 'feature', dependsOn: ['foundation'] },
  ],
  batches: [['foundation'], ['feature']],
  walkingSkeleton: 'feature',
};
const records = () => ({
  meta: { status: 'SUCCEEDED', orchestratorRunId: 'run1' },
  unitPlan,
  units: [
    { slug: 'foundation', sectionIndex: 1, state: 'MERGED' },
    { slug: 'feature', sectionIndex: 1, state: 'BLOCKED' },
    { slug: 'old-plan-unit', sectionIndex: 1, state: 'PENDING' },
  ],
});

describe('active-plan completion', () => {
  it('counts active work and detects false success regardless of the terminal META status', () => {
    expect(unitCompletion(records())).toMatchObject({
      state: 'incomplete',
      total: 2,
      integrated: 1,
      skipped: 0,
    });
  });
  it('requires an exact-plan human skip receipt for partial delivery', () => {
    const input = records();
    input.units[1].completionSkip = {
      humanTaskId: 'halt',
      planIdentity: unitPlanIdentity(unitPlan),
    };
    expect(unitCompletion(input).state).toBe('partial');
    input.unitPlan = {
      ...unitPlan,
      units: [...unitPlan.units, { slug: 'new-work', dependsOn: [] }],
    };
    expect(unitCompletion(input).state).toBe('incomplete');
  });
  it('keeps legacy accepted partial delivery distinct without trusting a prior run decision', () => {
    const input = records();
    input.unitPlan = { ...unitPlan, promotedAt: '2026-10-01T00:00:00.000Z' };
    input.humanTasks = [
      {
        humanTaskId: 'eg-halt-s1-r0-run1',
        orchestratorRunId: 'run1',
        status: 'approved',
        answer: { decision: 'skip' },
        sectionIndex: 1,
        prompt: 'Lane failure in section 1\n- feature: failed',
        createdAt: '2026-10-02T00:00:00.000Z',
      },
    ];
    expect(unitCompletion(input)).toMatchObject({ state: 'partial', legacyPartial: true });
    input.meta.orchestratorRunId = 'run2';
    expect(unitCompletion(input).state).toBe('incomplete');
  });
  it('does not apply one legacy skip to other sections or unrelated unfinished units', () => {
    const input = records();
    input.humanTasks = [
      {
        humanTaskId: 'eg-halt-s1-r0-run1',
        orchestratorRunId: 'run1',
        status: 'answered',
        answer: 'skip',
        sectionIndex: 1,
      },
    ];
    expect(unitCompletion(input, [1]).state).toBe('unknown');
    expect(unitCompletion(input, [2])).toMatchObject({ state: 'incomplete', skipped: 0, total: 2 });
  });
  it('honors an explicit dependent omission if its per-row receipt write was interrupted', () => {
    const input = records();
    input.units[0].state = 'FAILED';
    input.unitPlan = { ...unitPlan, promotedAt: '2026-10-01T00:00:00.000Z' };
    input.humanTasks = [
      {
        humanTaskId: 'eg-halt-s1-r0-run1',
        orchestratorRunId: 'run1',
        status: 'answered',
        answer: 'skip',
        createdAt: '2026-10-02T00:00:00.000Z',
        sectionIndex: 1,
        prompt: `- foundation: failed
- skip: explicitly omit these lanes and all their unintegrated dependents from delivery`,
      },
    ];
    expect(unitCompletion(input, [1])).toMatchObject({ state: 'partial', skipped: 2 });
    input.humanTasks[0].prompt = `- foundation: failed
- skip: continue without them (their work will be missing downstream)`;
    expect(unitCompletion(input, [1])).toMatchObject({ state: 'unknown', skipped: 1 });
  });
  it('uses expected sections even when every row or an entire section is missing', () => {
    const sections = completionSections({
      stages: [
        { stageId: 'design', parallelSection: 1 },
        { stageId: 'review' },
        { stageId: 'implement', parallelSection: 2 },
      ],
    });
    expect(sections).toEqual([1, 2]);
    expect(unitCompletion({ ...records(), units: [] }, sections)).toMatchObject({
      state: 'incomplete',
      total: 4,
      integrated: 0,
    });
    const input = records();
    input.units[1].state = 'MERGED';
    expect(unitCompletion(input, sections)).toMatchObject({
      state: 'incomplete',
      integrated: 2,
      total: 4,
    });
    expect(unitCompletion(input, [1])).toMatchObject({ state: 'complete', total: 2 });
    expect(unitCompletion(input, [])).toMatchObject({ state: 'complete', total: 0 });
  });
  it.each(['PENDING', 'BLOCKED', 'RUNNING', 'FAILED', 'PARTIALLY_MERGED'])(
    'does not resolve an active %s row',
    (state) => {
      const input = records();
      input.units[1].state = state;
      expect(unitCompletion(input, [1])).toMatchObject({ state: 'incomplete', integrated: 1 });
    },
  );
  it('allows serial/no-unit plans but never a missing required unit plan', () => {
    expect(unitCompletion({}, [])).toMatchObject({ state: 'complete', total: 0 });
    expect(unitCompletion({}, [1])).toMatchObject({
      state: 'unknown',
      reason: 'unit_plan_missing',
    });
    expect(unitCompletion({ ...records(), units: [] }).state).toBe('unknown');
  });
  it('checks each repository and preserves the distinction between unknown and partial integration', () => {
    const input = records();
    input.meta.repos = ['one', 'two'];
    input.units[1].state = 'MERGED';
    expect(unitCompletion(input, [1]).state).toBe('complete');
    for (const row of input.units)
      row.integrationResults = [
        { repo: 'one', merged: true },
        { repo: 'two', merged: 'up_to_date' },
      ];
    expect(unitCompletion(input, [1]).state).toBe('complete');
    input.units[1].integrationResults[1].merged = false;
    expect(unitCompletion(input, [1])).toMatchObject({ state: 'incomplete', integrated: 1 });
    input.meta.prStrategy = 'pr-per-unit';
    input.unitPrs = input.units.flatMap((row) =>
      ['one', 'two'].map((repository) => ({
        slug: row.slug,
        sectionIndex: 1,
        repository,
        state: repository === 'one' ? 'MERGED' : 'UNCHANGED',
      })),
    );
    expect(unitCompletion(input, [1]).state).toBe('complete');
    input.unitPrs[3].state = 'PARTIALLY_MERGED';
    expect(unitCompletion(input, [1]).state).toBe('incomplete');
  });
  it.each([
    [[], 'unknown'],
    [[{ repo: 'one', merged: true }], 'unknown'],
    [
      [
        { repo: 'one', merged: true },
        { repo: 'two', merged: false },
      ],
      'incomplete',
    ],
    [null, 'unknown'],
    [{}, 'unknown'],
    ['invalid', 'unknown'],
    [[null], 'unknown'],
    [[{}], 'unknown'],
  ])(
    'does not treat explicit invalid or incomplete evidence %j as a pre-deploy row',
    (evidence, state) => {
      const input = records();
      input.meta.repos = ['one', 'two'];
      input.units[1].state = 'MERGED';
      input.units[1].integrationResults = evidence;
      expect(unitCompletion(input, [1])).toMatchObject({ state, integrated: 1 });
    },
  );
  it('omits unit diagnostics only for legacy unpinned executions without unit work', async () => {
    const meta = { status: 'SUCCEEDED', orchestratorRunId: 'old-run' };
    const loadPlan = async () => ({ valid: true, plan: { stages: [{ parallelSection: 1 }] } });
    expect(await assessExecutionCompletion({ records: { meta, units: [] }, loadPlan })).toBeNull();
    expect(
      await assessExecutionCompletion({ records: { ...records(), meta }, loadPlan }),
    ).toMatchObject({ state: 'unknown', reason: 'legacy_workflow_unpinned' });
    for (const pin of [
      { methodologyPins: { STAGE: {} } },
      { completionValidation: { runId: 'old-run', expectedSections: [1] } },
    ]) {
      expect(
        await assessExecutionCompletion({
          records: { meta: { ...meta, ...pin }, units: [] },
          loadPlan,
        }),
      ).toMatchObject({ state: 'unknown', reason: 'unit_plan_missing' });
    }
  });
  it.each(['CANCELLED', 'recorded-abort'])(
    'classifies unpinned %s work as aborted before loading workflow definitions',
    async (kind) => {
      const input = records();
      input.meta.status = kind === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      if (kind === 'recorded-abort') {
        input.meta.failure = { code: 'section_aborted' };
        input.humanTasks = [
          { orchestratorRunId: 'run1', status: 'answered', answer: { decision: 'abort' } },
        ];
      }
      const before = structuredClone(input);
      const loadPlan = vi.fn(async () => {
        throw new Error('workflow pin unavailable');
      });
      expect(await assessExecutionCompletion({ records: input, loadPlan })).toMatchObject({
        state: 'aborted',
        reason: 'execution_aborted',
        integrated: 1,
        total: 2,
        unresolved: [expect.objectContaining({ slug: 'feature', state: 'BLOCKED' })],
      });
      expect(loadPlan).not.toHaveBeenCalled();
      expect(input).toEqual(before);
    },
  );
  it.each(['stale-run', 'missing-run', 'unrelated-failure', 'pending-answer'])(
    'keeps legacy evidence unknown for a %s abort decision',
    async (kind) => {
      const input = records();
      input.meta.status = 'FAILED';
      input.meta.failure = {
        code: kind === 'unrelated-failure' ? 'stage_failed' : 'section_aborted',
      };
      input.humanTasks = [
        {
          orchestratorRunId: kind === 'stale-run' ? 'prior-run' : 'run1',
          status: kind === 'pending-answer' ? 'pending' : 'answered',
          answer: 'abort',
        },
      ];
      if (kind === 'missing-run') {
        delete input.meta.orchestratorRunId;
        delete input.humanTasks[0].orchestratorRunId;
      }
      expect(await assessExecutionCompletion({ records: input, loadPlan: vi.fn() })).toMatchObject({
        state: 'unknown',
        reason: 'legacy_workflow_unpinned',
      });
    },
  );
  it('retains missing/truncated read semantics before cancellation and handles no-unit cancellation', async () => {
    const input = records();
    input.meta.status = 'CANCELLED';
    const loadPlan = vi.fn();
    expect(
      await assessExecutionCompletion({ records: { ...input, meta: null }, loadPlan }),
    ).toMatchObject({ state: 'unknown', reason: 'execution_missing' });
    expect(
      await assessExecutionCompletion({ records: { ...input, truncated: true }, loadPlan }),
    ).toMatchObject({ state: 'unknown', reason: 'completion_read_limit' });
    expect(
      await assessExecutionCompletion({
        records: { ...input, unitPlan: null, units: [] },
        loadPlan,
      }),
    ).toMatchObject({ state: 'aborted', total: 0, integrated: 0 });
    expect(loadPlan).not.toHaveBeenCalled();
  });
  it('does not guess section mappings for historical slug-only rows', () => {
    const input = records();
    input.units[0].sectionIndex = null;
    expect(unitCompletion(input, [1]).state).toBe('unknown');
  });
  it('reports a missing state as unknown without inventing an execution status', () => {
    const input = records();
    delete input.units[1].state;
    expect(unitCompletion(input, [1])).toMatchObject({
      state: 'unknown',
      reason: 'unit_state_missing',
      unresolved: [{ slug: 'feature', state: 'UNKNOWN' }],
    });
  });
  it('fails closed when completion records were bounded or could not be read', async () => {
    expect(unitCompletion({ ...records(), truncated: true }, [1]).state).toBe('unknown');
    await expect(
      finalizeUnitCompletion({
        store: {
          getExecution: async () => ({ status: 'RUNNING', orchestratorRunId: 'r' }),
          getCompletionRecords: async () => {
            throw new Error('unavailable');
          },
        },
        executionId: 'e',
        runId: 'r',
        plan: { stages: [] },
      }),
    ).rejects.toThrow('unavailable');
  });
  it('counts missing lane rows as unfinished', () => {
    const input = records();
    input.units = [];
    expect(unitCompletion(input, [1])).toMatchObject({
      state: 'incomplete',
      total: 2,
      integrated: 0,
    });
  });
});

it('defaults only an absent decision and respects skeleton-off ceremonies', () => {
  expect(effectiveSkeleton({ ...unitPlan, walkingSkeleton: null })).toBe('foundation');
  expect(effectiveSkeleton(unitPlan)).toBe('feature');
  expect(skeletonProblem(unitPlan)).toContain('depends on foundation');
  expect(skeletonProblem(unitPlan, undefined, [{ policy: { skeleton: 'off' } }])).toBeNull();
  expect(skeletonProblem({ ...unitPlan, walkingSkeleton: 'foundation' })).toBeNull();
});
