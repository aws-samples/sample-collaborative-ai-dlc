// The pending-question aggregation against the PRODUCTION process store on
// DynamoDB Local with the real GSI1/GSI2 definitions: proves the index keys the
// store writes and the answerable rule agree. State is built only through
// store APIs. The root test runner starts DynamoDB Local (test/dynamodb-setup.js).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { aggregatePendingQuestions } from '../pending-questions.js';
const gsi = (name) => ({
  IndexName: name,
  KeySchema: [
    { AttributeName: `${name}PK`, KeyType: 'HASH' },
    { AttributeName: `${name}SK`, KeyType: 'RANGE' },
  ],
  Projection: { ProjectionType: 'ALL' },
});
describe.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'pending questions against the production process store',
  () => {
    const table = `v2-proc-pending-${randomUUID()}`;
    let raw;
    let store;
    beforeAll(async () => {
      raw = new DynamoDBClient({
        endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      await raw.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: ['pk', 'sk', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((n) => ({
            AttributeName: n,
            AttributeType: 'S',
          })),
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          GlobalSecondaryIndexes: [gsi('GSI1'), gsi('GSI2')],
        }),
      );
      store = createProcessStore({ ddb: DynamoDBDocumentClient.from(raw), tableName: table });
    }, 60_000);
    afterAll(async () => {
      await raw?.send(new DeleteTableCommand({ TableName: table })).catch(() => {});
      raw?.destroy();
    });
    const start = async (executionId, projectId, startedAt) => {
      await store.createExecution({
        executionId,
        intentId: executionId,
        projectId,
        status: 'CREATED',
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
        title: `Intent ${executionId}`,
        startedAt,
        startedBy: 'u1',
        repos: ['owner/repo'],
        branch: `aidlc/${executionId}`,
        baseBranch: 'main',
        gitProvider: 'github',
        agentCli: 'kiro',
        environment: { runtimeArn: 'arn:runtime', runtimeEndpoint: 'revision_r_1' },
      });
      await store.updateExecution({ executionId, status: 'RUNNING', orchestratorRunId: 'run1' });
    };
    const own = (stageInstanceId, stageCallbackId) => ({
      orchestratorRunId: 'run1',
      stageCallbackId,
      stageInstanceId,
    });
    const question = (text) => JSON.stringify([{ text }]);

    it('returns exactly the tasks the answer transaction would accept', async () => {
      // e1: lanes, an engine gate, and legacy rows.
      await start('e1', 'p1', '2026-01-01T00:00:00.000Z');
      await store.claimStageAttempt({
        executionId: 'e1',
        ownership: own('s1', 'cb1'),
        stageId: 'functional-design',
        phase: 'construction',
      });
      await store.createHumanTask({
        executionId: 'e1',
        humanTaskId: 'lane-live',
        stageInstanceId: 's1',
        unitSlug: 'refunds',
        sectionIndex: 0,
        kind: 'question',
        questions: question('Which rounding?'),
        ownership: own('s1', 'cb1'),
      });
      await store.claimStageAttempt({
        executionId: 'e1',
        ownership: own('s2', 'cb2'),
        stageId: 'code-generation',
        phase: 'construction',
      });
      await store.createHumanTask({
        executionId: 'e1',
        humanTaskId: 'lane-stale',
        stageInstanceId: 's2',
        unitSlug: 'payouts',
        sectionIndex: 1,
        kind: 'question',
        questions: question('Stale attempt'),
        ownership: own('s2', 'cb2'),
      });
      // A re-dispatch re-claims the parked stage with a new callback.
      await store.claimStageAttempt({ executionId: 'e1', ownership: own('s2', 'cb3') });
      // An engine gate (stage review) names the stage but carries no callback.
      await store.createHumanTask({
        executionId: 'e1',
        humanTaskId: 'review',
        stageInstanceId: 's1',
        kind: 'validation',
        prompt: 'Review functional design',
        orchestratorRunId: 'run1',
      });
      for (const humanTaskId of ['legacy-live', 'legacy-answered', 'legacy-superseded'])
        await store.createHumanTask({
          executionId: 'e1',
          humanTaskId,
          kind: 'question',
          questions: question(humanTaskId),
        });
      await store.answerHumanTask({
        executionId: 'e1',
        humanTaskId: 'legacy-answered',
        status: 'answered',
        answer: { a: 1 },
        answeredBy: 'u1',
        answeredByName: 'Ada',
      });
      await store.supersedeHumanTask({ executionId: 'e1', humanTaskId: 'legacy-superseded' });

      // e2: rewound — META moves to a retired run id, so its gate is stale.
      await start('e2', 'p1', '2026-01-02T00:00:00.000Z');
      await store.createHumanTask({
        executionId: 'e2',
        humanTaskId: 'old-run',
        kind: 'approval',
        prompt: 'Approve',
        orchestratorRunId: 'run1',
      });
      await store.updateExecution({ executionId: 'e2', orchestratorRunId: 'retired-run1' });

      // e3: cancelled with a gate left pending.
      await start('e3', 'p1', '2026-01-03T00:00:00.000Z');
      await store.createHumanTask({
        executionId: 'e3',
        humanTaskId: 'cancelled',
        kind: 'question',
      });
      await store.updateExecution({ executionId: 'e3', status: 'CANCELLED' });

      // e4: another space the caller is not a member of.
      await start('e4', 'p2', '2026-01-04T00:00:00.000Z');
      await store.createHumanTask({ executionId: 'e4', humanTaskId: 'other', kind: 'question' });

      const res = await aggregatePendingQuestions({
        userId: 'u1',
        memberships: [{ projectId: 'p1', projectName: 'Payments', kind: 'v2', role: 'member' }],
        store,
        params: { limit: 50, cursor: null, projectId: null, kinds: null },
      });
      expect(res.unavailable).toEqual([]);
      expect(res.items.map((i) => i.humanTaskId).toSorted()).toEqual([
        'lane-live',
        'legacy-live',
        'review',
      ]);
      const byId = Object.fromEntries(res.items.map((i) => [i.humanTaskId, i]));
      expect(byId['lane-live']).toMatchObject({
        id: 'e1:lane-live',
        projectName: 'Payments',
        intentTitle: 'Intent e1',
        stageId: 'functional-design',
        phase: 'construction',
        unitSlug: 'refunds',
        sectionIndex: 0,
        summary: 'Which rounding?',
        eligibility: { basis: 'space-member', assignment: 'open' },
        target: { view: 'gate' },
      });
      expect(byId.review).toMatchObject({
        stageId: 'functional-design',
        target: { view: 'review' },
      });
    });
  },
);
