import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import shared from '../../shared/realtime-token.js';

const { verifyRealtimeToken } = shared;

const NOW = new Date('2026-01-01T00:00:00.000Z');
const SECRET = 'test-doc-secret';
const LOCKS_TABLE = 'discussion-locks-test';
const CONNECTIONS_TABLE = 'connections-test';
const READ_STATE_TABLE = 'discussion-read-state-test';

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);

// ─── In-memory DynamoDB conditional-write fake for the locks table ───
//
// The guard protocol is all conditional writes. This fake
// implements exactly the condition expressions the handler uses, against an
// in-memory Map, so the concurrency state machine is testable without a
// DynamoDB container. Connections-table queries are mocked separately.
const lockStore = new Map();
const readStateStore = new Map();
let connectionItems = [];

const condFail = () => {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
};

const installDdbFake = () => {
  ddbMock.on(PutCommand).callsFake(async (input) => {
    if (input.TableName === READ_STATE_TABLE) {
      readStateStore.set(`${input.Item.userId}|${input.Item.discussionId}`, { ...input.Item });
      return {};
    }
    if (input.TableName !== LOCKS_TABLE) return {};
    const item = input.Item;
    const existing = lockStore.get(item.lockId);
    const cond = input.ConditionExpression || '';
    if (cond && existing) {
      const now = input.ExpressionAttributeValues?.[':now'];
      let ok = false;
      if (cond.includes('guardState = :pending')) {
        ok = existing.guardState === 'pending' && existing.expiresAt < now;
      } else if (cond.includes('expiresAt < :now')) {
        ok = existing.expiresAt < now;
      }
      if (!ok) throw condFail();
    }
    lockStore.set(item.lockId, { ...item });
    return {};
  });
  ddbMock.on(GetCommand).callsFake(async (input) => {
    if (input.TableName !== LOCKS_TABLE) return {};
    const item = lockStore.get(input.Key.lockId);
    return item ? { Item: { ...item } } : {};
  });
  ddbMock.on(UpdateCommand).callsFake(async (input) => {
    if (input.TableName !== LOCKS_TABLE) return {};
    const item = lockStore.get(input.Key.lockId);
    if (input.ConditionExpression?.includes('ownerToken = :token')) {
      if (!item || item.ownerToken !== input.ExpressionAttributeValues[':token']) {
        throw condFail();
      }
    }
    item.guardState = input.ExpressionAttributeValues[':complete'];
    item.expiresAt = input.ExpressionAttributeValues[':exp'];
    return {};
  });
  ddbMock.on(DeleteCommand).callsFake(async (input) => {
    if (input.TableName === LOCKS_TABLE) lockStore.delete(input.Key.lockId);
    return {};
  });
  ddbMock.on(QueryCommand).callsFake(async (input) => {
    if (input.TableName === CONNECTIONS_TABLE) {
      if (input.IndexName === 'UserIdIndex') {
        const uid = input.ExpressionAttributeValues[':uid'];
        return { Items: connectionItems.filter((c) => c.userId === uid) };
      }
      return { Items: connectionItems };
    }
    if (input.TableName === READ_STATE_TABLE) {
      const uid = input.ExpressionAttributeValues[':uid'];
      const sid = input.ExpressionAttributeValues[':sid'];
      return {
        Items: [...readStateStore.values()].filter((r) => r.userId === uid && r.sprintId === sid),
      };
    }
    return { Items: [] };
  });
};

let handler;
let close;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler, close } = await import('../index.js'));

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
  apiMock.reset();
  agentcoreMock.reset();
  lockStore.clear();
  readStateStore.clear();
  connectionItems = [];
  installDdbFake();
  apiMock.on(PostToConnectionCommand).resolves({});
  vi.stubEnv('REALTIME_DOC_SECRET', SECRET);
  vi.stubEnv('LOCKS_TABLE', LOCKS_TABLE);
  vi.stubEnv('READ_STATE_TABLE', READ_STATE_TABLE);
  vi.stubEnv('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/test');
  // Pin Date so timestamps/expiries are assertable. Don't fake setTimeout —
  // the guard-poll loops and gremlin's WebSocket driver need real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const nowSec = () => Math.floor(NOW.getTime() / 1000);

const MEMBER_SUB = 'member-user';
const ADMIN_SUB = 'admin-user';
const OUTSIDER_SUB = 'outsider-user';

// ─── Seed helpers ───

