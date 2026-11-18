// A checkpoint gate is a human decision, so the intent graph mirrors it as a
// Question the same way ask_question does. Runs against the real gremlin server
// and DynamoDB Local; the only stand-in is the failing mirror in the second test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { makeDdb, createV2Table, deleteV2Table } from './helpers/v2-table.js';
import { createGraphWriter } from '../mcp/graph-writer.js';
import { createProcessBridge } from '../mcp/process-bridge.js';
import { createProcessStore } from '../../shared/v2-process-store.js';

const TABLE = 'v2-proc-checkpoint-question-mirror';
const PARTITION = 'agentcore-checkpoint-question-mirror';

let conn;
let g;
let db;
let store;
let scope;
let run = 0;

beforeAll(async () => {
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
  await createV2Table(db.client, TABLE);
  store = createProcessStore({ ddb: db.doc, tableName: TABLE });
});

afterAll(async () => {
  await g?.V().drop().next();
  await conn?.close();
  if (db) {
    await deleteV2Table(db.client, TABLE);
    db.client.destroy();
  }
});

beforeEach(async () => {
  await g.V().drop().next();
  run += 1;
  const id = `intent-chk-${run}`;
  scope = {
    executionId: id,
    intentId: id,
    projectId: 'proj-1',
    stageInstanceId: 'si-1',
    stageAttempt: 0,
    policy: { summaryConfirmation: 'required' },
  };
  await store.createExecution({ executionId: id, intentId: id, projectId: 'proj-1' });
  await store.putStage({
    executionId: id,
    stageInstanceId: 'si-1',
    stageId: 's',
    state: 'RUNNING',
  });
  await g.addV('Intent').property('id', id).property('project_id', 'proj-1').next();
});

// A bridge whose grace window never sees an answer, so every checkpoint parks.
const parkingBridge = (graphWriter) =>
  createProcessBridge({
    store,
    graphWriter,
    scope,
    pollIntervalMs: 1,
    parkGraceMs: 2,
    sleep: async () => {},
  });

const intentQuestions = async () =>
  (
    await g
      .V()
      .has('Intent', 'id', scope.intentId)
      .out('CONTAINS')
      .hasLabel('Question')
      .valueMap('id', 'questions')
      .toList()
  ).map((row) => ({ id: row.get('id')[0], questions: row.get('questions')[0] }));

// guards: contract checkpoint gate Question mirror
describe('checkpoint gates are mirrored as Question vertices', () => {
  // guards: contract S1
  it("Given a stage raises a new checkpoint, when the gate opens, then the intent graph gains one Question with the gate's id and questions, and raising the same pending checkpoint again adds no second Question", async () => {
    const bridge = parkingBridge(createGraphWriter({ g, scope }));

    const first = await bridge.confirmSummary({ summary: 'model the order lifecycle' });
    const gate = await store.getHumanTask(scope.executionId, first.humanTaskId);
    expect(await intentQuestions()).toEqual([{ id: gate.humanTaskId, questions: gate.questions }]);

    const second = await bridge.confirmSummary({ summary: 'model the order lifecycle' });
    expect(second.humanTaskId).toBe(first.humanTaskId);
    expect(await intentQuestions()).toHaveLength(1);
  });

  // guards: contract S2
  it('Given the graph mirror fails, when a stage raises a checkpoint, then the checkpoint still parks and no ordinary "question asked" event is recorded', async () => {
    let mirrorAttempts = 0;
    const failingWriter = {
      ...createGraphWriter({ g, scope }),
      recordQuestion: async () => {
        mirrorAttempts += 1;
        throw new Error('gremlin unavailable');
      },
    };

    const result = await parkingBridge(failingWriter).confirmSummary({ summary: 'a summary' });

    expect(mirrorAttempts).toBe(1);
    expect(result).toMatchObject({ parked: true });
    const gate = await store.getHumanTask(scope.executionId, result.humanTaskId);
    expect(gate.status).toBe('pending');
    const events = await store.listEvents(scope.executionId, { consistentRead: true });
    expect(events.map((event) => event.eventType ?? event.type)).not.toContain('v2.question.asked');
  });
});
