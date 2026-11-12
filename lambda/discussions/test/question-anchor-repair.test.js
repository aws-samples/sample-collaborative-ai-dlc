// Discuss on a question gate whose Question vertex is missing from the intent
// graph (a checkpoint gate, or a failed best-effort mirror). Runs the real
// handler against the gremlin server and DynamoDB Local: the gate row is the
// process table's HUMAN# record, written through the shared process store.

import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { makeDdb, createV2Table, deleteV2Table } from '../../agentcore/test/helpers/v2-table.js';

const PARTITION = 'discussions-question-anchor-repair';
const PROCESS_TABLE = 'v2-proc-question-anchor-repair';
const LOCKS_TABLE = 'discussion-locks-question-anchor-repair';
const MEMBER = 'member-user';
const QUESTIONS = JSON.stringify([
  { text: 'Does this look correct?', type: 'single', options: [{ label: 'Looks correct' }] },
]);

let handler;
let handlerDdb;
let close;
let conn;
let g;
let db;
let store;
let run = 0;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('LOCKS_TABLE', LOCKS_TABLE);
  vi.stubEnv('V2_PROCESS_TABLE', PROCESS_TABLE);
  ({ handler, close } = await import('../index.js'));
  ({ ddb: handlerDdb } = await import('../clients.js'));
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
  db = makeDdb();
  await createV2Table(db.client, PROCESS_TABLE);
  await db.client.send(
    new CreateTableCommand({
      TableName: LOCKS_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'lockId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'lockId', KeyType: 'HASH' }],
    }),
  );
  store = createProcessStore({ ddb: db.doc, tableName: PROCESS_TABLE });
  await g.V().drop().next();
  await g
    .addV('Project')
    .property('id', 'proj-1')
    .as('p')
    .addV('User')
    .property('id', MEMBER)
    .as('u')
    .addE('HAS_MEMBER')
    .property('role', 'member')
    .from_('p')
    .to('u')
    .next();
});

afterAll(async () => {
  await g?.V().drop().next();
  await close?.();
  await conn?.close();
  if (db) {
    await deleteV2Table(db.client, PROCESS_TABLE);
    await db.client.send(new DeleteTableCommand({ TableName: LOCKS_TABLE }));
    db.client.destroy();
  }
  vi.unstubAllEnvs();
});

// A started intent: its Intent vertex in the graph and its execution in the
// process table (executionId equals the intent id), with no Question vertices.
let intentId;
const seedIntent = async () => {
  run += 1;
  const id = `intent-repair-${run}`;
  await g.addV('Intent').property('id', id).property('project_id', 'proj-1').next();
  await store.createExecution({ executionId: id, intentId: id, projectId: 'proj-1' });
  return id;
};

beforeEach(async () => {
  intentId = await seedIntent();
});

const openGate = (executionId, humanTaskId, kind = 'question') =>
  store.createHumanTask({
    executionId,
    humanTaskId,
    stageInstanceId: 'si-1',
    kind,
    ...(kind === 'question' ? { questions: QUESTIONS } : { prompt: 'Approve?' }),
  });

const discuss = (entityId, onIntent = intentId) =>
  handler({
    httpMethod: 'POST',
    resource: '/api/projects/{projectId}/intents/{intentId}/discussions',
    pathParameters: { projectId: 'proj-1', intentId: onIntent },
    body: JSON.stringify({ entityType: 'question', entityId }),
    requestContext: { authorizer: { claims: { sub: MEMBER, email: `${MEMBER}@example.com` } } },
  });

const questionsOf = async (id) =>
  (
    await g.V().has('Intent', 'id', id).out('CONTAINS').hasLabel('Question').valueMap().toList()
  ).map((row) => Object.fromEntries([...row].map(([key, values]) => [key, values[0]])));

const containsEdges = async (questionId) =>
  g
    .V()
    .has('Intent', 'id', intentId)
    .outE('CONTAINS')
    .where(gremlin.process.statics.inV().has('Question', 'id', questionId))
    .count()
    .next()
    .then((r) => r.value);