const seedProject = async ({ projectId, sprintId, members = [] }) => {
  await g.addV('Project').property('id', projectId).next();
  if (sprintId) {
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
  }
  for (const { sub, role } of members) {
    await g.addV('User').property('id', sub).property('email', `${sub}@example.com`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .V()
      .has('User', 'id', sub)
      .as('u')
      .addE('HAS_MEMBER')
      .property('role', role)
      .from_('p')
      .to('u')
      .next();
  }
};

const seedDefaultProject = async () => {
  const projectId = randomUUID();
  const sprintId = randomUUID();
  await seedProject({
    projectId,
    sprintId,
    members: [
      { sub: MEMBER_SUB, role: 'member' },
      { sub: ADMIN_SUB, role: 'admin' },
    ],
  });
  return { projectId, sprintId };
};

const seedQuestion = async (sprintId, questionId, title = 'Which database?') =>
  g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Question')
    .property('id', questionId)
    .property('title', title)
    .property('sprint_id', sprintId)
    .as('q')
    .addE('CONTAINS')
    .from_('s')
    .to('q')
    .next();

const seedDiscussion = async (sprintId, discussionId, { entityType = 'sprint', createdAt } = {}) =>
  g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Discussion')
    .property('id', discussionId)
    .property('entity_type', entityType)
    .property('entity_id', sprintId)
    .property('entity_title', '')
    .property('sprint_id', sprintId)
    .property('status', 'open')
    .property('created_at', createdAt || NOW.toISOString())
    .property('created_by', MEMBER_SUB)
    .property('created_by_name', 'Member')
    .property('last_message_at', createdAt || NOW.toISOString())
    .as('d')
    .addE('HAS_DISCUSSION')
    .from_('s')
    .to('d')
    .select('s')
    .addE('DISCUSSES')
    .from_('d')
    .to('s')
    .next();

const seedMessage = async (
  discussionId,
  sprintId,
  { id, content, authorId = MEMBER_SUB, mentions = [], createdAt, updatedAt },
) =>
  g
    .V()
    .has('Discussion', 'id', discussionId)
    .as('d')
    .addV('DiscussionMessage')
    .property('id', id)
    .property('content', content)
    .property('author_id', authorId)
    .property('author_name', 'Member')
    .property('author_type', 'user')
    .property('mentions', JSON.stringify(mentions))
    .property('created_at', createdAt)
    .property('updated_at', updatedAt || createdAt)
    .property('discussion_id', discussionId)
    .property('sprint_id', sprintId)
    .as('m')
    .addE('HAS_MESSAGE')
    .from_('d')
    .to('m')
    .next();

const payloadHashOf = (content, mentions = []) =>
  createHash('sha256')
    .update(JSON.stringify({ content, mentions: [...new Set(mentions)].toSorted() }))
    .digest('hex');

// ─── Request helpers ───

const claimsFor = (sub) => ({ sub, email: `${sub}@example.com` });

const call = (method, resource, { pathParameters, body, sub = MEMBER_SUB, query } = {}) =>
  handler({
    httpMethod: method,
    resource,
    pathParameters,
    queryStringParameters: query,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(sub ? { requestContext: { authorizer: { claims: claimsFor(sub) } } } : {}),
  });

const listDiscussions = (sprintId, opts = {}) =>
  call('GET', '/api/sprints/{sprintId}/discussions', { pathParameters: { sprintId }, ...opts });

const createDiscussion = (sprintId, body, opts = {}) =>
  call('POST', '/api/sprints/{sprintId}/discussions', {
    pathParameters: { sprintId },
    body,
    ...opts,
  });

const listMessages = (sprintId, discussionId, query, opts = {}) =>
  call('GET', '/api/sprints/{sprintId}/discussions/{discussionId}/messages', {
    pathParameters: { sprintId, discussionId },
    query,
    ...opts,
  });

const postMessage = (sprintId, discussionId, body, opts = {}) =>
  call('POST', '/api/sprints/{sprintId}/discussions/{discussionId}/messages', {
    pathParameters: { sprintId, discussionId },
    body,
    ...opts,
  });

const postToken = ({ sprintId, projectId, sub = MEMBER_SUB }) =>
  call(
    'POST',
    sprintId
      ? '/api/sprints/{sprintId}/realtime-token'
      : '/api/projects/{projectId}/realtime-token',
    { pathParameters: sprintId ? { sprintId } : { projectId }, sub },
  );

const json = (res) => JSON.parse(res.body);

// =============================================================================
// Realtime token issuance
// =============================================================================

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /sprints/{sprintId}/realtime-token', () => {
  it('issues a sprint+project scoped token for a project member', async () => {
    const { projectId, sprintId } = await seedDefaultProject();

    const res = await postToken({ sprintId });
    expect(res.statusCode).toBe(200);

    const body = json(res);
    expect(body.scopes).toEqual([`sprint:${sprintId}`, `project:${projectId}`]);
    expect(body.exp).toBe(nowSec() + 600);

    const verified = verifyRealtimeToken(body.token, SECRET, { now: NOW.getTime() });
    expect(verified.ok).toBe(true);
    expect(verified.payload.sub).toBe(MEMBER_SUB);
  });

  it('returns 403 for a signed-in non-member (token issuance is membership-gated)', async () => {
    const { sprintId } = await seedDefaultProject();
    expect((await postToken({ sprintId, sub: OUTSIDER_SUB })).statusCode).toBe(403);
  });

  it('returns 404 for an unknown sprint', async () => {
    expect((await postToken({ sprintId: randomUUID() })).statusCode).toBe(404);
  });

  it('returns 401 without authenticated claims', async () => {
    const res = await handler({
      httpMethod: 'POST',
      resource: '/api/sprints/{sprintId}/realtime-token',
      pathParameters: { sprintId: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /projects/{projectId}/realtime-token', () => {
  it('issues a project-scoped token for a member', async () => {
    const { projectId } = await seedDefaultProject();

    const res = await postToken({ projectId });
    expect(res.statusCode).toBe(200);
    expect(json(res).scopes).toEqual([`project:${projectId}`]);
  });

  it('returns 403 for a non-member or unknown project', async () => {
    const { projectId } = await seedDefaultProject();
    expect((await postToken({ projectId, sub: OUTSIDER_SUB })).statusCode).toBe(403);
    expect((await postToken({ projectId: randomUUID() })).statusCode).toBe(403);
  });
});

// =============================================================================
// POST /discussions — atomic get-or-create (DynamoDB creation guard)
// =============================================================================

describe('POST /sprints/{sprintId}/discussions', () => {
  it('creates a sprint-anchored thread with DISCUSSES + HAS_DISCUSSION edges and a TimelineEvent', async () => {
    const { sprintId } = await seedDefaultProject();

    const res = await createDiscussion(sprintId, { entityType: 'sprint' });
    expect(res.statusCode).toBe(200);
    const d = json(res);
    expect(d.id).toMatch(/^disc-/);
    expect(d.entityType).toBe('sprint');
    expect(d.entityId).toBe(sprintId);
    expect(d.status).toBe('open');
    expect(d.createdBy).toBe(MEMBER_SUB);
    expect(d.messageCount).toBe(0);

    const edges = await g.V().has('Discussion', 'id', d.id).bothE().label().toList();
    expect(edges.toSorted()).toEqual(['DISCUSSES', 'HAS_DISCUSSION']);

    const events = await g
      .V()
      .has('TimelineEvent', 'type', 'discussion_started')
      .values('sprint_id')
      .toList();
    expect(events).toEqual([sprintId]);
  });

  it('creates a question-anchored thread with the anchor title denormalized', async () => {
    const { sprintId } = await seedDefaultProject();
    const questionId = randomUUID();
    await seedQuestion(sprintId, questionId, 'Which database?');

    const res = await createDiscussion(sprintId, { entityType: 'question', entityId: questionId });
    expect(res.statusCode).toBe(200);
    const d = json(res);
    expect(d.entityType).toBe('question');
    expect(d.entityId).toBe(questionId);
    expect(d.entityTitle).toBe('Which database?');
  });

  it('is get-or-create: a second call returns the SAME thread (fast path, no lock)', async () => {
    const { sprintId } = await seedDefaultProject();

    const first = json(await createDiscussion(sprintId, { entityType: 'sprint' }));
    const second = json(await createDiscussion(sprintId, { entityType: 'sprint' }));
    expect(second.id).toBe(first.id);

    const count = await g.V().hasLabel('Discussion').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('distinguishes sprint and inception threads on the same anchor vertex', async () => {
    const { sprintId } = await seedDefaultProject();

    const sprint = json(await createDiscussion(sprintId, { entityType: 'sprint' }));
    const inception = json(await createDiscussion(sprintId, { entityType: 'inception' }));
    expect(inception.id).not.toBe(sprint.id);
    expect(inception.entityType).toBe('inception');
  });

  it('rejects an invalid entityType and a missing/foreign anchor', async () => {
    const { sprintId } = await seedDefaultProject();

    expect(
      (await createDiscussion(sprintId, { entityType: 'banana', entityId: 'x' })).statusCode,
    ).toBe(400);
    expect(
      (await createDiscussion(sprintId, { entityType: 'question', entityId: randomUUID() }))
        .statusCode,
    ).toBe(404);

    // Anchor in ANOTHER sprint must not be reachable from this one.
    const other = await seedDefaultProject();
    const foreignQuestion = randomUUID();
    await seedQuestion(other.sprintId, foreignQuestion);
    expect(
      (await createDiscussion(sprintId, { entityType: 'question', entityId: foreignQuestion }))
        .statusCode,
    ).toBe(404);
  });

  it('returns 403 for non-members', async () => {
    const { sprintId } = await seedDefaultProject();
    expect(
      (await createDiscussion(sprintId, { entityType: 'sprint' }, { sub: OUTSIDER_SUB }))
        .statusCode,
    ).toBe(403);
  });

  it('concurrent creation produces exactly one vertex', async () => {
    const { sprintId } = await seedDefaultProject();

    const results = await Promise.all([
      createDiscussion(sprintId, { entityType: 'sprint' }),
      createDiscussion(sprintId, { entityType: 'sprint' }),
      createDiscussion(sprintId, { entityType: 'sprint' }),
    ]);

    const ids = new Set();
    for (const res of results) {
      // Every caller either gets the thread or a transparent-retry 409.
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 200) ids.add(json(res).id);
      else expect(json(res).reason).toBe('creation_in_progress');
    }
    expect(ids.size).toBe(1);

    const count = await g.V().hasLabel('Discussion').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('slow-but-healthy winner: guard held past loser retries → 409 creation_in_progress {retryAfter}', async () => {
    const { sprintId } = await seedDefaultProject();
    // Simulate a winner mid-creation: guard held, no vertex yet.
    lockStore.set(`create:${sprintId}:sprint:${sprintId}`, {
      lockId: `create:${sprintId}:sprint:${sprintId}`,
      kind: 'creation',
      expiresAt: nowSec() + 25,
    });

    const res = await createDiscussion(sprintId, { entityType: 'sprint' });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ reason: 'creation_in_progress', retryAfter: 1 });

    const count = await g.V().hasLabel('Discussion').count().next();
    expect(Number(count.value)).toBe(0);
  });

  it('crashed winner: expired guard → next caller takes over and creates', async () => {
    const { sprintId } = await seedDefaultProject();
    lockStore.set(`create:${sprintId}:sprint:${sprintId}`, {
      lockId: `create:${sprintId}:sprint:${sprintId}`,
      kind: 'creation',
      expiresAt: nowSec() - 5,
    });

    const res = await createDiscussion(sprintId, { entityType: 'sprint' });
    expect(res.statusCode).toBe(200);
    expect(json(res).id).toMatch(/^disc-/);
  });
});

// =============================================================================
// GET /discussions — list
// =============================================================================

describe('GET /sprints/{sprintId}/discussions', () => {
  it('lists threads with computed messageCount, sorted by last_message_at desc', async () => {
    const { sprintId } = await seedDefaultProject();
    await seedDiscussion(sprintId, 'disc-old', { createdAt: '2025-12-01T00:00:00.000Z' });
    await seedDiscussion(sprintId, 'disc-new', {
      entityType: 'inception',
      createdAt: '2025-12-20T00:00:00.000Z',
    });
    await seedMessage('disc-old', sprintId, {
      id: 'dm-1-aaaaaaaa',
      content: 'hi',
      createdAt: '2025-12-02T00:00:00.000Z',
    });

    const res = await listDiscussions(sprintId);
    expect(res.statusCode).toBe(200);
    const list = json(res);
    expect(list.map((d) => d.id)).toEqual(['disc-new', 'disc-old']);
    expect(list.find((d) => d.id === 'disc-old').messageCount).toBe(1);
    expect(list.find((d) => d.id === 'disc-new').messageCount).toBe(0);
  });

  it('returns 403 for non-members and 404 for unknown sprints', async () => {
    const { sprintId } = await seedDefaultProject();
    expect((await listDiscussions(sprintId, { sub: OUTSIDER_SUB })).statusCode).toBe(403);
    expect((await listDiscussions(randomUUID())).statusCode).toBe(404);
  });
});

// =============================================================================
// POST /messages — stateful message guard (conditional writes)
// =============================================================================

describe('POST .../messages — append + guard state matrix', () => {
  let sprintId;
  const DISC = 'disc-under-test';
  const MSG_ID = 'dm-1700000000-abcd1234';
  const CONTENT = 'Hello **world**';

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, DISC);
  });

  const guardKey = () => `msg:${DISC}:${MSG_ID}`;

  it('persists the message, bumps last_message_at, marks the guard complete, returns 201', async () => {
    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(201);
    const m = json(res);
    expect(m).toMatchObject({
      id: MSG_ID,
      content: CONTENT,
      authorId: MEMBER_SUB,
      authorType: 'user',
      discussionId: DISC,
      sprintId,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    const lastMessageAt = await g
      .V()
      .has('Discussion', 'id', DISC)
      .values('last_message_at')
      .next();
    expect(lastMessageAt.value).toBe(NOW.toISOString());

    const guard = lockStore.get(guardKey());
    expect(guard.guardState).toBe('complete');
    expect(guard.expiresAt).toBe(nowSec() + 3600);
  });

  it('idempotent retry (same id + author + payload) echoes 200 off the complete guard', async () => {
    await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(200);
    expect(json(res).content).toBe(CONTENT);

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('same id + different content → 409 duplicate_message_id', async () => {
    await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: 'something else' });
    expect(res.statusCode).toBe(409);
    expect(json(res).reason).toBe('duplicate_message_id');
  });

  it('same id + same content + DIFFERENT mentions → 409, not an idempotent echo', async () => {
    await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT, mentions: [] });
    const res = await postMessage(sprintId, DISC, {
      id: MSG_ID,
      content: CONTENT,
      mentions: [ADMIN_SUB],
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).reason).toBe('duplicate_message_id');
  });

  it('same id + different author → 409 duplicate_message_id', async () => {
    await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    const res = await postMessage(
      sprintId,
      DISC,
      { id: MSG_ID, content: CONTENT },
      { sub: ADMIN_SUB },
    );
    expect(res.statusCode).toBe(409);
    expect(json(res).reason).toBe('duplicate_message_id');
  });

  it('two concurrent same-id POSTs → one vertex; loser echoes', async () => {
    const [a, b] = await Promise.all([
      postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT }),
      postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT }),
    ]);

    const statuses = [a.statusCode, b.statusCode].toSorted();
    // One 201 (winner); the other 200 (echo) or 409 message_in_progress
    // (transparent client retry) depending on interleaving.
    expect(statuses[1]).toBeLessThanOrEqual(409);
    expect(statuses).toContain(201);

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('winner still in flight (pending, not expired, vertex not visible) → 409 message_in_progress {retryAfter}', async () => {
    lockStore.set(guardKey(), {
      lockId: guardKey(),
      kind: 'message',
      ownerToken: 'someone-else',
      guardState: 'pending',
      authorId: MEMBER_SUB,
      payloadHash: payloadHashOf(CONTENT),
      expiresAt: nowSec() + 100,
    });

    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ reason: 'message_in_progress', retryAfter: 1 });
  });

  it('crashed winner BEFORE the Neptune write: pending + expired + no vertex → takeover persists', async () => {
    lockStore.set(guardKey(), {
      lockId: guardKey(),
      kind: 'message',
      ownerToken: 'dead-winner',
      guardState: 'pending',
      authorId: MEMBER_SUB,
      payloadHash: payloadHashOf(CONTENT),
      expiresAt: nowSec() - 10,
    });

    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(201);

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
    expect(lockStore.get(guardKey()).guardState).toBe('complete');
  });

  it('crashed winner AFTER the Neptune write: takeover skips the write, marks complete, echoes', async () => {
    await seedMessage(DISC, sprintId, {
      id: MSG_ID,
      content: CONTENT,
      createdAt: NOW.toISOString(),
    });
    lockStore.set(guardKey(), {
      lockId: guardKey(),
      kind: 'message',
      ownerToken: 'dead-winner',
      guardState: 'pending',
      authorId: MEMBER_SUB,
      payloadHash: payloadHashOf(CONTENT),
      expiresAt: nowSec() - 10,
    });

    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(200);
    expect(json(res).content).toBe(CONTENT);

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
    expect(lockStore.get(guardKey()).guardState).toBe('complete');
  });

  it('post-TTL retry (guard gone, vertex exists): scoped Neptune check → echo or 409', async () => {
    await seedMessage(DISC, sprintId, {
      id: MSG_ID,
      content: CONTENT,
      createdAt: NOW.toISOString(),
    });
    // No guard row at all — TTL cleaned it up ≥1 h ago.

    const echoRes = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(echoRes.statusCode).toBe(200);

    lockStore.clear();
    const conflictRes = await postMessage(sprintId, DISC, { id: MSG_ID, content: 'different' });
    expect(conflictRes.statusCode).toBe(409);
    expect(json(conflictRes).reason).toBe('duplicate_message_id');

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('ownerToken mismatch on the complete-transition is a no-op (message still returned)', async () => {
    // Simulate a takeover stealing the guard mid-write: every complete-
    // transition fails its ownerToken condition.
    ddbMock.on(UpdateCommand).callsFake(async () => {
      throw condFail();
    });

    const res = await postMessage(sprintId, DISC, { id: MSG_ID, content: CONTENT });
    expect(res.statusCode).toBe(201);

    const count = await g.V().hasLabel('DiscussionMessage').count().next();
    expect(Number(count.value)).toBe(1);
  });

  it('validates id format, content presence, and the 10k content cap', async () => {
    expect(
      (await postMessage(sprintId, DISC, { id: 'not-a-dm-id', content: 'x' })).statusCode,
    ).toBe(400);
    expect((await postMessage(sprintId, DISC, { id: MSG_ID, content: '   ' })).statusCode).toBe(
      400,
    );
    expect(
      (await postMessage(sprintId, DISC, { id: MSG_ID, content: 'x'.repeat(10_001) })).statusCode,
    ).toBe(400);
  });

  it('strips non-member mentions, keeps member mentions (canonical sorted/deduped)', async () => {
    const res = await postMessage(sprintId, DISC, {
      id: MSG_ID,
      content: CONTENT,
      mentions: [OUTSIDER_SUB, ADMIN_SUB, ADMIN_SUB, MEMBER_SUB],
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).mentions).toEqual([ADMIN_SUB, MEMBER_SUB].toSorted());

    const stored = await g.V().has('DiscussionMessage', 'id', MSG_ID).values('mentions').next();
    expect(JSON.parse(stored.value)).toEqual([ADMIN_SUB, MEMBER_SUB].toSorted());
  });

  it('returns 404 for a discussion outside the sprint and 403 for non-members', async () => {
    expect(
      (await postMessage(sprintId, 'disc-nonexistent', { id: MSG_ID, content: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (await postMessage(sprintId, DISC, { id: MSG_ID, content: 'x' }, { sub: OUTSIDER_SUB }))
        .statusCode,
    ).toBe(403);
  });
});

// =============================================================================
// Takeover-safety invariant — init assertion pin
// =============================================================================

describe('takeover-safety invariant', () => {
  it('module init fails fast when the lambda timeout reaches the pending window', async () => {
    vi.resetModules();
    vi.stubEnv('LAMBDA_TIMEOUT_SECONDS', '150');
    await expect(import('../index.js')).rejects.toThrow(/Takeover-safety invariant/);
    vi.stubEnv('LAMBDA_TIMEOUT_SECONDS', '');
    vi.resetModules();
  });
});

// =============================================================================
// GET /messages — keyset pagination + change delta
// =============================================================================

describe('GET .../messages — pagination and change delta', () => {
  let sprintId;
  const DISC = 'disc-paging';
  const t = (n) => `2025-12-0${n}T00:00:00.000Z`;

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, DISC);
    // Five messages, m3a/m3b share a timestamp (tie-break by id).
    await seedMessage(DISC, sprintId, { id: 'dm-1-aaaaaaaa', content: 'm1', createdAt: t(1) });
    await seedMessage(DISC, sprintId, { id: 'dm-2-aaaaaaaa', content: 'm2', createdAt: t(2) });
    await seedMessage(DISC, sprintId, { id: 'dm-3-aaaaaaaa', content: 'm3a', createdAt: t(3) });
    await seedMessage(DISC, sprintId, { id: 'dm-3-bbbbbbbb', content: 'm3b', createdAt: t(3) });
    await seedMessage(DISC, sprintId, { id: 'dm-4-aaaaaaaa', content: 'm4', createdAt: t(4) });
  });

  it('seeds the latest page in display order with hasMore', async () => {
    const res = await listMessages(sprintId, DISC, { limit: '3' });
    expect(res.statusCode).toBe(200);
    const { messages, hasMore } = json(res);
    expect(messages.map((m) => m.id)).toEqual(['dm-3-aaaaaaaa', 'dm-3-bbbbbbbb', 'dm-4-aaaaaaaa']);
    expect(hasMore).toBe(true);
  });

  it('?before pages older history with (createdAt, id) keyset incl. tie-breaks', async () => {
    const res = await listMessages(sprintId, DISC, { before: `${t(3)},dm-3-bbbbbbbb`, limit: '2' });
    const { messages, hasMore } = json(res);
    expect(messages.map((m) => m.id)).toEqual(['dm-2-aaaaaaaa', 'dm-3-aaaaaaaa']);
    expect(hasMore).toBe(true);

    const rest = json(await listMessages(sprintId, DISC, { before: `${t(2)},dm-2-aaaaaaaa` }));
    expect(rest.messages.map((m) => m.id)).toEqual(['dm-1-aaaaaaaa']);
    expect(rest.hasMore).toBe(false);
  });

  it('?after returns the change delta on (updatedAt, id) — including redactions of OLDER messages', async () => {
    // Simulate a redaction of m1: content replaced, updated_at bumped.
    await g
      .V()
      .has('DiscussionMessage', 'id', 'dm-1-aaaaaaaa')
      .property(gremlin.process.cardinality.single, 'content', '[redacted by Admin]')
      .property(gremlin.process.cardinality.single, 'redacted', 'true')
      .property(gremlin.process.cardinality.single, 'updated_at', t(5))
      .next();

    const res = await listMessages(sprintId, DISC, { after: `${t(4)},dm-4-aaaaaaaa` });
    const { messages, hasMore } = json(res);
    expect(messages.map((m) => m.id)).toEqual(['dm-1-aaaaaaaa']);
    expect(messages[0].redacted).toBe(true);
    expect(messages[0].content).toBe('[redacted by Admin]');
    expect(hasMore).toBe(false);
  });

  it('caps the limit at 200 and rejects malformed/conflicting cursors', async () => {
    expect((await listMessages(sprintId, DISC, { limit: '5000' })).statusCode).toBe(200);
    expect((await listMessages(sprintId, DISC, { before: 'garbage' })).statusCode).toBe(400);
    expect(
      (await listMessages(sprintId, DISC, { before: `${t(1)},x`, after: `${t(1)},x` })).statusCode,
    ).toBe(400);
  });

  it('enforces membership and sprint scoping', async () => {
    expect((await listMessages(sprintId, DISC, {}, { sub: OUTSIDER_SUB })).statusCode).toBe(403);

    const other = await seedDefaultProject();
    expect((await listMessages(other.sprintId, DISC, {})).statusCode).toBe(404);
  });
});

