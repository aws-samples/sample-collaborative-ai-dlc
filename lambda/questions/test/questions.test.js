import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const QUESTIONS_TABLE = 'agent-questions-test';

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

const ddbMock = mockClient(DynamoDBDocumentClient);

// The fanout helper is mocked at module level — its internals (tokenExp
// filtering, best-effort sends) are covered by its consumers' own suites;
// here we only assert the questions lambda EMITS the server-origin hint.
vi.mock('../../shared/ws-fanout.js', () => ({ broadcastToSprintChannel: vi.fn() }));
const { broadcastToSprintChannel } = await import('../../shared/ws-fanout.js');

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
  // are visible to the handler under test.
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
  ddbMock.reset();
  vi.mocked(broadcastToSprintChannel).mockClear();
  ddbMock.on(UpdateCommand).resolves({});
  vi.stubEnv('AGENT_QUESTIONS_TABLE', QUESTIONS_TABLE);
  // Pin Date so answered_at / Date.now() are assertable. Don't fake
  // setTimeout/etc — gremlin's WebSocket driver uses real timers internally.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const STRUCTURED_QUESTIONS = [{ text: 'Which database?', type: 'single', options: [] }];

const addSprint = async (sprintId) => g.addV('Sprint').property('id', sprintId).next();

const addQuestion = async (sprintId, id) =>
  g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Question')
    .property('id', id)
    .property('agent', 'inception')
    .property('questions', JSON.stringify(STRUCTURED_QUESTIONS))
    .property('structured_answer', '')
    .property('draft_answer', '')
    .property('sprint_id', sprintId)
    .property('created_at', '2025-12-31T00:00:00.000Z')
    .as('q')
    .addE('CONTAINS')
    .from_('s')
    .to('q')
    .next();

const CLAIMS = {
  sub: 'user-1',
  'custom:display_name': 'Alice',
  email: 'alice@example.com',
};

const get = (sprintId, questionId) =>
  handler({ httpMethod: 'GET', pathParameters: { sprintId, questionId } });

const put = (sprintId, questionId, data, claims) =>
  handler({
    httpMethod: 'PUT',
    pathParameters: { sprintId, questionId },
    body: JSON.stringify(data),
    ...(claims ? { requestContext: { authorizer: { claims } } } : {}),
  });

const ANSWER = { answers: [{ selectedOptions: [0], freeText: 'PostgreSQL' }] };

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

  it('returns 404 for an unknown question id', async () => {
    const res = await get(`s-${randomUUID()}`, 'q-missing');
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT .../questions/:questionId — structured answer', () => {
  it('persists the answer with responder identity from the Cognito claims and maps it back', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { structuredAnswer: ANSWER }, CLAIMS);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      id: questionId,
      agent: 'inception',
      questions: STRUCTURED_QUESTIONS,
      structuredAnswer: ANSWER,
      sprintId,
      createdAt: '2025-12-31T00:00:00.000Z',
      answeredBy: 'user-1',
      answeredByName: 'Alice',
      answeredAt: NOW.toISOString(),
    });

    // Follow-up GET confirms the fields were persisted, not just echoed.
    const fetched = await get(sprintId, questionId);
    const body = JSON.parse(fetched.body);
    expect(body.answeredBy).toBe('user-1');
    expect(body.answeredByName).toBe('Alice');
    expect(body.answeredAt).toBe(NOW.toISOString());
  });

  it('syncs the answer and responder to DynamoDB so the agent poll loop sees it', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    await put(sprintId, questionId, { structuredAnswer: ANSWER }, CLAIMS);

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: QUESTIONS_TABLE,
      Key: { questionId },
      UpdateExpression:
        'SET #s = :s, structuredAnswer = :a, answeredAt = :t, answeredBy = :u, answeredByName = :n',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'answered',
        ':a': JSON.stringify(ANSWER),
        ':t': NOW.getTime(),
        ':u': 'user-1',
        ':n': 'Alice',
      },
    });
  });

  it('falls back to the email claim when no display name is set', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(
      sprintId,
      questionId,
      { structuredAnswer: ANSWER },
      { sub: 'user-2', email: 'bob@example.com' },
    );
    const body = JSON.parse(res.body);
    expect(body.answeredBy).toBe('user-2');
    expect(body.answeredByName).toBe('bob@example.com');
  });

  it('still records the answer with empty responder fields when no authorizer claims exist', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { structuredAnswer: ANSWER });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.structuredAnswer).toEqual(ANSWER);
    expect(body.answeredBy).toBe('');
    expect(body.answeredByName).toBe('');
    expect(body.answeredAt).toBe(NOW.toISOString());
  });

  it('skips the DynamoDB sync when AGENT_QUESTIONS_TABLE is not configured', async () => {
    vi.stubEnv('AGENT_QUESTIONS_TABLE', undefined);
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { structuredAnswer: ANSWER }, CLAIMS);
    expect(res.statusCode).toBe(200);
    expect(ddbMock).not.toHaveReceivedCommand(UpdateCommand);
  });
});

describe('PUT .../questions/:questionId — draft answer', () => {
  it('saves the draft without stamping a responder or flipping the DDB status', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { draftAnswer: ANSWER }, CLAIMS);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.draftAnswer).toEqual(ANSWER);
    expect(body.structuredAnswer).toBeUndefined();
    expect(body.answeredBy).toBe('');
    expect(body.answeredByName).toBe('');
    expect(body.answeredAt).toBe('');

    // Draft sync must not mark the DDB record as answered.
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: QUESTIONS_TABLE,
      Key: { questionId },
      UpdateExpression: 'SET draftAnswer = :d',
      ExpressionAttributeValues: { ':d': JSON.stringify(ANSWER) },
    });
    expect(ddbMock).toHaveReceivedCommandTimes(UpdateCommand, 1);
  });
});

describe('POST /sprints/:sprintId/questions', () => {
  it('creates a question wired to the sprint and echoes it back', async () => {
    const sprintId = `s-${randomUUID()}`;
    await addSprint(sprintId);

    const res = await handler({
      httpMethod: 'POST',
      pathParameters: { sprintId },
      body: JSON.stringify({ agent: 'review', questions: STRUCTURED_QUESTIONS }),
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(created).toEqual({
      id: expect.any(String),
      agent: 'review',
      questions: STRUCTURED_QUESTIONS,
      sprintId,
      createdAt: NOW.toISOString(),
    });

    const fetched = await get(sprintId);
    expect(JSON.parse(fetched.body)).toHaveLength(1);
    expect(JSON.parse(fetched.body)[0].id).toBe(created.id);
  });
});

describe('method routing', () => {
  it('returns 405 for an unsupported method', async () => {
    const res = await handler({ httpMethod: 'PATCH', pathParameters: {} });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});

describe('server-origin question.answered fanout (discussions plan §4b, D10)', () => {
  it('emits the reload hint to the sprint channel after persisting the answer', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { structuredAnswer: ANSWER }, CLAIMS);
    expect(res.statusCode).toBe(200);

    expect(broadcastToSprintChannel).toHaveBeenCalledExactlyOnceWith(sprintId, {
      action: 'question.answered',
      sprintId,
      questionId,
    });
  });

  it('does NOT emit on draft-answer saves (status stays pending)', async () => {
    const sprintId = `s-${randomUUID()}`;
    const questionId = `q-${randomUUID()}`;
    await addSprint(sprintId);
    await addQuestion(sprintId, questionId);

    const res = await put(sprintId, questionId, { draftAnswer: ANSWER }, CLAIMS);
    expect(res.statusCode).toBe(200);
    expect(broadcastToSprintChannel).not.toHaveBeenCalled();
  });
});
