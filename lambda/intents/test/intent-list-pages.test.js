import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';

// The paged intents list against DynamoDB Local: every page is one bounded
// Query on GSI1, and the cursor DynamoDB returns resumes it without a gap.

const tableName = `intent-list-pages-${randomUUID()}`;
// Seeding a hundred rows takes seconds on DynamoDB Local under the full suite.
const SEED_TIMEOUT_MS = 30_000;
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

// Every execution shares one startedAt, so page boundaries fall between equal
// timestamps and the order rests on the execution id in the sort key.
const seed = async (projectId, count, status) => {
  const ids = Array.from({ length: count }, () => randomUUID());
  for (let start = 0; start < count; start += 25) {
    await Promise.all(
      ids.slice(start, start + 25).map(async (executionId) => {
        await store.createExecution({
          executionId,
          intentId: executionId,
          projectId,
          startedAt: '2026-11-01T00:00:00.000Z',
          workflowId: 'workflow',
          workflowVersion: 1,
          methodologyPins: { STAGE: {} },
        });
        if (status) await store.updateExecution({ executionId, status });
      }),
    );
  }
  return ids;
};

const readAll = async (query) => {
  const pages = [];
  let cursor;
  do {
    const page = await store.listProjectExecutionsPage({ ...query, cursor });
    pages.push(page.items);
    cursor = page.cursor;
  } while (cursor && pages.length < 20);
  return pages;
};

describe('listProjectExecutionsPage', () => {
  it(
    'reads every execution of a project once, without rows of another project',
    async () => {
      const projectId = randomUUID();
      const created = await seed(projectId, 61);
      const failed = await seed(projectId, 40, 'FAILED');
      await seed(randomUUID(), 3);

      const pages = await readAll({ projectId, limit: 50 });
      // DynamoDB may return LastEvaluatedKey on a full last page; that page is empty.
      expect(pages.flat()).toHaveLength(101);
      expect(pages.every((items) => items.length <= 50)).toBe(true);
      const ids = pages.flat().map((item) => item.executionId);
      expect(ids.toSorted()).toEqual([...created, ...failed].toSorted());
      expect(pages.flat().every((item) => item.sk === 'META')).toBe(true);

      const failedPages = await readAll({ projectId, status: 'FAILED', limit: 30 });
      expect(
        failedPages
          .flat()
          .map((item) => item.executionId)
          .toSorted(),
      ).toEqual(failed.toSorted());
    },
    SEED_TIMEOUT_MS,
  );

  it('refuses a cursor from another project or status before querying', async () => {
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    await seed(projectId, 3);
    await seed(otherProjectId, 3, 'FAILED');
    const { cursor: foreign } = await store.listProjectExecutionsPage({
      projectId: otherProjectId,
      limit: 1,
    });
    const { cursor: created } = await store.listProjectExecutionsPage({
      projectId,
      status: 'CREATED',
      limit: 1,
    });
    expect(foreign).toBeTruthy();

    for (const [query, cursor] of [
      [{ projectId }, foreign],
      [{ projectId, status: 'FAILED' }, created],
      [{ projectId }, { ...created, sk: undefined }],
    ]) {
      await expect(
        store.listProjectExecutionsPage({ ...query, limit: 1, cursor }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});
