import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import {
  previewDelivery,
  publishFinalDelivery,
  deliveryView,
  currentDelivery,
} from '../../shared/final-delivery.js';
import { __durableHandler } from '../index.js';
import { finalizeUnitCompletion, unitPlanIdentity } from '../../shared/unit-completion.js';
import { inspectDelivery } from '../../shared/delivery-provider.js';

const tableName = `delivery-${randomUUID()}`;
let db, store, meta, remote, operation, timestamp, workflowPlan, prNumbers;
// The real provider-side selection over one remote PR per repository.
const remoteProvider = {
  id: 'github',
  getDefaultBranch: async () => 'develop',
  listPullRequests: async (_ctx, repo, { sourceBranch }) =>
    remote.get(repo)?.sourceBranch === sourceBranch ? [remote.get(repo)] : [],
  getBranchHead: async (_ctx, _repo, branch) => (branch === 'develop' ? 'base1' : 'head1'),
};
const loadPlan = async () => ({ valid: true, plan: workflowPlan });
// The accepted init-ws-start job completes the workspace-init callback.
const createCallback = async (name) => {
  if (name !== 'init-ws-cb') throw new Error(`unexpected callback ${name}`);
  return [Promise.resolve(JSON.stringify({ ok: true })), `cb-${name}`];
};
beforeAll(async () => {
  db = makeDdb();
  await createV2Table(db.client, tableName);
});
afterAll(async () => {
  await deleteV2Table(db.client, tableName);
  db.client.destroy();
});
beforeEach(async () => {
  workflowPlan = { stages: [] };
  timestamp = Date.now();
  store = createProcessStore({
    ddb: db.doc,
    tableName,
    clock: () => new Date(timestamp).toISOString(),
  });
  const executionId = randomUUID();
  await store.createExecution({
    executionId,
    intentId: executionId,
    projectId: 'project',
    repos: ['owner/api', 'owner/web'],
    branch: 'intent/feature',
    baseBranch: 'develop',
    methodologyPins: { STAGE: {} },
    source: { bindingId: 'tracker-binding', resourceId: '42', provider: 'github-issues' },
  });
  meta = await store.updateExecution({
    executionId,
    status: 'SUCCEEDED',
    orchestratorRunId: 'run1',
  });
  remote = new Map();
  prNumbers = 0;
  operation = vi.fn(async ({ repo, operation: name, args }) => {
    if (name === 'delivery-inspect') return inspectDelivery(remoteProvider, {}, repo, args);
    if (name === 'compare') return { status: 'ahead', base: args.base };
    if (name === 'create-pr') {
      const pr = {
        number: ++prNumbers,
        url: `https://example.test/${repo}/pull/${prNumbers}`,
        sourceBranch: args.branch,
        targetBranch: args.baseBranch,
        headSha: 'head1',
        state: 'open',
        body: args.body,
      };
      remote.set(repo, pr);
      return { prUrl: pr.url, prNumber: pr.number };
    }
    throw new Error(`unexpected operation ${name}`);
  });
});
const publish = (over = {}) =>
  publishFinalDelivery({
    store,
    meta,
    operation,
    loadPlan,
    applicationUrl: 'https://example.test',
    ...over,
  });
const row = () => store.getDelivery(meta.executionId, meta.orchestratorRunId);
const preview = async () =>
  previewDelivery({
    meta: await store.getExecution(meta.executionId, { consistentRead: true }),
    records: await store.getExecutionRecords(meta.executionId),
    plan: workflowPlan,
    operation,
  });
const createCalls = () =>
  operation.mock.calls.map(([call]) => call).filter((call) => call.operation === 'create-pr');
const retry = async () => {
  const p = await preview();
  const claimed = await store.claimDelivery({
    meta: await store.getExecution(meta.executionId, { consistentRead: true }),
    delivery: p.delivery,
    attemptId: randomUUID(),
  });
  return publish({ claimed });
};

