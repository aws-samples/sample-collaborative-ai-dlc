import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';
import { runParallelSection } from '../section.js';

const tableName = `completion-section-${randomUUID()}`;
let db;
let store;
beforeAll(async () => {
  db = makeDdb();
  await createV2Table(db.client, tableName);
  store = createProcessStore({ ddb: db.doc, tableName });
});
afterAll(async () => {
  await deleteV2Table(db.client, tableName);
  db.client.destroy();
});
const setup = async (fault) => {
  const executionId = randomUUID();
  const runId = 'run';
  const units = [
    { slug: 'foundation', dependsOn: [] },
    { slug: 'dependent', dependsOn: ['foundation'] },
  ];
  await store.createExecution({
    executionId,
    intentId: executionId,
    projectId: 'project',
    repos: ['one', 'two'],
  });
  await store.updateExecution({ executionId, status: 'RUNNING', orchestratorRunId: runId });
  await store.putUnitPlan({
    executionId,
    units,
    batches: [['foundation'], ['dependent']],
    autonomyMode: 'autonomous',
  });
  await store.syncUnitRows({ executionId, units, sectionIndexes: [1] });
  if (fault === 'legacy')
    for (const { slug } of units)
      await store.updateUnitState({
        executionId,
        sectionIndex: 1,
        slug,
        state: 'MERGED',
        fields: { mergedAt: true },
      });
  if (fault === 'contradictory')
    await store.updateUnitState({
      executionId,
      sectionIndex: 1,
      slug: 'foundation',
      state: 'MERGED',
      fields: {
        integrationResults: [
          { repo: 'one', merged: true },
          { repo: 'two', merged: false },
        ],
      },
    });
  const events = [];
  const executeStage = vi.fn(async () => ({ state: 'SUCCEEDED' }));
  const invokeRuntime = vi.fn(async (payload) =>
    payload.command === 'merge-lane'
      ? {
          ok: true,
          results:
            fault === 'empty-results'
              ? []
              : [
                  { repo: 'one', merged: true },
                  { repo: 'two', merged: true },
                ],
        }
      : { ok: true },
  );
  const ctx = {
    logger: { error() {} },
    step: async (_name, fn) => fn(),
    runInChildContext: async (_name, fn) => fn(ctx),
    promise: { allSettled: async (_name, promises) => Promise.allSettled(promises) },
    createCallback: async (name) => {
      const humanTaskId = name.replace(/^await-/, '');
      await store.answerHumanTask({
        executionId,
        humanTaskId,
        status: 'answered',
        answer: 'abort',
        answeredBy: 'operator',
        ifOrchestratorRunId: runId,
      });
      return [Promise.resolve({ answer: 'abort' }), `cb-${name}`];
    },
  };
  const guarded = {
    ...store,
    updateUnitState: async (input) => {
      if (input.slug === 'foundation' && input.state === 'MERGED') {
        if (fault === 'write-failed') throw new Error('required integration write failed');
        if (fault === 'lost-response') {
          await store.updateUnitState(input);
          throw new Error('response lost');
        }
        if (fault === 'retired') {
          await store.updateExecution({ executionId, orchestratorRunId: 'successor' });
          return store.updateUnitState(input);
        }
      }
      return store.updateUnitState(input);
    },
  };
  const toolkit = {
    ctx,
    store: guarded,
    runId,
    completionPolicyVersion: 2,
    ids: { executionId, intentId: executionId, projectId: 'project' },
    intentBranch: 'intent',
    cloneBase: { repos: ['one', 'two'] },
    intentSessionId: 'session',
    maxParallelUnits: 2,
    invokeRuntime,
    executeStage,
    stopSession: async () => {},
    broadcast: async () => {},
    emitEvent: async (_ctx, _name, type, summary) => events.push({ type, summary }),
    fail: async (reason, detail) => ({ ok: false, reason, detail }),
    stageInstanceIdFor: (stage, slug) => `${stage}-${slug}`,
  };
  return {
    executionId,
    events,
    executeStage,
    invokeRuntime,
    run: () =>
      runParallelSection(
        { index: 1, stages: [{ stageId: 'build', policy: { skeleton: 'off' } }] },
        toolkit,
      ),
  };
};

it('does not release dependent work when the required MERGED write fails', async () => {
  const world = await setup('write-failed');
  expect(await world.run()).toMatchObject({ ok: false, reason: 'section_aborted' });
  expect(world.executeStage.mock.calls.map(([, , options]) => options.unitSlug)).toEqual([
    'foundation',
  ]);
  expect(world.invokeRuntime.mock.calls.filter(([p]) => p.command === 'merge-lane')).toHaveLength(
    1,
  );
  expect((await store.getUnit(world.executionId, 1, 'foundation')).state).toBe('FAILED');
  expect((await store.getUnit(world.executionId, 1, 'dependent')).state).toBe('BLOCKED');
  expect(world.events.some((event) => event.type === 'v2.units.fan_in')).toBe(false);
});
it('reconciles a lost integration response without rerunning stage or merge', async () => {
  const world = await setup('lost-response');
  expect(await world.run()).toBeNull();
  expect(world.executeStage).toHaveBeenCalledTimes(2);
  expect(world.invokeRuntime.mock.calls.filter(([p]) => p.command === 'merge-lane')).toHaveLength(
    2,
  );
  for (const row of await store.listUnits(world.executionId)) {
    expect(row).toMatchObject({
      state: 'MERGED',
      integrationResults: [
        { repo: 'one', merged: true },
        { repo: 'two', merged: true },
      ],
    });
  }
});
it('does not let contradictory persisted repository evidence unblock dependencies', async () => {
  const world = await setup('contradictory');
  expect(await world.run()).toMatchObject({ ok: false, reason: 'completion_unverified' });
  expect(world.executeStage).not.toHaveBeenCalled();
  expect(world.invokeRuntime).not.toHaveBeenCalled();
});
it('does not mark successor work failed when the integration owner is retired', async () => {
  const world = await setup('retired');
  expect(await world.run()).toMatchObject({ ok: false, reason: 'retired' });
  expect((await store.getExecution(world.executionId)).orchestratorRunId).toBe('successor');
  expect((await store.getUnit(world.executionId, 1, 'foundation')).state).toBe('MERGING');
  expect((await store.getUnit(world.executionId, 1, 'dependent')).state).toBe('PENDING');
});

it('persists explicit empty integration evidence instead of producing another legacy row', async () => {
  const world = await setup('empty-results');
  expect(await world.run()).toMatchObject({ ok: false });
  expect(await store.getUnit(world.executionId, 1, 'foundation')).toMatchObject({
    integrationResults: [],
  });
});

it('hydrates pre-deploy multi-repo MERGED rows from the real store without rebuilding units', async () => {
  const world = await setup('legacy');
  expect(await world.run()).toBeNull();
  expect(world.executeStage).not.toHaveBeenCalled();
  expect(world.invokeRuntime).not.toHaveBeenCalled();
  expect(
    (await store.listUnits(world.executionId)).every(
      (row) => row.state === 'MERGED' && !Object.hasOwn(row, 'integrationResults'),
    ),
  ).toBe(true);
});