// =============================================================================
// Server-driven fanout
// =============================================================================

describe('discussion.message fanout', () => {
  it('broadcasts the FULL persisted message to live sprint connections, excluding expired tokens', async () => {
    vi.stubEnv('CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', 'https://fake.execute-api.eu-west-1.amazonaws.com/ws');
    const { sprintId } = await seedDefaultProject();
    await seedDiscussion(sprintId, 'disc-fanout');
    connectionItems = [
      { connectionId: 'conn-live', tokenExp: nowSec() + 300 },
      { connectionId: 'conn-expired', tokenExp: nowSec() - 10 },
      { connectionId: 'conn-legacy' },
    ];

    const res = await postMessage(sprintId, 'disc-fanout', {
      id: 'dm-1700000000-fanout01',
      content: 'broadcast me',
    });
    expect(res.statusCode).toBe(201);

    const recipients = apiMock
      .commandCalls(PostToConnectionCommand)
      .map((c) => c.args[0].input.ConnectionId)
      .toSorted();
    expect(recipients).toEqual(['conn-legacy', 'conn-live']);

    const payload = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
    expect(payload.action).toBe('discussion.message');
    expect(payload.discussionId).toBe('disc-fanout');
    expect(payload.message).toMatchObject({
      id: 'dm-1700000000-fanout01',
      content: 'broadcast me',
      authorId: MEMBER_SUB,
    });
  });
});

