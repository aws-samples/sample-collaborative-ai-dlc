import { describe, expect, it, vi } from 'vitest';
import { auditCompletion } from '../completion-audit.js';
import { assessExecutionCompletion } from '../unit-completion.js';

const scope = {
  projectId: 'project',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
};
const records = () => ({
  meta: {
    executionId: 'intent',
    projectId: 'project',
    status: 'SUCCEEDED',
    startedAt: scope.from,
    updatedAt: scope.from,
    orchestratorRunId: 'run',
    methodologyPins: { STAGE: { build: { tenantId: 'SYSTEM', version: 1 } } },
  },
  unitPlan: { units: [{ slug: 'foundation' }, { slug: 'feature' }] },
  units: [
    { sectionIndex: 1, slug: 'foundation', state: 'MERGED' },
    { sectionIndex: 1, slug: 'feature', state: 'BLOCKED' },
    { sectionIndex: 1, slug: 'historic', state: 'PENDING' },
  ],
});
const loadPlan = async () => ({
  valid: true,
  plan: { stages: [{ parallelSection: 1 }] },
});
const setup = () => {
  const data = records();
  const store = {
    listCompletionAuditPage: vi.fn(async () => ({
      items: [data.meta],
      cursor: null,
    })),
    getCompletionRecords: vi.fn(async () => data),
    getExecution: vi.fn(async () => data.meta),
    getUnitPlan: vi.fn(async () => data.unitPlan),
  };
  return { store, data };
};

describe('bounded completion diagnostics', () => {
  it('reports incident-shaped false success without changing any row', async () => {
    const { store, data } = setup();
    const before = structuredClone(data);
    const result = await auditCompletion({ store, loadPlan, scope });
    expect(result.summary.metrics).toMatchObject({
      examined: 1,
      incomplete: 1,
      complete: 0,
    });
    expect(result.findings[0]).toMatchObject({
      intentId: 'intent',
      runId: 'run',
      state: 'incomplete',
      total: 2,
      integrated: 1,
      unresolved: [{ slug: 'feature', reason: 'unit_unfinished' }],
    });
    expect(data).toEqual(before);
  });
  it('audits an unpinned serial success without inventing a unit failure', async () => {
    const { store, data } = setup();
    delete data.meta.methodologyPins;
    delete data.unitPlan;
    data.units = [];
    const before = structuredClone(data);
    const result = await auditCompletion({ store, loadPlan, scope });
    expect(result.findings[0]).toMatchObject({ state: 'complete', total: 0, unresolved: [] });
    expect(result.summary.metrics).toMatchObject({ examined: 1, complete: 1, unknown: 0 });
    expect(data).toEqual(before);
  });
  it.each(['CANCELLED', 'FAILED'])(
    'counts an unpinned %s abort without treating it as completion or an unknown finding',
    async (status) => {
      const { store, data } = setup();
      data.meta.status = status;
      delete data.meta.methodologyPins;
      if (status === 'FAILED') {
        data.meta.failure = { code: 'section_aborted' };
        data.humanTasks = [{ orchestratorRunId: 'run', status: 'answered', answer: 'abort' }];
      }
      const before = structuredClone(data);
      const load = vi.fn(async () => {
        throw new Error('no pin');
      });
      const result = await auditCompletion({ store, loadPlan: load, scope: { ...scope, status } });
      expect(result.findings[0]).toMatchObject({
        state: 'aborted',
        reason: 'execution_aborted',
        integrated: 1,
        total: 2,
      });
      expect(result.summary).toMatchObject({
        finished: true,
        metrics: { examined: 1, aborted: 1, unknown: 0, complete: 0, incomplete: 0 },
      });
      expect(load).not.toHaveBeenCalled();
      expect(data).toEqual(before);
    },
  );
  it.each(['projectId', 'from', 'to'])('requires explicit %s scope', async (field) => {
    const { store } = setup();
    await expect(
      auditCompletion({
        store,
        loadPlan,
        scope: { ...scope, [field]: undefined },
      }),
    ).rejects.toThrow('Explicit');
    expect(store.listCompletionAuditPage).not.toHaveBeenCalled();
  });
  it('refuses a checkpoint from another project or time interval', async () => {
    const { store } = setup();
    await expect(
      auditCompletion({
        store,
        loadPlan,
        scope,
        checkpoint: { version: 1, scope: { ...scope, projectId: 'other' } },
      }),
    ).rejects.toThrow('scope differs');
  });
  it('labels record and pinned plan failures unknown', async () => {
    const { store } = setup();
    store.getCompletionRecords.mockRejectedValueOnce(new Error('read failed'));
    expect((await auditCompletion({ store, loadPlan, scope })).findings[0]).toMatchObject({
      state: 'unknown',
      reason: 'completion_read_failed',
    });
    expect(
      await assessExecutionCompletion({
        records: records(),
        loadPlan: async () => {
          throw new Error('pin unavailable');
        },
      }),
    ).toMatchObject({ state: 'unknown', reason: 'pinned_plan_read_failed' });
  });
  it('does not infer a historical section list from mutable legacy stage definitions', async () => {
    const data = records();
    delete data.meta.methodologyPins;
    const load = vi.fn(loadPlan);
    expect(await assessExecutionCompletion({ records: data, loadPlan: load })).toMatchObject({
      state: 'unknown',
      reason: 'legacy_workflow_unpinned',
    });
    expect(load).not.toHaveBeenCalled();
  });
  it('labels concurrent recovery and GSI lag unknown', async () => {
    const { store, data } = setup();
    store.getExecution.mockResolvedValue({
      ...data.meta,
      orchestratorRunId: 'new-run',
    });
    expect((await auditCompletion({ store, loadPlan, scope })).findings[0]).toMatchObject({
      state: 'unknown',
      reason: 'execution_changed_during_audit',
    });
    data.meta.status = 'RUNNING';
    expect((await auditCompletion({ store, loadPlan, scope })).findings[0]).toMatchObject({
      state: 'unknown',
      reason: 'execution_scope_changed',
    });
  });
  it('keeps ambiguous legacy omissions unverified and explicit aborts distinct', async () => {
    const data = records();
    data.humanTasks = [
      {
        humanTaskId: 'eg-halt-s1-r0-run',
        orchestratorRunId: 'run',
        status: 'answered',
        answer: 'skip',
      },
    ];
    expect((await assessExecutionCompletion({ records: data, loadPlan })).state).toBe('unknown');
    data.meta.status = 'FAILED';
    data.meta.failure = { code: 'section_aborted' };
    data.humanTasks[0].answer = 'abort';
    expect(await assessExecutionCompletion({ records: data, loadPlan })).toMatchObject({
      state: 'aborted',
      integrated: 1,
      total: 2,
    });
  });
  it('bounds empty discovery pages and preserves the resume position', async () => {
    const { store } = setup();
    store.listCompletionAuditPage.mockResolvedValue({
      items: [],
      cursor: { key: 'next' },
    });
    const result = await auditCompletion({
      store,
      loadPlan,
      scope: { ...scope, maxPages: 2 },
    });
    expect(store.listCompletionAuditPage).toHaveBeenCalledTimes(2);
    expect(result.summary).toMatchObject({ finished: false, pages: 2 });
    expect(result.checkpoint.cursor).toEqual({ key: 'next' });
  });
});