// guards: contract Discuss question anchor repair
describe('Discuss rebuilds a missing Question vertex from its gate', () => {
  // guards: data-safety answer committed during Discuss repair
  it('copies an answer committed while repairing the Question vertex', async () => {
    const gateId = 'chk-concurrent-answer';
    await openGate(intentId, gateId);
    const answer = { perQuestion: [{ answer: 'Looks correct' }] };
    let answered;
    const send = handlerDdb.send.bind(handlerDdb);
    const spy = vi.spyOn(handlerDdb, 'send').mockImplementation(async (command, ...rest) => {
      const result = await send(command, ...rest);
      if (
        command instanceof GetCommand &&
        command.input.Key?.sk === `HUMAN#${gateId}` &&
        !answered
      ) {
        answered = await store.answerHumanTask({
          executionId: intentId,
          humanTaskId: gateId,
          status: 'answered',
          answer,
          answeredBy: 'alice',
          answeredByName: 'Alice',
        });
      }
      return result;
    });

    let res;
    try {
      res = await discuss(gateId);
    } finally {
      spy.mockRestore();
    }

    expect(res.statusCode).toBe(200);
    expect(answered).toBeDefined();
    const questions = await questionsOf(intentId);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: gateId,
      structured_answer: JSON.stringify(answer),
      answered_by: 'alice',
      answered_by_name: 'Alice',
      answered_at: answered.answeredAt,
    });
    expect(await store.getHumanTask(intentId, gateId, { consistentRead: true })).toEqual(answered);
    expect((await store.getExecution(intentId)).status).toBe('CREATED');
  });

  // guards: security cross-intent question repair
  it('keeps another intent’s answered question separate when repairing a shared id', async () => {
    const otherIntent = await seedIntent();
    const otherAnswer = JSON.stringify({ perQuestion: [{ answer: 'Other' }] });
    await g
      .addV('Question')
      .property('id', 'chk-shared')
      .property('intent_id', otherIntent)
      .property('structured_answer', otherAnswer)
      .as('question')
      .V()
      .has('Intent', 'id', otherIntent)
      .addE('CONTAINS')
      .to('question')
      .next();
    await openGate(intentId, 'chk-shared');
    const answer = { perQuestion: [{ answer: 'Looks correct' }] };
    await store.answerHumanTask({
      executionId: intentId,
      humanTaskId: 'chk-shared',
      status: 'answered',
      answer,
    });

    const res = await discuss('chk-shared');

    expect(res.statusCode).toBe(200);
    expect(await questionsOf(intentId)).toMatchObject([
      { id: 'chk-shared', intent_id: intentId, structured_answer: JSON.stringify(answer) },
    ]);
    expect(await questionsOf(otherIntent)).toMatchObject([
      { id: 'chk-shared', intent_id: otherIntent, structured_answer: otherAnswer },
    ]);
  });

  // guards: contract S3
  it('Given a pending checkpoint gate with no Question in the graph, when a project member opens Discuss on it, then a discussion is returned and the intent has one Question for that gate', async () => {
    await openGate(intentId, 'chk-summary-confirmation-si-1-0---0');

    const res = await discuss('chk-summary-confirmation-si-1-0---0');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      entityType: 'question',
      entityId: 'chk-summary-confirmation-si-1-0---0',
    });
    const questions = await questionsOf(intentId);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: 'chk-summary-confirmation-si-1-0---0',
      intent_id: intentId,
      questions: QUESTIONS,
    });
  });

  // guards: contract S4
  it('Given an answered checkpoint gate with no Question in the graph, when a member opens Discuss on it, then the rebuilt Question carries the recorded answer, responder and answer time, and the gate itself is left unchanged and unresumed', async () => {
    const gateId = 'chk-plan-approval-si-1-0---0';
    await openGate(intentId, gateId);
    const answer = { perQuestion: [{ answer: 'Looks correct' }] };
    const answered = await store.answerHumanTask({
      executionId: intentId,
      humanTaskId: gateId,
      status: 'answered',
      answer,
      answeredBy: 'alice',
      answeredByName: 'Alice',
    });

    const res = await discuss(gateId);

    expect(res.statusCode).toBe(200);
    const [question] = await questionsOf(intentId);
    expect(question).toMatchObject({
      id: gateId,
      structured_answer: JSON.stringify(answer),
      answered_by: 'alice',
      answered_by_name: 'Alice',
      answered_at: answered.answeredAt,
    });
    const gateAfter = await store.getHumanTask(intentId, gateId, { consistentRead: true });
    expect(gateAfter).toEqual(answered);
    const execution = await store.getExecution(intentId);
    expect(execution.status).toBe('CREATED');
  });

  // guards: contract S5
  it('Given a gate with no Question in the graph, when Discuss is opened on it twice in a row and twice at the same time, then the intent ends with exactly one Question, one link to it and one discussion', async () => {
    await openGate(intentId, 'chk-seq');
    await openGate(intentId, 'chk-race');

    const sequential = [await discuss('chk-seq'), await discuss('chk-seq')];
    const concurrent = await Promise.all([discuss('chk-race'), discuss('chk-race')]);

    for (const [gateId, responses] of [
      ['chk-seq', sequential],
      ['chk-race', concurrent],
    ]) {
      expect(responses.map((res) => res.statusCode)).toEqual([200, 200]);
      const [first, second] = responses.map((res) => JSON.parse(res.body).id);
      expect(second).toBe(first);
      expect((await questionsOf(intentId)).filter((q) => q.id === gateId)).toHaveLength(1);
      expect(await containsEdges(gateId)).toBe(1);
    }
  });

  // guards: contract S6
  it('Given a missing gate, an approval gate, or a gate of another intent, when a member opens Discuss with that question id, then the request is refused as not found and no Question is created', async () => {
    const otherIntent = await seedIntent();
    await openGate(intentId, 'ht-approval', 'approval');
    await openGate(otherIntent, 'chk-foreign');
    await openGate(intentId, 'chk-present');
    expect((await discuss('chk-present')).statusCode).toBe(200);

    const statuses = [];
    for (const gateId of ['chk-missing', 'ht-approval', 'chk-foreign']) {
      statuses.push((await discuss(gateId)).statusCode);
    }
    expect(statuses).toEqual([404, 404, 404]);

    expect((await questionsOf(intentId)).map((q) => q.id)).toEqual(['chk-present']);
    expect(await questionsOf(otherIntent)).toEqual([]);
  });
});
