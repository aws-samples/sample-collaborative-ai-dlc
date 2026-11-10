// Final delivery must never adopt a closed or merged pull request it cannot
// prove is its own. The intent branch is fixed at intent creation, so every run
// of an intent (rewind, relaunch, iteration after a merge) shares one source
// branch with all earlier runs' pull requests. These tests run the real
// provider adapters, provider-side inspection, publisher, preview and view
// against in-memory code hosts and the real DynamoDB process store.
import { randomBytes, randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { inspectDelivery } from '../../shared/delivery-provider.js';
import {
  previewDelivery,
  publishFinalDelivery,
  deliveryView,
  currentDelivery,
} from '../../shared/final-delivery.js';
import { createFakeHost, hostOperation } from './fixtures/fake-pr-hosts.js';

const PROVIDERS = ['github', 'gitlab', 'bitbucket', 'codecommit'];
const MINUTE = 60_000;
const tableName = `delivery-ownership-${randomUUID()}`;
let db;
beforeAll(async () => {
  db = makeDdb();
  await createV2Table(db.client, tableName);
});
afterAll(async () => {
  await deleteV2Table(db.client, tableName);
  db.client.destroy();
});

// A pull request another run (or a person copying its description) created.
const otherMarker = () => `aidlc-delivery-${randomBytes(16).toString('hex')}`;
const markedBody = (marker) =>
  `Automated PR created by AI-DLC\n\n<!-- aidlc-delivery: ${marker} -->`;

const setup = async (name, hostOptions) => {
  const host = createFakeHost(name, hostOptions);
  const store = createProcessStore({ ddb: db.doc, tableName });
  const executionId = randomUUID();
  await store.createExecution({
    executionId,
    intentId: executionId,
    projectId: 'project',
    repos: [host.repo],
    gitProvider: name,
    branch: 'intent/feature',
    baseBranch: 'develop',
    methodologyPins: { STAGE: {} },
  });
  const t = { host, store, executionId };
  t.meta = await store.updateExecution({
    executionId,
    status: 'SUCCEEDED',
    orchestratorRunId: 'run1',
  });
  const operation = hostOperation(host, inspectDelivery);
  const loadPlan = async () => ({ valid: true, plan: { stages: [] } });
  t.publish = (claimed = null) =>
    publishFinalDelivery({
      store,
      meta: t.meta,
      operation,
      loadPlan,
      applicationUrl: 'https://aidlc.example',
      claimed,
    });
  t.preview = async () =>
    previewDelivery({
      meta: await store.getExecution(executionId, { consistentRead: true }),
      records: await store.getExecutionRecords(executionId, { consistentRead: true }),
      plan: { stages: [] },
      operation,
    });
  // The intents API path: preview, confirm with the token's delivery, claim,
  // then the orchestrator's retry-delivery publication.
  t.retry = async () => {
    const p = await t.preview();
    const claimed = await store.claimDelivery({
      meta: await store.getExecution(executionId, { consistentRead: true }),
      delivery: p.delivery,
      attemptId: randomUUID(),
    });
    await t.publish(claimed);
    return p;
  };
  // Rewind or relaunch: same intent branch, new run.
  t.relaunch = async (runId) => {
    t.meta = await store.updateExecution({ executionId, orchestratorRunId: runId });
  };
  t.repository = async () =>
    (await store.getDelivery(executionId, t.meta.orchestratorRunId)).repositories[0];
  t.view = async () =>
    deliveryView(t.meta, currentDelivery(await store.getExecutionRecords(executionId)));
  return t;
};
// The PR numbers the current delivery view links as this run's.
const shownPrs = (view) =>
  view.repositories.map((r) => (r.pr?.prNumber == null ? null : Number(r.pr.prNumber)));

// Final delivery titles the pull request like the publication it replaced.
describe('final delivery pull request title', () => {
  it.each([
    [true, '[ABC-12] Bookstore API'],
    [false, 'Bookstore API'],
  ])('with prTitleTrackerKey %s, titles the PR %s', async (prTitleTrackerKey, title) => {
    const t = await setup('github');
    await publishFinalDelivery({
      store: t.store,
      meta: {
        ...t.meta,
        title: 'Bookstore API',
        source: { provider: 'jira-cloud', resourceType: 'issue', resourceId: 'ABC-12' },
      },
      operation: hostOperation(t.host, inspectDelivery),
      loadPlan: async () => ({ valid: true, plan: { stages: [] } }),
      applicationUrl: 'https://aidlc.example',
      prTitleTrackerKey,
    });
    expect(t.host.prs.map((pr) => pr.title)).toEqual([title]);
  });
});

describe.each(PROVIDERS)('%s final delivery PR ownership', (name) => {
  it.each(
    [0, 30_000, 4 * MINUTE, 6 * MINUTE, 3 * 60 * MINUTE].flatMap((age) =>
      ['closed', 'merged'].map((state) => [state, age]),
    ),
  )(
    "never adopts an earlier run's %s PR created %d ms before this run's create request",
    async (state, age) => {
      const t = await setup(name);
      await t.publish();
      const [earlier] = t.host.prs;
      earlier.state = state;
      earlier.createdAt = Date.now() - age;
      await t.relaunch('run2');
      // This run's first create request is lost before reaching the provider.
      t.host.failCreates = 1;
      await t.publish();
      const p = await t.retry();
      expect(p.delivery.repositories[0].pr).toBeUndefined();
      expect(t.host.prs).toHaveLength(2);
      const [, created] = t.host.prs;
      expect(created.state).toBe('open');
      expect(await t.repository()).toMatchObject({ status: 'succeeded' });
      expect(shownPrs(await t.view())).toEqual([created.number]);
    },
  );

  it("never adopts another run's marked PR created after this run's create request", async () => {
    const t = await setup(name);
    t.host.failCreates = 1;
    await t.publish();
    t.host.add({ state: 'closed', body: markedBody(otherMarker()), ageMs: -MINUTE });
    await t.retry();
    expect(t.host.prs.filter((pr) => pr.state === 'open')).toHaveLength(1);
    expect(await t.repository()).toMatchObject({ status: 'succeeded' });
    expect(shownPrs(await t.view())).toEqual([t.host.prs.at(-1).number]);
  });

  it.each([-10 * MINUTE, 10 * MINUTE])(
    "identifies this run's own closed PR whatever the provider clock skew (%d ms)",
    async (skew) => {
      const t = await setup(name);
      t.host.clockOffsetMs = skew;
      t.host.loseResponses = 1;
      await t.publish();
      const [own] = t.host.prs;
      own.state = 'closed'; // a reviewer rejected it before the retry
      const p = await t.retry();
      expect(p.delivery.repositories[0]).toMatchObject({ status: 'failed', retryable: false });
      expect(t.host.prs).toHaveLength(1);
      expect(shownPrs(await t.view())).toEqual([own.number]);
    },
  );

  it.each([-10 * MINUTE, 10 * MINUTE])(
    "never adopts an earlier run's closed PR whatever the provider clock skew (%d ms)",
    async (skew) => {
      const t = await setup(name);
      t.host.clockOffsetMs = skew;
      await t.publish();
      t.host.prs[0].state = 'closed';
      await t.relaunch('run2');
      t.host.failCreates = 1;
      await t.publish();
      await t.retry();
      expect(t.host.prs).toHaveLength(2);
      expect(shownPrs(await t.view())).toEqual([t.host.prs[1].number]);
    },
  );

  it.each(
    ['newest', 'oldest'].flatMap((order) => ['closed', 'merged'].map((state) => [state, order])),
  )(
    "finds this run's own %s PR among earlier closed and merged PRs listed %s first",
    async (state, order) => {
      const t = await setup(name, { order });
      await t.publish();
      t.host.prs[0].state = 'merged';
      t.host.prs[0].createdAt -= 3 * 60 * MINUTE;
      await t.relaunch('run2');
      await t.publish();
      t.host.prs[1].state = 'closed';
      t.host.prs[1].createdAt -= 60 * MINUTE;
      t.host.add({ state: 'closed', body: 'Opened by hand', ageMs: 30 * MINUTE });
      await t.relaunch('run3');
      t.host.loseResponses = 1;
      await t.publish();
      const own = t.host.prs.at(-1);
      own.state = state;
      await t.retry();
      expect(t.host.prs).toHaveLength(4);
      expect(await t.repository()).toMatchObject({ status: 'failed', retryable: false });
      expect(shownPrs(await t.view())).toEqual([own.number]);
    },
  );

  it.each(['own-closed', 'only-open'])(
    'reads every page of PRs on the intent branch (%s PR after 101 earlier ones)',
    async (kind) => {
      const t = await setup(name, { order: 'oldest' });
      for (let i = 0; i < 101; i++)
        t.host.add({
          state: i % 2 ? 'merged' : 'closed',
          body: markedBody(otherMarker()),
          ageMs: 3 * 60 * MINUTE,
        });
      t.host.loseResponses = 1;
      await t.publish();
      const own = t.host.prs.at(-1);
      if (kind === 'own-closed') own.state = 'closed';
      await t.retry();
      expect(t.host.prs).toHaveLength(102);
      expect(await t.repository()).toMatchObject(
        kind === 'own-closed' ? { status: 'failed', retryable: false } : { status: 'succeeded' },
      );
      expect(shownPrs(await t.view())).toEqual([own.number]);
    },
  );

  it('publishes a new PR on first publication despite unmarked closed and merged PRs', async () => {
    const t = await setup(name);
    t.host.add({ state: 'closed', body: 'Opened by hand' });
    t.host.add({ state: 'merged', body: 'Automated PR created by an older release' });
    await t.publish();
    expect(t.host.prs).toHaveLength(3);
    expect(shownPrs(await t.view())).toEqual([3]);
  });

  it('leaves an unprovable unmarked PR uncertain after a lost request, and a new run publishes', async () => {
    const t = await setup(name);
    t.host.add({ state: 'closed', body: 'Opened by hand', ageMs: 3 * 60 * MINUTE });
    t.host.failCreates = 1;
    await t.publish();
    const p = await t.retry();
    expect(p.delivery.repositories[0]).toMatchObject({ status: 'uncertain', retryable: false });
    expect(p.delivery.repositories[0].reason).toMatch(/could not be confirmed/);
    expect(t.host.prs).toHaveLength(1);
    expect(shownPrs(await t.view())).toEqual([null]);
    await t.relaunch('run2');
    await t.publish();
    expect(t.host.prs).toHaveLength(2);
    expect(shownPrs(await t.view())).toEqual([2]);
  });

  it('does not adopt its own PR once its description lost the delivery marker', async () => {
    const t = await setup(name);
    t.host.loseResponses = 1;
    await t.publish();
    const [own] = t.host.prs;
    own.body = 'Rewritten by a reviewer';
    own.state = 'closed';
    const p = await t.retry();
    expect(p.delivery.repositories[0]).toMatchObject({ status: 'uncertain', retryable: false });
    expect(t.host.prs).toHaveLength(1);
    expect(shownPrs(await t.view())).toEqual([null]);
  });

  it("reuses an earlier run's PR that is still open", async () => {
    const t = await setup(name);
    await t.publish();
    await t.relaunch('run2');
    await t.publish();
    expect(t.host.prs).toHaveLength(1);
    expect(await t.repository()).toMatchObject({ status: 'succeeded' });
    expect(shownPrs(await t.view())).toEqual([1]);
  });

  it('degrades a row written by an earlier head to unproven instead of adopting its PR', async () => {
    const t = await setup(name);
    const [old] = [t.host.add({ state: 'closed', body: 'Automated PR', ageMs: 4 * MINUTE })];
    // fb2999bb could record an earlier run's terminal PR within its window.
    await db.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `EXEC#${t.executionId}`,
          sk: 'DELIVERY#run1',
          type: 'FinalDelivery',
          executionId: t.executionId,
          orchestratorRunId: 'run1',
          attemptId: 'old-attempt',
          revision: 2,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          repositories: [
            {
              repoId: t.host.repo,
              provider: name,
              branch: 'intent/feature',
              baseBranch: 'develop',
              headSha: 'head1',
              status: 'failed',
              retryable: false,
              createRequestedAt: new Date().toISOString(),
              reason: "This run's pull request is closed.",
              pr: {
                repoId: t.host.repo,
                provider: name,
                prNumber: old.number,
                prUrl: 'https://provider.example/pr/1',
                branch: 'intent/feature',
                baseBranch: 'develop',
              },
            },
          ],
        },
      }),
    );
    const p = await t.preview();
    expect(p.delivery.repositories[0]).toMatchObject({ status: 'uncertain', retryable: false });
    expect(p.delivery.repositories[0].pr).toBeUndefined();
    await t.retry();
    expect(t.host.prs).toHaveLength(1);
    expect(shownPrs(await t.view())).toEqual([null]);
  });

  it.each(['closed', 'merged'])(
    'refuses its own PR that was retargeted and then %s instead of creating another',
    async (state) => {
      const t = await setup(name);
      t.host.loseResponses = 1;
      await t.publish();
      const [own] = t.host.prs;
      own.target = 'main'; // a reviewer retargeted it, then closed or merged it
      own.state = state;
      const p = await t.retry();
      expect(p.delivery.repositories[0]).toMatchObject({ status: 'failed', retryable: false });
      expect(p.delivery.repositories[0].reason).toMatch(/retargeted to main/);
      expect(t.host.prs).toHaveLength(1);
      expect(await t.repository()).toMatchObject({ status: 'failed', retryable: false });
      // Proven by this run's marker, so the view may link it as this run's.
      expect(shownPrs(await t.view())).toEqual([Number(own.number)]);
    },
  );

  it("publishes a new PR when only an earlier run's marked PR was retargeted", async () => {
    const t = await setup(name);
    await t.publish();
    const [earlier] = t.host.prs;
    earlier.target = 'main';
    earlier.state = 'closed';
    await t.relaunch('run2');
    await t.publish();
    expect(t.host.prs).toHaveLength(2);
    expect(shownPrs(await t.view())).toEqual([2]);
  });
});
