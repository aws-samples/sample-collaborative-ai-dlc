import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { auditCompletion } from '../../shared/completion-audit.js';
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
  await store.updateExecution({
    executionId,
    status: 'RUNNING',
    orchestratorRunId: 'run',
  });
  await store.putUnitPlan({
    executionId,
    units: [{ slug: 'a', dependsOn: [] }],
    batches: [['a']],
  });
  await store.syncUnitRows({
    executionId,
    units: [{ slug: 'a', dependsOn: [] }],
    sectionIndexes: [1],
  });
  await store.updateUnitState({
    executionId,
    sectionIndex: 1,
    slug: 'a',
    state,
  });
  return executionId;
};

it('queries one project and start-time range with pagination, checkpointing and safe reruns', async () => {
  const projectId = randomUUID();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = await setup({
      projectId,
      state: i === 1 ? 'BLOCKED' : 'MERGED',
    });
    await store.updateExecution({ executionId: id, status: 'SUCCEEDED' });
    ids.push(id);
  }
  await setup(); // another project must never appear
  const scope = {
    projectId,
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    maxExecutions: 1,
    pageSize: 1,
    maxPages: 1,
  };
  const args = { store, scope, loadPlan: async () => ({ valid: true, plan }) };
  const seen = [];
  let checkpoint = null;
  do {
    const result = await auditCompletion({ ...args, checkpoint });
    seen.push(...result.findings);
    checkpoint = result.checkpoint;
  } while (checkpoint);
  expect(seen.map((row) => row.executionId).toSorted()).toEqual(ids.toSorted());
  expect(seen.filter((row) => row.state === 'incomplete')).toHaveLength(1);
  expect((await auditCompletion(args)).findings[0]).toEqual(seen[0]);
  const page = await store.listCompletionAuditPage({
    ...scope,
    status: 'SUCCEEDED',
    limit: 1,
  });
  await expect(
    store.listCompletionAuditPage({
      ...scope,
      projectId: 'unrelated',
      status: 'SUCCEEDED',
      cursor: page.cursor,
    }),
  ).rejects.toThrow('outside');
});