// =============================================================================
// PUT /discussions/{discussionId} — resolve / reopen
// =============================================================================

describe('PUT .../discussions/{discussionId} — resolve and reopen', () => {
  let sprintId;
  const DISC = 'disc-resolve';

  const putDiscussion = (body, opts = {}) =>
    call('PUT', '/api/sprints/{sprintId}/discussions/{discussionId}', {
      pathParameters: { sprintId, discussionId: DISC },
      body,
      ...opts,
    });

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, DISC);
    await seedMessage(DISC, sprintId, {
      id: 'dm-1-outcome01',
      content: 'the decision',
      createdAt: NOW.toISOString(),
    });
  });

  it('resolves with summary + outcome pointer + audit fields and emits discussion.updated + TimelineEvent', async () => {
    vi.stubEnv('CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', 'https://fake.execute-api.eu-west-1.amazonaws.com/ws');
    connectionItems = [{ connectionId: 'conn-1', tokenExp: nowSec() + 300 }];

    const res = await putDiscussion({
      status: 'resolved',
      resolutionSummary: 'We will use PostgreSQL',
      outcomeMessageId: 'dm-1-outcome01',
    });
    expect(res.statusCode).toBe(200);
    const d = json(res);
    expect(d).toMatchObject({
      status: 'resolved',
      resolutionSummary: 'We will use PostgreSQL',
      outcomeMessageId: 'dm-1-outcome01',
      resolvedBy: MEMBER_SUB,
      resolvedAt: NOW.toISOString(),
    });

    const events = await g
      .V()
      .has('TimelineEvent', 'type', 'discussion_resolved')
      .values('detail')
      .toList();
    expect(events).toEqual(['We will use PostgreSQL']);

    const payload = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
    expect(payload).toMatchObject({
      action: 'discussion.updated',
      discussionId: DISC,
      status: 'resolved',
      resolutionSummary: 'We will use PostgreSQL',
    });
  });

  it('any member may resolve (audited); reopen clears the resolution fields', async () => {
    await putDiscussion({ status: 'resolved', resolutionSummary: 'done' });

    const res = await putDiscussion({ status: 'open' }, { sub: ADMIN_SUB });
    expect(res.statusCode).toBe(200);
    const d = json(res);
    expect(d.status).toBe('open');
    expect(d.resolvedBy).toBeUndefined();
    expect(d.resolutionSummary).toBeUndefined();
  });

  it('rejects an outcomeMessageId from outside the thread and invalid statuses', async () => {
    expect(
      (await putDiscussion({ status: 'resolved', outcomeMessageId: 'dm-1-elsewhere' })).statusCode,
    ).toBe(400);
    expect((await putDiscussion({ status: 'closed' })).statusCode).toBe(400);
  });

  it('enforces membership and sprint scoping', async () => {
    expect((await putDiscussion({ status: 'resolved' }, { sub: OUTSIDER_SUB })).statusCode).toBe(
      403,
    );
    const other = await seedDefaultProject();
    const res = await call('PUT', '/api/sprints/{sprintId}/discussions/{discussionId}', {
      pathParameters: { sprintId: other.sprintId, discussionId: DISC },
      body: { status: 'resolved' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// POST .../messages/{messageId}/redact — admin/owner moderation
// =============================================================================

describe('POST .../redact', () => {
  let sprintId;
  const DISC = 'disc-redact';
  const MSG = 'dm-1-redactme1';

  const redact = (opts = {}) =>
    call('POST', '/api/sprints/{sprintId}/discussions/{discussionId}/messages/{messageId}/redact', {
      ...opts,
      pathParameters: { sprintId, discussionId: DISC, messageId: MSG, ...opts.pathParameters },
    });

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, DISC);
    await seedMessage(DISC, sprintId, {
      id: MSG,
      content: 'the secret password is hunter2',
      createdAt: '2025-12-01T00:00:00.000Z',
    });
  });

  it('admin redact PURGES the content, preserves the audit, bumps updated_at, broadcasts', async () => {
    vi.stubEnv('CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', 'https://fake.execute-api.eu-west-1.amazonaws.com/ws');
    connectionItems = [{ connectionId: 'conn-1', tokenExp: nowSec() + 300 }];

    const res = await redact({ sub: ADMIN_SUB });
    expect(res.statusCode).toBe(200);
    const m = json(res);
    expect(m.content).toBe('[redacted by admin-user@example.com]');
    expect(m.redacted).toBe(true);
    expect(m.redactedBy).toBe(ADMIN_SUB);
    expect(m.updatedAt).toBe(NOW.toISOString());
    expect(m.createdAt).toBe('2025-12-01T00:00:00.000Z');

    // Original content is gone from Neptune.
    const stored = await g.V().has('DiscussionMessage', 'id', MSG).values('content').toList();
    expect(stored).toEqual(['[redacted by admin-user@example.com]']);

    const payload = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
    expect(payload).toMatchObject({
      action: 'discussion.message.redacted',
      discussionId: DISC,
      messageId: MSG,
      updatedAt: NOW.toISOString(),
    });

    const events = await g
      .V()
      .has('TimelineEvent', 'type', 'message_redacted')
      .values('user_id')
      .toList();
    expect(events).toEqual([ADMIN_SUB]);
  });

  it('members cannot redact (403); non-members 403; unknown message 404', async () => {
    expect((await redact({ sub: MEMBER_SUB })).statusCode).toBe(403);
    expect((await redact({ sub: OUTSIDER_SUB })).statusCode).toBe(403);
    expect(
      (await redact({ sub: ADMIN_SUB, pathParameters: { messageId: 'dm-1-missing01' } }))
        .statusCode,
    ).toBe(404);
  });

  it('the redaction appears in the ?after change delta (updated_at bump)', async () => {
    await redact({ sub: ADMIN_SUB });

    const res = await listMessages(sprintId, DISC, {
      after: `2025-12-01T00:00:00.000Z,${MSG}`,
    });
    const { messages } = json(res);
    expect(messages.map((m) => m.id)).toEqual([MSG]);
    expect(messages[0].redacted).toBe(true);
  });
});

// =============================================================================
// Read cursors + unread counts (composite cursor)
// =============================================================================

describe('read cursors and unread counts', () => {
  let sprintId;
  const DISC = 'disc-unread';
  const t = (n) => `2025-12-0${n}T00:00:00.000Z`;

  const putRead = (body, opts = {}) =>
    call('PUT', '/api/sprints/{sprintId}/discussions/{discussionId}/read', {
      pathParameters: { sprintId, discussionId: DISC },
      body,
      ...opts,
    });

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, DISC);
    await seedMessage(DISC, sprintId, { id: 'dm-1-aaaaaaaa', content: 'm1', createdAt: t(1) });
    await seedMessage(DISC, sprintId, { id: 'dm-2-aaaaaaaa', content: 'm2a', createdAt: t(2) });
    await seedMessage(DISC, sprintId, { id: 'dm-2-bbbbbbbb', content: 'm2b', createdAt: t(2) });
    await seedMessage(DISC, sprintId, { id: 'dm-3-aaaaaaaa', content: 'm3', createdAt: t(3) });
  });

  it('everything is unread without a cursor', async () => {
    const list = json(await listDiscussions(sprintId));
    expect(list.find((d) => d.id === DISC).unreadCount).toBe(4);
  });

  it('PUT /read upserts the composite cursor; tie-breaks on id at the same timestamp', async () => {
    // Cursor at (t2, dm-2-aaaaaaaa): dm-2-bbbbbbbb (same ts, higher id) and
    // dm-3 are unread.
    const res = await putRead({ lastReadAt: t(2), lastReadMessageId: 'dm-2-aaaaaaaa' });
    expect(res.statusCode).toBe(200);

    const list = json(await listDiscussions(sprintId));
    expect(list.find((d) => d.id === DISC).unreadCount).toBe(2);

    // Advance to the newest message → zero unread.
    await putRead({ lastReadAt: t(3), lastReadMessageId: 'dm-3-aaaaaaaa' });
    const updated = json(await listDiscussions(sprintId));
    expect(updated.find((d) => d.id === DISC).unreadCount).toBe(0);
  });

  it('cursors are per-user', async () => {
    await putRead({ lastReadAt: t(3), lastReadMessageId: 'dm-3-aaaaaaaa' });

    const admin = json(await listDiscussions(sprintId, { sub: ADMIN_SUB }));
    expect(admin.find((d) => d.id === DISC).unreadCount).toBe(4);
  });

  it('posting a message auto-advances the author cursor', async () => {
    await postMessage(sprintId, DISC, { id: 'dm-4-aaaaaaaa', content: 'm4' });

    const list = json(await listDiscussions(sprintId));
    // Cursor at the new message → older seeded messages stay unread? No:
    // the cursor is (createdAt of m4, m4) which is NEWER than everything.
    expect(list.find((d) => d.id === DISC).unreadCount).toBe(0);
  });

  it('validates body and enforces membership', async () => {
    expect((await putRead({ lastReadAt: t(1) })).statusCode).toBe(400);
    expect(
      (
        await putRead(
          { lastReadAt: t(1), lastReadMessageId: 'dm-1-aaaaaaaa' },
          { sub: OUTSIDER_SUB },
        )
      ).statusCode,
    ).toBe(403);
  });
});

