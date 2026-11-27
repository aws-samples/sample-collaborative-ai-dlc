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
      // DynamoDB refuses these with a ValidationException (a 500 before).
      [{ projectId }, { ...created, extra: 'x' }],
      ...['pk', 'sk', 'GSI1SK'].map((key) => [{ projectId }, { ...created, [key]: '' }]),
      [{ projectId }, 'not-an-object'],
    ]) {
      await expect(
        store.listProjectExecutionsPage({ ...query, limit: 1, cursor }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it(
    'ends with an empty page when the rows fill the last page exactly',
    async () => {
      for (const count of [50, 100]) {
        const projectId = randomUUID();
        const ids = await seed(projectId, count);
        const pages = await readAll({ projectId, limit: 50 });
        // DynamoDB returns a cursor after a full page; the client follows it.
        expect(pages.map((items) => items.length)).toEqual([...Array(count / 50).fill(50), 0]);
        expect(
          pages
            .flat()
            .map((item) => item.executionId)
            .toSorted(),
        ).toEqual(ids.toSorted());
      }
    },
    SEED_TIMEOUT_MS,
  );

  it('an intent whose status changes between pages can be skipped or repeated', async () => {
    // GSI1 sorts by status first, so a status change moves the row within the
    // list. Pages read before the change do not see it: the row shows up again
    // on the next full refresh (eventual consistency of the paged list).
    const projectId = randomUUID();
    const running = await seed(projectId, 2, 'RUNNING');
    const created = await seed(projectId, 2);
    const first = await store.listProjectExecutionsPage({ projectId, limit: 2 });
    expect(first.items.map((item) => item.executionId).toSorted()).toEqual(running.toSorted());

    // A CREATED row moves ahead of the cursor (SUCCEEDED sorts before RUNNING
    // in this newest-first order) and a RUNNING row already read moves behind it.
    await store.updateExecution({ executionId: created[0], status: 'SUCCEEDED' });
    await store.updateExecution({ executionId: running[0], status: 'CANCELLED' });
    const second = await store.listProjectExecutionsPage({
      projectId,
      limit: 50,
      cursor: first.cursor,
    });
    expect(second.items.map((item) => item.executionId).toSorted()).toEqual(
      [created[1], running[0]].toSorted(),
    );
    expect(second.cursor).toBeNull();

    const refreshed = await readAll({ projectId, limit: 50 });
    expect(refreshed.flat()).toHaveLength(4);
  });
});
