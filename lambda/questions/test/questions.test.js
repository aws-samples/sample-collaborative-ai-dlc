import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;
const USER_ID = `u-${randomUUID()}`;

let handler;
let close;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  // If a developer has AWS_PROFILE set locally, the SDK preempts the env-var
  // creds planted by globalSetup and tries to resolve the profile via SSO/IMDS,
  // adding ~1s per getConnection call. Unset for the test process.
  vi.stubEnv('AWS_PROFILE', undefined);
  // The handler builds its neptune-lambda-client at import time from the env;
  // globalSetup has already pointed GREMLIN_PROTOCOL at the plain-ws container,
  // so useIam resolves to false and nothing is signed.
  ({ handler, close } = await import('../index.js'));

  // Direct gremlin connection for seeding. Uses the same partition so writes
  // are visible to the handler under test. The question write handlers are
  // gone (v1 is read-only), so all seeding goes straight through gremlin.
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close?.();
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
});

const STRUCTURED_QUESTIONS = [{ text: 'Which database?', type: 'single', options: [] }];

const ANSWER = { answers: [{ selectedOptions: [0], freeText: 'PostgreSQL' }] };

const addSprint = async (sprintId) => {
  const projectId = `p-${randomUUID()}`;
  await g.addV('Project').property('id', projectId).next();
  await g.addV('User').property('id', USER_ID).next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .V()
    .has('User', 'id', USER_ID)
    .as('u')
    .addE('HAS_MEMBER')
    .from_('p')
    .to('u')
    .property('role', 'owner')
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('Sprint')
    .property('id', sprintId)
    .as('s')
    .addE('HAS_SPRINT')
    .from_('p')
    .to('s')
    .next();
};

const addQuestion = async (sprintId, id, { structuredAnswer = '', answeredBy = '' } = {}) =>
  g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Question')
    .property('id', id)
    .property('agent', 'inception')
    .property('questions', JSON.stringify(STRUCTURED_QUESTIONS))
    .property('structured_answer', structuredAnswer)
    .property('draft_answer', '')
    .property('sprint_id', sprintId)
    .property('created_at', '2025-12-31T00:00:00.000Z')
    .property('answered_by', answeredBy)
    .as('q')
    .addE('CONTAINS')
    .from_('s')
    .to('q')
    .next();

const get = (sprintId, questionId, sub = USER_ID) =>
  handler({
    httpMethod: 'GET',
    pathParameters: { sprintId, questionId },
    requestContext: { authorizer: { claims: { sub } } },
  });

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /sprints/:sprintId/questions', () => {
  it('lists the sprint questions with unanswered fields defaulting to empty', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await get(sprintId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      {
        id: questionId,
        agent: 'inception',
        questions: STRUCTURED_QUESTIONS,
        sprintId,
        createdAt: '2025-12-31T00:00:00.000Z',
        answeredBy: '',
        answeredByName: '',
        answeredAt: '',
      },
    ]);
  });

  it('does not return questions belonging to a different sprint', async () => {
    const sprintId = `s-${randomUUID()}`;
    const otherSprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    await addSprint(otherSprintId);
    await addQuestion(otherSprintId, `q-${randomUUID()}`);

    const res = await get(sprintId);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('rejects a signed-in non-member', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);
    const res = await get(sprintId, undefined, 'outsider');
    expect(res.statusCode).toBe(403);
  });

  it('returns a single answered question with the parsed structuredAnswer', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId, {
      structuredAnswer: JSON.stringify(ANSWER),
      answeredBy: 'user-1',
    });

    const res = await get(sprintId, questionId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.structuredAnswer).toEqual(ANSWER);
    expect(body.answeredBy).toBe('user-1');
  });

  it('returns 404 for an unknown question id', async () => {
    const res = await get(`s-${randomUUID()}`, 'q-missing');
    expect(res.statusCode).toBe(404);
  });
});

describe('method routing (v1 is read-only)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('returns 405 for %s', async (httpMethod) => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await handler({
      httpMethod,
      pathParameters: { sprintId, questionId },
      body: JSON.stringify({ structuredAnswer: ANSWER }),
    });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});