// =============================================================================
// GET /discussions/search — bounded sprint-scoped search
// =============================================================================

describe('GET .../discussions/search', () => {
  let sprintId;

  const search = (query, opts = {}) =>
    call('GET', '/api/sprints/{sprintId}/discussions/search', {
      pathParameters: { sprintId },
      query,
      ...opts,
    });

  beforeEach(async () => {
    ({ sprintId } = await seedDefaultProject());
    await seedDiscussion(sprintId, 'disc-db', { entityType: 'sprint' });
    await g
      .V()
      .has('Discussion', 'id', 'disc-db')
      .property(gremlin.process.cardinality.single, 'entity_title', 'Database selection')
      .next();
    await seedMessage('disc-db', sprintId, {
      id: 'dm-1-aaaaaaaa',
      content: 'I vote for PostgreSQL',
      authorId: MEMBER_SUB,
      createdAt: '2025-12-01T00:00:00.000Z',
    });
    await seedMessage('disc-db', sprintId, {
      id: 'dm-2-aaaaaaaa',
      content: 'MySQL is fine too',
      authorId: ADMIN_SUB,
      createdAt: '2025-12-02T00:00:00.000Z',
    });
  });

  it('matches message content and returns the thread context', async () => {
    const res = await search({ q: 'PostgreSQL' });
    expect(res.statusCode).toBe(200);
    const { results } = json(res);
    expect(results).toHaveLength(1);
    expect(results[0].discussion.id).toBe('disc-db');
    expect(results[0].message.id).toBe('dm-1-aaaaaaaa');
  });

  it('matches the denormalized entity title (thread-level hit, no message)', async () => {
    const { results } = json(await search({ q: 'Database sel' }));
    expect(results).toHaveLength(1);
    expect(results[0].discussion.id).toBe('disc-db');
    expect(results[0].message).toBeUndefined();
  });

  it('applies author / status / entityType filters', async () => {
    expect(json(await search({ q: 'MySQL', author: ADMIN_SUB })).results).toHaveLength(1);
    expect(json(await search({ q: 'MySQL', author: MEMBER_SUB })).results).toHaveLength(0);
    expect(json(await search({ q: 'PostgreSQL', status: 'resolved' })).results).toHaveLength(0);
    expect(json(await search({ q: 'PostgreSQL', entityType: 'question' })).results).toHaveLength(0);
    expect(json(await search({ q: 'PostgreSQL', entityType: 'sprint' })).results).toHaveLength(1);
  });

  it('enforces bounds: q ≥ 3 chars, limit ≤ 25, valid filter values', async () => {
    expect((await search({ q: 'ab' })).statusCode).toBe(400);
    expect((await search({ q: 'PostgreSQL', limit: '999' })).statusCode).toBe(200);
    expect((await search({ q: 'PostgreSQL', status: 'weird' })).statusCode).toBe(400);
    expect((await search({ q: 'PostgreSQL', entityType: 'weird' })).statusCode).toBe(400);
  });

  it('is membership-gated', async () => {
    expect((await search({ q: 'PostgreSQL' }, { sub: OUTSIDER_SUB })).statusCode).toBe(403);
  });
});

