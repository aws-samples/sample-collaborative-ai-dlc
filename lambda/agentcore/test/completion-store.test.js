import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { finalizeUnitCompletion, unitPlanIdentity } from '../../shared/unit-completion.js';
import { createV2Table, deleteV2Table, makeDdb } from './helpers/v2-table.js';

const tableName = `completion-${randomUUID()}`;
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
const plan = { stages: [{ stageId: 'build', parallelSection: 1 }] };
const setup = async ({
  state = 'MERGED',
  projectId = randomUUID(),
  repos = [],
  prStrategy = 'intent-pr',
} = {}) => {
  const executionId = randomUUID();
  await store.createExecution({
    executionId,
    intentId: executionId,
    projectId,
    startedAt: '2026-10-01T00:00:00.000Z',
    workflowId: 'workflow',
    workflowVersion: 1,
    repos,
    prStrategy,
    methodologyPins: { STAGE: { build: { tenantId: 'SYSTEM', version: 1 } } },
  });
  await store.updateExecution({ executionId, status: 'RUNNING', orchestratorRunId: 'run' });
  await store.putUnitPlan({ executionId, units: [{ slug: 'a', dependsOn: [] }], batches: [['a']] });
  await store.syncUnitRows({
    executionId,
    units: [{ slug: 'a', dependsOn: [] }],
    sectionIndexes: [1],
  });
  await store.updateUnitState({ executionId, sectionIndex: 1, slug: 'a', state });
  return executionId;
};

it('commits success and returns the same decision when a durable response is lost', async () => {
  const executionId = await setup();
  const args = { store, executionId, runId: 'run', plan };
  const result = await finalizeUnitCompletion(args);
  expect(result).toMatchObject({ state: 'complete', integrated: 1 });
  const first = await store.getExecution(executionId);
  expect(first.status).toBe('SUCCEEDED');
  expect(await finalizeUnitCompletion(args)).toEqual(result);
  expect((await store.getExecution(executionId)).updatedAt).toBe(first.updatedAt);
});

it('checks the persisted unitSlug repository rows before accepting an integrated unit', async () => {
  const executionId = await setup({ repos: ['one', 'two'], prStrategy: 'pr-per-unit' });
  for (const repository of ['one', 'two']) {
    await store.createUnitPr({
      executionId,
      sectionIndex: 1,
      slug: 'a',
      repository,
      provider: 'github',
      sourceBranch: 'unit',
      targetBranch: 'intent',
      state: repository === 'one' ? 'MERGED' : 'PARTIALLY_MERGED',
    });
  }
  expect(await finalizeUnitCompletion({ store, executionId, runId: 'run', plan })).toMatchObject({
    state: 'incomplete',
    integrated: 0,
    unresolvedCount: 1,
  });
  expect((await store.getUnit(executionId, 1, 'a')).state).toBe('MERGED');
});

it('permits serial execution without inventing a unit plan', async () => {
  const executionId = randomUUID();
  await store.createExecution({ executionId, intentId: executionId, projectId: 'serial' });
  await store.updateExecution({ executionId, status: 'RUNNING', orchestratorRunId: 'run' });
  expect(
    await finalizeUnitCompletion({ store, executionId, runId: 'run', plan: { stages: [] } }),
  ).toMatchObject({ state: 'complete', total: 0 });
  expect(await store.getUnitPlan(executionId)).toBeNull();
});

it('preserves rows and records an actionable failure instead of false success', async () => {
  const executionId = await setup({ state: 'BLOCKED' });
  const before = await store.getUnit(executionId, 1, 'a');
  expect(await finalizeUnitCompletion({ store, executionId, runId: 'run', plan })).toMatchObject({
    state: 'incomplete',
    unresolvedCount: 1,
  });
  expect(await store.getExecution(executionId)).toMatchObject({
    status: 'FAILED',
    failure: { code: 'completion_inconsistent' },
  });
  expect(await store.getUnit(executionId, 1, 'a')).toEqual(before);
});

it.each(['run', 'plan', 'meta'])(
  'rejects a concurrent %s change between read and terminal write',
  async (change) => {
    const executionId = await setup();
    let raced = false;
    const racing = createProcessStore({
      tableName,
      ddb: {
        send: async (command) => {
          if (command instanceof TransactWriteCommand && !raced) {
            raced = true;
            if (change === 'plan')
              await store.putUnitPlan({
                executionId,
                units: [{ slug: 'replacement', dependsOn: [] }],
                batches: [['replacement']],
              });
            else
              await store.updateExecution({
                executionId,
                ...(change === 'run'
                  ? { orchestratorRunId: 'replacement' }
                  : { currentStage: 'new-attempt' }),
              });
          }
          return db.doc.send(command);
        },
      },
    });
    expect(
      await finalizeUnitCompletion({ store: racing, executionId, runId: 'run', plan }),
    ).toEqual({ state: 'retired' });
    expect((await store.getExecution(executionId)).status).toBe('RUNNING');
  },
);

it('detects a plan replaced after the section checkpoint without re-running any stage', async () => {
  const executionId = await setup();
  expect(
    await finalizeUnitCompletion({
      store,
      executionId,
      runId: 'run',
      plan,
      expectedUnitPlanIdentity: unitPlanIdentity({ units: [{ slug: 'prior' }] }),
    }),
  ).toMatchObject({ state: 'unknown', reason: 'unit_plan_changed_after_section' });
});

it('bounds completion reads and never calls a truncated prefix complete', async () => {
  const executionId = await setup();
  expect(await store.getCompletionRecords(executionId, { maxRecords: 2 })).toMatchObject({
    truncated: true,
    units: [],
  });
});

it('reconciles a committed final transaction whose response was lost', async () => {
  const executionId = await setup();
  let lost = false;
  const responseLost = createProcessStore({
    tableName,
    ddb: {
      send: async (command) => {
        const result = await db.doc.send(command);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          throw new Error('response lost after commit');
        }
        return result;
      },
    },
  });
  expect(
    await finalizeUnitCompletion({ store: responseLost, executionId, runId: 'run', plan }),
  ).toMatchObject({ state: 'complete' });
  expect((await store.getExecution(executionId)).status).toBe('SUCCEEDED');
});