const completeParallelWork = async ({ partial = false } = {}) => {
  workflowPlan = { stages: [{ stageId: 'code', parallelSection: 1 }] };
  const executionId = meta.executionId;
  await store.updateExecution({ executionId, status: 'RUNNING' });
  const units = [
    { slug: 'api', dependsOn: [] },
    { slug: 'web', dependsOn: ['api'] },
  ];
  await store.putUnitPlan({ executionId, units, batches: [['api'], ['web']] });
  await store.syncUnitRows({ executionId, units, sectionIndexes: [1] });
  const unitPlan = await store.getUnitPlan(executionId);
  for (const unit of units)
    await store.updateUnitState({
      executionId,
      sectionIndex: 1,
      slug: unit.slug,
      state: partial && unit.slug === 'web' ? 'BLOCKED' : 'MERGED',
      fields:
        partial && unit.slug === 'web'
          ? {
              completionSkip: { humanTaskId: 'approved', planIdentity: unitPlanIdentity(unitPlan) },
            }
          : { integrationResults: meta.repos.map((repo) => ({ repo, merged: true })) },
    });
  expect(
    await finalizeUnitCompletion({ store, executionId, runId: 'run1', plan: workflowPlan }),
  ).toMatchObject({ state: partial ? 'partial' : 'complete' });
  meta = await store.getExecution(executionId);
};