// =============================================================================
// Mention notifications (online, in-app only)
// =============================================================================

describe('mention notifications', () => {
  it('notifies each mentioned user on their live connections, excluding self-mentions and expired tokens', async () => {
    vi.stubEnv('CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', 'https://fake.execute-api.eu-west-1.amazonaws.com/ws');
    const { sprintId } = await seedDefaultProject();
    await seedDiscussion(sprintId, 'disc-mention');
    connectionItems = [
      { connectionId: 'conn-admin-live', userId: ADMIN_SUB, tokenExp: nowSec() + 300 },
      { connectionId: 'conn-admin-expired', userId: ADMIN_SUB, tokenExp: nowSec() - 10 },
      { connectionId: 'conn-member', userId: MEMBER_SUB, tokenExp: nowSec() + 300 },
    ];

    const res = await postMessage(sprintId, 'disc-mention', {
      id: 'dm-1-mention01',
      content: 'ping @admin and @me',
      mentions: [ADMIN_SUB, MEMBER_SUB],
    });
    expect(res.statusCode).toBe(201);

    const notificationCalls = apiMock
      .commandCalls(PostToConnectionCommand)
      .map((c) => ({
        connectionId: c.args[0].input.ConnectionId,
        payload: JSON.parse(c.args[0].input.Data),
      }))
      .filter((c) => c.payload.type === 'discussion.mention');

    // Only the admin's LIVE connection — not the expired one, and no
    // self-mention notification for the author.
    expect(notificationCalls.map((c) => c.connectionId)).toEqual(['conn-admin-live']);
    expect(notificationCalls[0].payload).toMatchObject({
      action: 'notification',
      type: 'discussion.mention',
      discussionId: 'disc-mention',
      messageId: 'dm-1-mention01',
      excerpt: 'ping @admin and @me',
    });
  });
});

