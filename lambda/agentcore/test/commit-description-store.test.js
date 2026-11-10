import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { consumeCommitDescription, readCommitDescription } from '../commit-message.js';
import { createV2Table, deleteV2Table, makeDdb } from './helpers/v2-table.js';

const tableName = `commit-description-${randomUUID()}`;
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

const describedStage = async (descriptionId = 'd1') => {
  const executionId = randomUUID();
  const stageInstanceId = 'si-1';
  await store.putStage({ executionId, stageInstanceId, stageId: 'code-generation' });
  await store.setCommitDescription({
    executionId,
    stageInstanceId,
    description: { type: 'feat', summary: 'add retries', descriptionId },
  });
  return { store, executionId, stageInstanceId };
};
const committed = (...repos) => ({ results: repos.map((repo) => ({ repo, committed: true })) });

it('accumulates the repositories commits used the description in', async () => {
  const where = await describedStage();
  let description = await readCommitDescription(where);
  expect(description.committedRepos).toEqual([]);
  await consumeCommitDescription({ ...where, description, gitResult: committed('a') });
  description = await readCommitDescription(where);
  expect(description.committedRepos).toEqual(['a']);
  await consumeCommitDescription({ ...where, description, gitResult: committed('a', 'b') });
  expect((await readCommitDescription(where)).committedRepos).toEqual(['a', 'b']);
});

it('leaves a newer description unused when an older commit records its use', async () => {
  const where = await describedStage();
  const stale = await readCommitDescription(where);
  await store.setCommitDescription({
    executionId: where.executionId,
    stageInstanceId: where.stageInstanceId,
    description: { type: 'fix', summary: 'round totals', descriptionId: 'd2' },
  });
  expect(
    await store.recordCommitDescriptionUse({
      executionId: where.executionId,
      stageInstanceId: where.stageInstanceId,
      descriptionId: stale.descriptionId,
      repos: ['a'],
    }),
  ).toBe(false);
  expect(await readCommitDescription(where)).toMatchObject({
    descriptionId: 'd2',
    committedRepos: [],
  });
});