describe('final delivery with real DynamoDB ownership', () => {
  it.each(['start', 'retry-delivery'])(
    'publishes pre-deploy multi-repo MERGED rows through %s without rebuilding units',
    async (action) => {
      await completeParallelWork();
      await store.updateUnitPlanDecisions({
        executionId: meta.executionId,
        autonomyMode: 'autonomous',
      });
      const before = await store.listUnits(meta.executionId);
      for (const unit of before) {
        delete unit.integrationResults;
        await db.doc.send(new PutCommand({ TableName: tableName, Item: unit }));
      }
      let attemptId;
      if (action === 'retry-delivery') {
        const p = await preview();
        const claimed = await store.claimDelivery({
          meta,
          delivery: p.delivery,
          attemptId: 'legacy-retry',
        });
        attemptId = claimed.attemptId;
      } else {
        meta = await store.updateExecution({ executionId: meta.executionId, status: 'CREATED' });
      }
      const invokeRuntime = vi.fn(async () => ({ ok: true }));
      const result = await __durableHandler(
        {
          action,
          executionId: meta.executionId,
          intentId: meta.intentId,
          projectId: meta.projectId,
          runId: meta.orchestratorRunId,
          attemptId,
        },
        { step: (_name, fn) => fn(), createCallback },
        {
          store,
          loadPlan,
          publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
          invokeRuntime,
          broadcast: vi.fn(),
        },
      );
      expect(result).toMatchObject({ ok: true });
      meta = await store.getExecution(meta.executionId);
      expect(meta.status).toBe('SUCCEEDED');
      expect((await row()).status).toBe('succeeded');
      expect(createCalls()).toHaveLength(2);
      expect(
        invokeRuntime.mock.calls.some(
          ([p]) => p.unitSlug || p.command === 'run-stage-start' || p.command === 'merge-lane',
        ),
      ).toBe(false);
      expect(await store.listUnits(meta.executionId)).toEqual(before);
    },
  );

  it.each([
    ['initial', 'missing-section'],
    ['initial', 'read-failure'],
    ['initial', 'changed-plan'],
    ['retry', 'read-failure'],
    ['retry', 'changed-plan'],
  ])('withholds %s publication after %s completion evidence changes', async (path, reason) => {
    await completeParallelWork();
    let claimed;
    if (path === 'retry') {
      const p = await preview();
      claimed = await store.claimDelivery({ meta, delivery: p.delivery, attemptId: 'retry' });
    }
    operation.mockClear();
    let checkedStore = store;
    if (reason === 'read-failure')
      checkedStore = {
        ...store,
        getExecutionRecords: async () => {
          throw new Error('read unavailable');
        },
      };
    else if (reason === 'missing-section')
      workflowPlan = {
        stages: [...workflowPlan.stages, { stageId: 'verify', parallelSection: 2 }],
      };
    else
      await store.putUnitPlan({
        executionId: meta.executionId,
        units: [{ slug: 'replacement' }],
        batches: [['replacement']],
      });
    const before = await store.getExecution(meta.executionId);
    const invokeRuntime = vi.fn();
    if (claimed) {
      await __durableHandler(
        {
          action: 'retry-delivery',
          executionId: meta.executionId,
          intentId: meta.intentId,
          projectId: meta.projectId,
          runId: meta.orchestratorRunId,
          attemptId: claimed.attemptId,
        },
        { step: (_name, fn) => fn(), createCallback },
        {
          store: checkedStore,
          publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
          invokeRuntime,
          broadcast: vi.fn(),
        },
      );
      const saved = await row();
      expect(saved.status).toBe('failed');
      // A read failure is transient; a changed plan makes this run's retry futile.
      expect(saved.repositories.every((r) => r.retryable === (reason === 'read-failure'))).toBe(
        true,
      );
      expect((await store.getExecution(meta.executionId)).deliveryLeaseUntil).toBeUndefined();
    } else {
      await expect(publish({ store: checkedStore })).rejects.toThrow();
      expect(await row()).toBeNull();
    }
    expect(operation).not.toHaveBeenCalled();
    expect(invokeRuntime).not.toHaveBeenCalled();
    const after = await store.getExecution(meta.executionId);
    expect(after.completionValidation).toEqual(before.completionValidation);
    expect(after.status).toBe('SUCCEEDED');
  });

  it("publishes from the current run's completion receipt without re-assessing unit rows", async () => {
    await completeParallelWork();
    const getCompletionRecords = vi.fn(store.getCompletionRecords);
    // Unit rows are not delivery evidence once #534 committed the receipt; only
    // META (run, revision, receipt) and the unit plan it names are fenced.
    await store.updateUnitState({
      executionId: meta.executionId,
      sectionIndex: 1,
      slug: 'web',
      state: 'BLOCKED',
    });
    await publish({ store: { ...store, getCompletionRecords } });
    expect(getCompletionRecords).not.toHaveBeenCalled();
    expect(createCalls()).toHaveLength(2);
    expect((await row()).status).toBe('succeeded');
  });

  it.each([false, true])(
    'retries failed publication of verified work without rerunning stages (partial=%s)',
    async (partial) => {
      await completeParallelWork({ partial });
      const original = operation.getMockImplementation();
      operation.mockImplementation((call) =>
        call.operation === 'create-pr' ? Promise.reject(new Error('offline')) : original(call),
      );
      await publish();
      expect((await row()).status).toBe('failed');
      const before = await store.getCompletionRecords(meta.executionId);
      operation.mockImplementation(original);
      await retry();
      expect((await row()).status).toBe('succeeded');
      const after = await store.getCompletionRecords(meta.executionId);
      expect(after.units).toEqual(before.units);
      expect(after.meta.completionValidation).toEqual(before.meta.completionValidation);
      expect(after.meta.completionValidation.state).toBe(partial ? 'partial' : 'complete');
    },
  );

  it('withholds a provider mutation when the unit plan changes during provider inspection', async () => {
    await completeParallelWork();
    const original = operation.getMockImplementation();
    operation.mockImplementation(async (call) => {
      if (call.operation === 'compare' && call.repo === 'owner/api')
        await store.putUnitPlan({
          executionId: meta.executionId,
          units: [{ slug: 'replacement' }],
          batches: [['replacement']],
        });
      return original(call);
    });
    const results = await publish();
    expect(createCalls()).toHaveLength(0);
    const saved = await row();
    expect(saved.status).toBe('failed');
    for (const repo of saved.repositories) {
      expect(repo).toMatchObject({ status: 'failed', retryable: false });
      expect(repo.reason).toContain('unit plan changed before the pull request was created');
      expect(repo.reason).not.toMatch(/Transaction|Conditional|cancel/i);
      expect(repo.createRequestedAt).toBeUndefined();
    }
    expect(results).toEqual([
      expect.objectContaining({
        eventType: 'v2.pr.failed',
        summary: expect.stringContaining('Final publication withheld'),
      }),
    ]);
    expect((await store.getExecution(meta.executionId)).deliveryLeaseUntil).toBeUndefined();
    // The check that follows refuses too, so no retry was offered for nothing.
    await expect(preview()).rejects.toMatchObject({ code: 'delivery_completion_changed' });
  });

  it('keeps an unreadable pre-create save retryable with a readable reason', async () => {
    let failFence = true;
    const flakyStore = {
      ...store,
      saveDelivery: async (input) => {
        if (input.ifUnitPlan !== undefined && failFence) {
          failFence = false;
          throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
        }
        return store.saveDelivery(input);
      },
    };
    await publish({ store: flakyStore });
    expect(createCalls().map((c) => c.repo)).toEqual(['owner/web']);
    const [api, web] = (await row()).repositories;
    expect(api).toMatchObject({ status: 'failed', retryable: true });
    expect(api.reason).toContain('delivery record could not be saved');
    expect(api.reason).not.toContain('socket hang up');
    expect(api.createRequestedAt).toBeUndefined();
    expect(web).toMatchObject({ status: 'succeeded', createRequestedAt: expect.any(String) });
  });

  it('does not assess an unpinned legacy workflow with unit work as verified', async () => {
    const legacy = { ...meta };
    delete legacy.methodologyPins;
    const records = await store.getExecutionRecords(meta.executionId);
    records.unitPlan = { units: [{ slug: 'api' }] };
    records.units = [{ slug: 'api', sectionIndex: 1, state: 'MERGED' }];
    await expect(
      previewDelivery({
        meta: legacy,
        records,
        plan: { stages: [{ stageId: 'code', parallelSection: 1 }] },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'delivery_unverified' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('accepts an unpinned legacy serial run whose serial stages all finished', async () => {
    const legacy = await store.updateExecution({
      executionId: meta.executionId,
      methodologyPins: null,
    });
    const plan = { stages: [{ stageId: 'requirements' }, { stageId: 'build' }] };
    const records = await store.getExecutionRecords(meta.executionId);
    records.stages = [
      { stageId: 'requirements', state: 'SUCCEEDED' },
      { stageId: 'build', state: 'SKIPPED' },
    ];
    const p = await previewDelivery({ meta: legacy, records, plan, operation });
    expect(p).toMatchObject({ historical: true, retryable: true });
    expect(p.delivery.repositories.map((r) => r.status)).toEqual(['pending', 'pending']);
    records.stages[1].state = 'FAILED';
    await expect(previewDelivery({ meta: legacy, records, plan, operation })).rejects.toMatchObject(
      { code: 'delivery_stage_incomplete' },
    );
    await expect(
      previewDelivery({
        meta: legacy,
        records,
        plan: { stages: [...plan.stages, { stageId: 'code', parallelSection: 1 }] },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'delivery_missing_plan' });
  });

  it('fences delivery plan changes and keeps lease exclusion on completion/recovery transactions', async () => {
    await completeParallelWork();
    const records = await store.getCompletionRecords(meta.executionId);
    const p = await preview();
    const claimed = await store.claimDelivery({
      meta,
      delivery: p.delivery,
      attemptId: 'delivery',
      ifUnitPlan: records.unitPlan,
    });
    await expect(
      store.updateExecution({
        executionId: meta.executionId,
        status: 'RUNNING',
        orchestratorRunId: 'recovery',
        ifOrchestratorRunId: meta.orchestratorRunId,
        ifUpdatedAt: meta.updatedAt,
        ifUnitPlan: records.unitPlan,
        completionValidation: null,
      }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect((await store.getExecution(meta.executionId)).completionValidation).toEqual(
      meta.completionValidation,
    );
    await store.putUnitPlan({
      executionId: meta.executionId,
      units: [{ slug: 'new' }],
      batches: [['new']],
    });
    await expect(
      store.saveDelivery({ delivery: claimed, ifUnitPlan: records.unitPlan }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    await store.saveDelivery({ delivery: { ...claimed, status: 'failed' }, finished: true });
    await expect(
      store.claimDelivery({
        meta: await store.getExecution(meta.executionId),
        delivery: await row(),
        attemptId: 'stale-preview',
        ifUnitPlan: records.unitPlan,
      }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('preserves the no-repository event and does not treat missing repository metadata as no change', async () => {
    const unknownMeta = { ...meta };
    delete unknownMeta.repos;
    await expect(
      previewDelivery({
        meta: unknownMeta,
        records: await store.getExecutionRecords(meta.executionId),
        plan: { stages: [] },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'delivery_repositories_unknown' });
    meta = { ...meta, repos: [] };
    await db.doc.send(new PutCommand({ TableName: tableName, Item: meta }));
    expect(await publish()).toEqual([
      { eventType: 'v2.pr.skipped', summary: 'No repositories on this intent — no PR to open' },
    ]);
    expect((await row()).status).toBe('no_change');
    expect(operation).not.toHaveBeenCalled();
  });
  it('keeps preview tokens stable when stored object attributes are reordered', async () => {
    const records = await store.getExecutionRecords(meta.executionId);
    const args = { meta, records, plan: { stages: [] }, operation };
    const first = await previewDelivery(args);
    const reordered = Object.fromEntries(Object.entries(meta).reverse());
    expect((await previewDelivery({ ...args, meta: reordered })).previewToken).toBe(
      first.previewToken,
    );
  });
  it('publishes each repository once and leaves stage success independent', async () => {
    await publish();
    await publish();
    expect(createCalls()).toHaveLength(2);
    expect(createCalls()[0].args).toMatchObject({
      expectedHeadSha: 'head1',
      baseBranch: 'develop',
      allowRetarget: false,
      attemptKey: `${meta.executionId}:run1`,
    });
    expect((await row()).status).toBe('succeeded');
    expect((await store.getExecution(meta.executionId)).status).toBe('SUCCEEDED');
    expect(currentDelivery(await store.getExecutionRecords(meta.executionId)).status).toBe(
      'succeeded',
    );
  });
  it('preserves success in a partial delivery and retries only the failed repository', async () => {
    const original = operation.getMockImplementation();
    let reject = true;
    operation.mockImplementation((call) =>
      call.operation === 'create-pr' && call.repo === 'owner/web' && reject
        ? Promise.reject(new Error('private provider detail'))
        : original(call),
    );
    await publish();
    expect((await row()).status).toBe('partial');
    expect(JSON.stringify(await row())).not.toContain('private provider detail');
    reject = false;
    await retry();
    expect(createCalls().map((c) => c.repo)).toEqual(['owner/api', 'owner/web', 'owner/web']);
    expect((await row()).status).toBe('succeeded');
  });
  it('reconciles provider success with a lost response without creating again', async () => {
    const original = operation.getMockImplementation();
    let lost = true;
    operation.mockImplementation(async (call) => {
      const result = await original(call);
      if (call.operation === 'create-pr' && lost) {
        lost = false;
        throw new Error('socket closed');
      }
      return result;
    });
    await publish();
    expect((await row()).status).toBe('partial');
    await retry();
    expect((await row()).status).toBe('succeeded');
    expect(createCalls()).toHaveLength(2);
  });
  it.each(['closed', 'merged'])(
    'refuses to recreate a previously %s PR after a lost response',
    async (state) => {
      const original = operation.getMockImplementation();
      operation.mockImplementation(async (call) => {
        const result = await original(call);
        if (call.operation === 'create-pr') throw new Error('timeout after the provider accepted');
        return result;
      });
      await publish();
      remote.get('owner/api').state = state; // a reviewer rejected or merged it
      const p = await preview();
      expect(p.delivery.repositories[0]).toMatchObject({ status: 'failed', retryable: false });
      expect(p.delivery.repositories[0].reason).toContain(state);
      await retry();
      expect(createCalls().filter((c) => c.repo === 'owner/api')).toHaveLength(1);
    },
  );
  it.each(['closed', 'merged'])(
    "publishes a new PR in a new run after the previous run's PR was %s",
    async (state) => {
      await publish();
      const previous = [...remote.values()].map((pr) => pr.url);
      for (const pr of remote.values()) pr.state = state;
      // Rewind or relaunch keeps the intent branch and mints a new run.
      meta = await store.updateExecution({
        executionId: meta.executionId,
        orchestratorRunId: 'run2',
      });
      const records = await store.getExecutionRecords(meta.executionId);
      expect(deliveryView(meta, currentDelivery(records))).toMatchObject({
        status: 'unknown',
        repositories: [],
      });
      const p = await preview();
      expect(p.delivery.repositories).toEqual([
        expect.objectContaining({ status: 'pending', retryable: true }),
        expect.objectContaining({ status: 'pending', retryable: true }),
      ]);
      expect(p.delivery.repositories.some((r) => r.pr)).toBe(false);
      await publish();
      const run2 = createCalls().slice(2);
      expect(run2.map((c) => c.args.attemptKey)).toEqual([
        `${meta.executionId}:run2`,
        `${meta.executionId}:run2`,
      ]);
      const view = deliveryView(meta, await row());
      expect(view.status).toBe('succeeded');
      expect(view.repositories.map((r) => r.pr.prUrl)).toEqual(
        [...remote.values()].map((pr) => pr.url),
      );
      expect(view.repositories.some((r) => previous.includes(r.pr.prUrl))).toBe(false);
    },
  );
  it.each(['missing', 'changed'])('refuses %s head branches on retry', async (kind) => {
    const original = operation.getMockImplementation();
    operation.mockImplementation((call) =>
      call.operation === 'create-pr' ? Promise.reject(new Error('denied')) : original(call),
    );
    await publish();
    operation.mockImplementation((call) =>
      call.operation === 'delivery-inspect'
        ? {
            headSha: kind === 'missing' ? null : 'new-head',
            baseSha: 'base1',
            baseBranch: 'develop',
          }
        : original(call),
    );
    await retry();
    expect(createCalls()).toHaveLength(2);
    expect((await row()).repositories.every((r) => r.retryable === false)).toBe(true);
  });
  it('records ordinary no-diff as no change but never masks a failed timeline read', async () => {
    const original = operation.getMockImplementation();
    operation.mockImplementation((call) =>
      call.operation === 'compare' ? { status: 'identical', base: 'develop' } : original(call),
    );
    await publish();
    expect((await row()).status).toBe('no_change');
    expect(createCalls()).toHaveLength(0);
    // Different run; the old no-change record remains historical.
    meta = await store.updateExecution({
      executionId: meta.executionId,
      orchestratorRunId: 'run2',
    });
    const badStore = {
      ...store,
      getExecutionRecords: async () => {
        throw new Error('unreadable');
      },
    };
    await expect(publish({ store: badStore })).rejects.toThrow('unreadable');
    // Evidence is read before the claim: nothing is leased for an unreadable run.
    expect(await row()).toBeNull();
    expect((await store.getExecution(meta.executionId)).deliveryLeaseUntil).toBeUndefined();
    expect(createCalls()).toHaveLength(0);
  });
  it('refuses no-diff after engine push failure and failed strict provider reads', async () => {
    await store.appendEvent({
      executionId: meta.executionId,
      type: 'v2.git.push_failed',
      summary: 'owner/api failed push',
    });
    const original = operation.getMockImplementation();
    operation.mockImplementation((call) =>
      call.operation === 'compare' ? { status: 'identical' } : original(call),
    );
    await publish();
    expect((await row()).repositories[0].status).toBe('failed');
    operation.mockImplementation(() => {
      throw new Error('provider read denied');
    });
    await retry();
    expect(createCalls()).toHaveLength(0);
    expect((await row()).repositories[0].status).toBe('failed');
  });
  it('admits one concurrent retry and fences a competing rewind/new run', async () => {
    const p = await preview();
    const claims = await Promise.allSettled(
      ['first', 'second'].map((attemptId) =>
        store.claimDelivery({ meta, delivery: p.delivery, attemptId }),
      ),
    );
    expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(
      store.updateExecution({
        executionId: meta.executionId,
        status: 'FAILED',
        orchestratorRunId: 'rewind',
      }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    const claimed = claims.find((r) => r.status === 'fulfilled').value;
    await publish({ claimed });
    expect(createCalls()).toHaveLength(2);
    await expect(store.saveDelivery({ delivery: claimed })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
  });
  it('recovers an abandoned attempt and rejects its late write and provider call', async () => {
    const first = await store.claimDelivery({
      meta,
      delivery: { repositories: [] },
      attemptId: 'abandoned',
    });
    timestamp += 21 * 60_000;
    const second = await store.claimDelivery({
      meta,
      delivery: await row(),
      attemptId: 'replacement',
    });
    await expect(store.saveDelivery({ delivery: first })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    expect(await publish({ claimed: first })).toEqual([]);
    expect(createCalls()).toHaveLength(0);
    await store.saveDelivery({ delivery: { ...second, status: 'no_change' }, finished: true });
  });
  it('rejects a retry preview when a new run already owns the execution', async () => {
    const p = await preview();
    await store.updateExecution({
      executionId: meta.executionId,
      status: 'RUNNING',
      orchestratorRunId: 'replacement',
    });
    await expect(
      store.claimDelivery({ meta, delivery: p.delivery, attemptId: 'stale' }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await publish()).toEqual([]);
    expect(createCalls()).toHaveLength(0);
  });
  it.each(['CANCELLED', 'FAILED'])(
    'does not publish or offer retry for an aborted %s execution',
    async (status) => {
      meta = await store.updateExecution({
        executionId: meta.executionId,
        status,
        methodologyPins: null,
        failure:
          status === 'FAILED'
            ? { code: 'section_aborted', message: 'Execution aborted by its owner.' }
            : null,
      });
      await expect(preview()).rejects.toMatchObject({ code: 'delivery_not_complete' });
      expect(await publish()).toEqual([]);
      expect(operation).not.toHaveBeenCalled();
      expect(await row()).toBeNull();
    },
  );
  it('old terminal records remain unknown until read-only assessment; missing sections block it', async () => {
    expect(deliveryView(meta, await row()).status).toBe('unknown');
    expect((await preview()).historical).toBe(true);
    expect(await row()).toBeNull();
    expect(createCalls()).toHaveLength(0);
    const records = await store.getExecutionRecords(meta.executionId);
    await expect(
      previewDelivery({
        meta,
        records,
        plan: { stages: [{ stageId: 'build', parallelSection: 1 }] },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'delivery_missing_plan' });
    records.unitPlan = { units: [{ slug: 'api' }] };
    await expect(
      previewDelivery({
        meta,
        records,
        plan: { stages: [{ stageId: 'build', parallelSection: 1 }] },
        operation,
      }),
    ).rejects.toMatchObject({ code: 'delivery_incomplete' });
  });
  it('honors plan-bound partial approvals but never a pending gate or a skip for another section', async () => {
    const records = await store.getExecutionRecords(meta.executionId);
    records.unitPlan = {
      units: [{ slug: 'api' }, { slug: 'web' }],
      promotedAt: '2026-10-01T00:00:00.000Z',
    };
    records.units = [
      {
        slug: 'api',
        sectionIndex: 1,
        state: 'MERGED',
        integrationResults: meta.repos.map((repo) => ({ repo, merged: true })),
      },
      {
        slug: 'web',
        sectionIndex: 1,
        state: 'SKIPPED',
        completionSkip: { humanTaskId: 'skip', planIdentity: unitPlanIdentity(records.unitPlan) },
      },
    ];
    const args = {
      meta,
      records,
      plan: { stages: [{ stageId: 'code', parallelSection: 1 }] },
      operation,
    };
    expect((await previewDelivery(args)).historical).toBe(true);
    records.humanTasks = [{ status: 'pending', orchestratorRunId: meta.orchestratorRunId }];
    await expect(previewDelivery(args)).rejects.toMatchObject({ code: 'delivery_gate_pending' });
    delete records.units[1].completionSkip;
    records.humanTasks = [
      {
        humanTaskId: 'eg-halt-s2-r0',
        status: 'answered',
        orchestratorRunId: meta.orchestratorRunId,
        answer: { decision: 'skip' },
        createdAt: '2026-10-02T00:00:00.000Z',
        prompt: 'Lane failure in section 2\n- web: failed',
      },
    ];
    await expect(previewDelivery(args)).rejects.toMatchObject({ code: 'delivery_incomplete' });
    records.humanTasks[0].humanTaskId = 'eg-halt-s1-r0';
    records.humanTasks[0].prompt = 'Lane failure in section 1\n- web: failed';
    expect((await previewDelivery(args)).historical).toBe(true);
  });
  it('retry dispatch runs publication only, without models, stages or Git integration', async () => {
    const p = await preview();
    const claimed = await store.claimDelivery({ meta, delivery: p.delivery, attemptId: 'retry' });
    const invokeRuntime = vi.fn();
    const result = await __durableHandler(
      {
        action: 'retry-delivery',
        executionId: meta.executionId,
        intentId: meta.intentId,
        projectId: meta.projectId,
        runId: meta.orchestratorRunId,
        attemptId: claimed.attemptId,
      },
      { step: (_name, fn) => fn(), createCallback },
      {
        store,
        publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
        invokeRuntime,
        broadcast: vi.fn(),
      },
    );
    expect(result.ok).toBe(true);
    expect(invokeRuntime).not.toHaveBeenCalled();
    expect((await store.getTrackerSync(meta.executionId)).pullRequests).toHaveLength(2);
    expect((await row()).status).toBe('succeeded');
  });
  it.each(['start', 'retry-delivery'])(
    'records a tracker handoff deferred by partial publication through %s',
    async (action) => {
      const original = operation.getMockImplementation();
      operation.mockImplementation((call) =>
        call.operation === 'create-pr' && call.repo === 'owner/web'
          ? { conflict: true }
          : original(call),
      );
      let attemptId;
      if (action === 'retry-delivery') {
        const p = await preview();
        attemptId = (await store.claimDelivery({ meta, delivery: p.delivery, attemptId: 'retry' }))
          .attemptId;
      } else
        meta = await store.updateExecution({ executionId: meta.executionId, status: 'CREATED' });
      await __durableHandler(
        {
          action,
          executionId: meta.executionId,
          intentId: meta.intentId,
          projectId: meta.projectId,
          runId: meta.orchestratorRunId,
          attemptId,
        },
        { step: (_name, fn) => fn(), createCallback },
        {
          store,
          loadPlan,
          publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
          invokeRuntime: vi.fn(async () => ({ ok: true })),
          broadcast: vi.fn(),
        },
      );
      meta = await store.getExecution(meta.executionId);
      expect((await row()).status).toBe('partial');
      expect(await store.getTrackerSync(meta.executionId)).toBeNull();
      const deferred = (await store.listEvents(meta.executionId)).filter(
        (e) => e.eventType === 'v2.tracker.blocked',
      );
      expect(deferred).toHaveLength(1);
      expect(deferred[0].summary).toContain('1 of 2 published');
    },
  );

  it.each(['unavailable', 'replaced-plan'])(
    'withholds initial publication at the actual start entrypoint when evidence becomes %s',
    async (fault) => {
      meta = await store.updateExecution({ executionId: meta.executionId, status: 'CREATED' });
      let publishing = false;
      let capturedMeta;
      const guardedStore = {
        ...store,
        getExecutionRecords: async (...args) => {
          if (publishing && fault === 'unavailable')
            throw new Error('completion store unavailable');
          return store.getExecutionRecords(...args);
        },
      };
      const invokeRuntime = vi.fn(async () => ({ ok: true }));
      const result = await __durableHandler(
        { action: 'start', executionId: meta.executionId, intentId: meta.intentId },
        {
          createCallback,
          step: async (name, fn) => {
            if (name === 'open-pr') {
              publishing = true;
              if (fault === 'replaced-plan')
                await store.putUnitPlan({
                  executionId: meta.executionId,
                  units: [{ slug: 'replacement' }],
                  batches: [['replacement']],
                });
            }
            const value = await fn();
            publishing = false;
            if (name === 'load-meta') capturedMeta = value;
            return value;
          },
        },
        {
          store: guardedStore,
          loadPlan,
          publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
          invokeRuntime,
          broadcast: vi.fn(),
        },
      );
      expect(result.ok).toBe(true); // Execution completed; publication was withheld separately.
      expect(capturedMeta).toMatchObject({ completionPolicyVersion: 1, deliveryPolicyVersion: 1 });
      expect(capturedMeta.recoveryRuntime).toBeUndefined();
      meta = await store.getExecution(meta.executionId);
      expect(meta.status).toBe('SUCCEEDED');
      expect(operation).not.toHaveBeenCalled();
      expect(await row()).toBeNull();
      expect(
        (await store.listEvents(meta.executionId)).some((e) => e.eventType === 'v2.pr.failed'),
      ).toBe(true);
      expect(
        invokeRuntime.mock.calls.some(([payload]) => payload.command === 'run-stage-start'),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'persists publication when graph projection fails (captured runtime=%s)',
    async (capturedRuntime) => {
      meta = await store.updateExecution({ executionId: meta.executionId, status: 'CREATED' });
      const runtimeTarget = {
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/captured',
        qualifier: 'original',
        capacityProviderArn: null,
      };
      if (capturedRuntime) {
        meta.environment = {
          runtimeArn: runtimeTarget.agentRuntimeArn,
          runtimeEndpoint: runtimeTarget.qualifier,
        };
        await db.doc.send(new PutCommand({ TableName: tableName, Item: meta }));
      }
      const commands = [];
      const invokeRuntime = vi.fn(async (payload, _session, target) => {
        if (capturedRuntime) expect(target).toEqual(runtimeTarget);
        commands.push(payload.command);
        return payload.command === 'record-pr' ? { ok: false } : { ok: true };
      });
      const result = await __durableHandler(
        {
          action: 'start',
          executionId: meta.executionId,
          intentId: meta.intentId,
        },
        { step: (_name, fn) => fn(), createCallback },
        {
          store,
          loadPlan: async () => ({ valid: true, plan: { stages: [] } }),
          publishDelivery: (args) => publishFinalDelivery({ ...args, operation, loadPlan }),
          invokeRuntime,
          broadcast: vi.fn(),
        },
      );
      expect(result.ok).toBe(true);
      meta = await store.getExecution(meta.executionId);
      expect(meta.status).toBe('SUCCEEDED');
      expect(meta.completionValidation.version).toBe(1);
      expect((await row()).status).toBe('succeeded');
      expect(commands).toContain('record-pr');
      expect(deliveryView(meta, await row()).repositories[0].pr.prUrl).toBeTruthy();
    },
  );
});