// =============================================================================
// V2 intent-scoped discussions (anchor on Intent + its artifacts)
// =============================================================================

describe('intent-scoped discussions', () => {
  // Seed a Project + member + an Intent vertex (carrying project_id, as init-ws
  // stamps it) + one produced Artifact (Intent --CONTAINS--> Artifact) + one
  // mirrored question gate (Intent --CONTAINS--> Question, as the graph-writer's
  // recordQuestion creates it — id is the gate's humanTaskId, no title prop).
  const seedIntent = async () => {
    const projectId = randomUUID();
    const intentId = randomUUID();
    const artifactId = `art-${randomUUID()}`;
    const questionId = `ht-${randomUUID()}`;
    await seedProject({
      projectId,
      members: [
        { sub: MEMBER_SUB, role: 'member' },
        { sub: ADMIN_SUB, role: 'admin' },
      ],
    });
    await g
      .V()
      .has('Project', 'id', projectId)
      .addV('Intent')
      .property('id', intentId)
      .property('project_id', projectId)
      .property('title', 'Test intent')
      .next();
    await g
      .V()
      .has('Intent', 'id', intentId)
      .as('i')
      .addV('Artifact')
      .property('id', artifactId)
      .property('intent_id', intentId)
      .property('artifact_type', 'requirements')
      .property('title', 'Requirements')
      .as('a')
      .addE('CONTAINS')
      .from_('i')
      .to('a')
      .next();
    await g
      .V()
      .has('Intent', 'id', intentId)
      .as('i')
      .addV('Question')
      .property('id', questionId)
      .property('intent_id', intentId)
      .property('questions', JSON.stringify([{ text: 'Which database?' }]))
      .property('structured_answer', '')
      .as('q')
      .addE('CONTAINS')
      .from_('i')
      .to('q')
      .next();
    // A DERIVED typed item mirrored from the artifact: Artifact --HAS_ITEM-->
    // Story (id encodes the intent; current rows carry superseded_at='').
    const itemId = `story:${intentId}:s-login`;
    await g
      .V()
      .has('Artifact', 'id', artifactId)
      .as('a')
      .addV('Story')
      .property('id', itemId)
      .property('intent_id', intentId)
      .property('artifact_id', artifactId)
      .property('slug', 's-login')
      .property('title', 'User logs in')
      .property('superseded_at', '')
      .as('it')
      .addE('HAS_ITEM')
      .from_('a')
      .to('it')
      .next();
    return { projectId, intentId, artifactId, questionId, itemId };
  };

  const intentPath = (suffix) => `/api/projects/{projectId}/intents/{intentId}${suffix}`;

  it('creates + lists an intent-level thread and a per-artifact thread', async () => {
    const { projectId, intentId, artifactId } = await seedIntent();

    const created = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'intent' },
    });
    expect(created.statusCode).toBe(200);
    expect(json(created).entityType).toBe('intent');
    expect(json(created).entityId).toBe(intentId);

    const artifactThread = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'artifact', entityId: artifactId },
    });
    expect(artifactThread.statusCode).toBe(200);
    expect(json(artifactThread).entityId).toBe(artifactId);

    const list = await call('GET', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
    });
    expect(list.statusCode).toBe(200);
    expect(json(list)).toHaveLength(2);
  });

  it('rejects an artifact not contained by the intent', async () => {
    const { projectId, intentId } = await seedIntent();
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'artifact', entityId: 'art-not-here' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a question-anchored thread on a mirrored question gate', async () => {
    const { projectId, intentId, questionId } = await seedIntent();
    // The Question vertex carries no title/name — the client-provided
    // entityTitle (the question text) is the fallback.
    const created = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'question', entityId: questionId, entityTitle: 'Which database?' },
    });
    expect(created.statusCode).toBe(200);
    expect(json(created).entityType).toBe('question');
    expect(json(created).entityId).toBe(questionId);
    expect(json(created).entityTitle).toBe('Which database?');

    // Idempotent get-or-create: same anchor returns the same thread.
    const again = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'question', entityId: questionId },
    });
    expect(again.statusCode).toBe(200);
    expect(json(again).id).toBe(json(created).id);
  });

  it('rejects a question not contained by the intent', async () => {
    const { projectId, intentId } = await seedIntent();
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'question', entityId: 'ht-not-here' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a thread anchored on a derived item (Artifact --HAS_ITEM--> Story)', async () => {
    const { projectId, intentId, itemId } = await seedIntent();

    const created = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'item', entityId: itemId, entityTitle: 'User logs in' },
    });
    expect(created.statusCode).toBe(200);
    expect(json(created).entityType).toBe('item');
    expect(json(created).entityId).toBe(itemId);
    // The Story vertex carries a title prop → resolved server-side.
    expect(json(created).entityTitle).toBe('User logs in');

    // Idempotent get-or-create: same item returns the same thread.
    const again = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'item', entityId: itemId },
    });
    expect(again.statusCode).toBe(200);
    expect(json(again).id).toBe(json(created).id);

    // The item thread lists under the intent.
    const list = await call('GET', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
    });
    expect(json(list).filter((d) => d.entityType === 'item')).toHaveLength(1);
  });

  it('rejects an item that belongs to a DIFFERENT intent', async () => {
    const a = await seedIntent();
    const b = await seedIntent();
    // b.itemId is real, but it hangs off intent b — not reachable from intent a.
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId: a.projectId, intentId: a.intentId },
      body: { entityType: 'item', entityId: b.itemId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a SUPERSEDED item (re-derive retired it)', async () => {
    const { projectId, intentId, itemId } = await seedIntent();
    await g.V().has('Story', 'id', itemId).property('superseded_at', '2026-01-02T00:00:00Z').next();
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'item', entityId: itemId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an item whose PARENT ARTIFACT was rewind-superseded', async () => {
    // The item row itself stays current (superseded_at=''), but the knowledge
    // graph hides items under a superseded parent — the anchor must too.
    const { projectId, intentId, artifactId, itemId } = await seedIntent();
    await g
      .V()
      .has('Artifact', 'id', artifactId)
      .property('superseded_at', '2026-01-02T00:00:00Z')
      .next();
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'item', entityId: itemId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an item id that resolves to a non-item vertex', async () => {
    const { projectId, intentId, artifactId } = await seedIntent();
    // The artifact id is a real vertex under the intent, but it is NOT reachable
    // via Artifact --HAS_ITEM--> so the item anchor traversal must miss it.
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'item', entityId: artifactId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates separate review-scoped threads per human validation gate id', async () => {
    const { projectId, intentId } = await seedIntent();

    const first = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'review', entityId: 'ht-review-1', entityTitle: 'Review stage-a' },
    });
    expect(first.statusCode).toBe(200);
    expect(json(first)).toMatchObject({
      entityType: 'review',
      entityId: 'ht-review-1',
      entityTitle: 'Review stage-a',
    });

    const second = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'review', entityId: 'ht-review-2', entityTitle: 'Review stage-b' },
    });
    expect(second.statusCode).toBe(200);
    expect(json(second).id).not.toBe(json(first).id);

    const again = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'review', entityId: 'ht-review-1', entityTitle: 'Review stage-a' },
    });
    expect(again.statusCode).toBe(200);
    expect(json(again).id).toBe(json(first).id);

    const messageId = 'dm-review-aaaaaaaa';
    const posted = await call('POST', intentPath('/discussions/{discussionId}/messages'), {
      pathParameters: { projectId, intentId, discussionId: json(first).id },
      body: { id: messageId, content: 'Review feedback checkpoint' },
    });
    expect(posted.statusCode).toBe(201);

    const messages = await call('GET', intentPath('/discussions/{discussionId}/messages'), {
      pathParameters: { projectId, intentId, discussionId: json(first).id },
    });
    expect(messages.statusCode).toBe(200);
    expect(json(messages).messages.map((m) => m.content)).toContain('Review feedback checkpoint');

    const list = await call('GET', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
    });
    expect(json(list).filter((d) => d.entityType === 'review')).toHaveLength(2);

    const search = await call('GET', intentPath('/discussions/search'), {
      pathParameters: { projectId, intentId },
      query: { q: 'checkpoint', entityType: 'review' },
    });
    expect(search.statusCode).toBe(200);
    expect(json(search).results[0].discussion.id).toBe(json(first).id);
  });

  it('rejects a sprint entityType under an intent scope', async () => {
    const { projectId, intentId } = await seedIntent();
    const res = await call('POST', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      body: { entityType: 'sprint' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('posts + reads messages on an intent thread', async () => {
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );
    const msgId = `dm-${Date.now()}-aaaa`;
    const posted = await call('POST', intentPath(`/discussions/{discussionId}/messages`), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { id: msgId, content: 'hello intent' },
    });
    expect(posted.statusCode).toBe(201);

    const msgs = await call('GET', intentPath(`/discussions/{discussionId}/messages`), {
      pathParameters: { projectId, intentId, discussionId: created.id },
    });
    expect(json(msgs).messages.map((m) => m.content)).toContain('hello intent');
  });

  it('starts Quorum assist on an intent thread and invokes AgentCore with the discussion session', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ ok: true, accepted: true }) },
    });
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );

    const res = await call('POST', intentPath('/discussions/{discussionId}/assist'), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: {
        requestId: 'assist-request-1',
        command: 'summarize',
        instructions: 'Focus on decisions',
      },
    });
    expect(res.statusCode).toBe(202);
    const body = json(res);
    expect(body.message).toMatchObject({
      requestId: 'assist-request-1',
      authorType: 'agent',
      authorName: 'Quorum',
      command: 'summarize',
      requestedBy: MEMBER_SUB,
      assistStatus: 'running',
      discussionId: created.id,
      sprintId: intentId,
    });

    const invoke = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(invoke.runtimeSessionId.startsWith(`aidlc-discuss-${intentId}-${created.id}`)).toBe(
      true,
    );
    expect(invoke.runtimeSessionId.length).toBeGreaterThanOrEqual(33);
    const payload = JSON.parse(Buffer.from(invoke.payload).toString('utf8'));
    expect(payload).toMatchObject({
      command: 'discussion-assist-start',
      projectId,
      intentId,
      discussionId: created.id,
      requestId: 'assist-request-1',
      assistCommand: 'summarize',
      instructions: 'Focus on decisions',
    });

    const again = await call('POST', intentPath('/discussions/{discussionId}/assist'), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { requestId: 'assist-request-1', command: 'summarize' },
    });
    expect(again.statusCode).toBe(202);
    expect(json(again).message.id).toBe(body.message.id);
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(1);
  });

  it('accepts ask as the free-form Quorum assist command', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ ok: true, accepted: true }) },
    });
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );

    const res = await call('POST', intentPath('/discussions/{discussionId}/assist'), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: {
        requestId: 'assist-request-ask',
        command: 'ask',
        instructions: 'Check the risks',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(json(res).message).toMatchObject({
      command: 'ask',
      assistStatus: 'running',
      content: 'Quorum is thinking...',
    });

    const invoke = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    const payload = JSON.parse(Buffer.from(invoke.payload).toString('utf8'));
    expect(payload).toMatchObject({
      assistCommand: 'ask',
      instructions: 'Check the risks',
    });
  });

  it('marks the Quorum message failed when AgentCore invoke fails', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error('runtime unavailable'));
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );

    const res = await call('POST', intentPath('/discussions/{discussionId}/assist'), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { requestId: 'assist-request-failed', command: 'brainstorm' },
    });
    expect(res.statusCode).toBe(202);
    expect(json(res).message.assistStatus).toBe('failed');

    const stored = json(
      await call('GET', intentPath('/discussions/{discussionId}/messages'), {
        pathParameters: { projectId, intentId, discussionId: created.id },
      }),
    ).messages[0];
    expect(stored.assistStatus).toBe('failed');
    expect(stored.content).toContain('Quorum could not brainstorm');

    agentcoreMock.reset();
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ ok: true, accepted: true }) },
    });
    const retry = await call('POST', intentPath('/discussions/{discussionId}/assist'), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { requestId: 'assist-request-failed', command: 'brainstorm' },
    });
    expect(retry.statusCode).toBe(202);
    expect(json(retry).message.id).toBe(stored.id);
    expect(json(retry).message.assistStatus).toBe('running');
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(1);
  });

  it('issues an intent + project scope realtime token for a member', async () => {
    const { projectId, intentId } = await seedIntent();
    const res = await call('POST', intentPath('/realtime-token'), {
      pathParameters: { projectId, intentId },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).scopes).toEqual(
      expect.arrayContaining([`intent:${intentId}`, `project:${projectId}`]),
    );
  });

  it('denies a non-member', async () => {
    const { projectId, intentId } = await seedIntent();
    const res = await call('GET', intentPath('/discussions'), {
      pathParameters: { projectId, intentId },
      sub: OUTSIDER_SUB,
    });
    expect(res.statusCode).toBe(403);
  });

  it('resolves + reopens an intent thread (scope-neutral status write)', async () => {
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );
    const resolved = await call('PUT', intentPath(`/discussions/{discussionId}`), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { status: 'resolved', resolutionSummary: 'done' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(json(resolved).status).toBe('resolved');

    const reopened = await call('PUT', intentPath(`/discussions/{discussionId}`), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { status: 'open' },
    });
    expect(json(reopened).status).toBe('open');
  });

  it('redacts an intent-thread message (admin) targeting the intent scope', async () => {
    const { projectId, intentId } = await seedIntent();
    const created = json(
      await call('POST', intentPath('/discussions'), {
        pathParameters: { projectId, intentId },
        body: { entityType: 'intent' },
      }),
    );
    const msgId = `dm-${Date.now()}-redact`;
    await call('POST', intentPath(`/discussions/{discussionId}/messages`), {
      pathParameters: { projectId, intentId, discussionId: created.id },
      body: { id: msgId, content: 'secret' },
    });
    const redacted = await call(
      'POST',
      intentPath(`/discussions/{discussionId}/messages/{messageId}/redact`),
      {
        pathParameters: { projectId, intentId, discussionId: created.id, messageId: msgId },
        sub: ADMIN_SUB,
      },
    );
    expect(redacted.statusCode).toBe(200);
    expect(json(redacted).redacted).toBe(true);
    expect(json(redacted).content).not.toBe('secret');
  });
});
