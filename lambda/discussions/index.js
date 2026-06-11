import gremlin from 'gremlin';
import { createHash, randomUUID } from 'node:crypto';
import { create } from 'neptune-lambda-client';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
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
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildResponse } from '../shared/response.js';
import { fetchMembershipRole } from '../shared/trackers.js';
import { signRealtimeToken, isTokenLive } from '../shared/realtime-token.js';

// lambda/discussions — sprint-scoped discussion threads (discussions plan).
//
// PR 1: realtime scope-token issuance (plan §4a).
// PR 2 (this revision): graph data model + core REST (plan §5/§6/§7) —
//   GET  /sprints/{sprintId}/discussions                          list + messageCount
//   POST /sprints/{sprintId}/discussions                          atomic get-or-create (creation guard)
//   GET  /sprints/{sprintId}/discussions/{discussionId}/messages  keyset pagination + change delta
//   POST /sprints/{sprintId}/discussions/{discussionId}/messages  append via stateful message guard
//
// Durability model (D8): REST persists to Neptune (source of truth), then THIS
// lambda fans out the full payload over the app WebSocket. Yjs is a live-sync
// optimization handled entirely client-side.
//
// Concurrency model (D9): Neptune does not unique-constrain the `id` property,
// so thread creation and message append are serialized through DynamoDB
// conditional writes in the `discussion-locks` table. Lazy DynamoDB TTL is
// never trusted — every condition that cares about expiry checks
// `expiresAt < :now` explicitly.

const { cardinality, order } = gremlin.process;
const __ = gremlin.process.statics;

// ─── Constants ───

const ENTITY_TYPES = [
  'sprint',
  'inception',
  'question',
  'requirement',
  'userstory',
  'task',
  'review',
  'generalinfo',
];

// entityType → anchor vertex label. `sprint` and `inception` both anchor at
// the Sprint vertex (distinguished by the entity_type property, plan §5).
const ANCHOR_LABELS = {
  sprint: 'Sprint',
  inception: 'Sprint',
  question: 'Question',
  requirement: 'Requirement',
  userstory: 'UserStory',
  task: 'Task',
  review: 'Review',
  generalinfo: 'GeneralInfo',
};

const MESSAGE_ID_RE = /^dm-[a-z0-9-]{8,64}$/;
const MAX_CONTENT_LENGTH = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

const CREATION_GUARD_SECONDS = 30;
const MESSAGE_GUARD_PENDING_SECONDS = 120;
const MESSAGE_GUARD_COMPLETE_SECONDS = 3600;
const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 300;

// Takeover-safety invariant (plan §7, review round 4): the pending window
// MUST exceed this lambda's timeout, so an expired `pending` guard PROVES the
// original winner is no longer executing — a takeover can never race a
// slow-but-alive winner into a duplicate Neptune write. Terraform sets
// LAMBDA_TIMEOUT_SECONDS alongside the function timeout; both must change
// together. Asserted here (fail fast on misconfiguration) and pinned by a test.
const LAMBDA_TIMEOUT_SECONDS = Number(process.env.LAMBDA_TIMEOUT_SECONDS ?? 30);
if (!(MESSAGE_GUARD_PENDING_SECONDS > LAMBDA_TIMEOUT_SECONDS)) {
  throw new Error(
    `Takeover-safety invariant violated: message-guard pending window (${MESSAGE_GUARD_PENDING_SECONDS}s) ` +
      `must exceed the lambda timeout (${LAMBDA_TIMEOUT_SECONDS}s) — see discussions plan §7`,
  );
}

// ─── Clients ───

// Tests point GREMLIN_PROTOCOL at a plain ws:// gremlin-server (no IAM); Neptune
// in production is wss:// + SigV4. Tying useIam to the protocol keeps the test
// seam to a single env var that globalSetup already sets.
const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

const { query, close } = create(process.env.NEPTUNE_ENDPOINT, process.env.GREMLIN_PORT ?? '8182', {
  useIam: protocol === 'wss',
  protocol,
  partition: process.env.GREMLIN_PARTITION
    ? {
        partitionKey: '_partition',
        writePartition: process.env.GREMLIN_PARTITION,
        readPartitions: [process.env.GREMLIN_PARTITION],
      }
    : undefined,
});

// Exported for test teardown only — production reuses the connection.
export { close };

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient();

const locksTable = () => process.env.LOCKS_TABLE;

// ─── Helpers ───

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isConditionalCheckFailed = (err) =>
  err?.name === 'ConditionalCheckFailedException' || err?.name === 'TransactionCanceledException';

// Caller identity comes from the Cognito User Pools authorizer — clients
// cannot spoof it.
const getCaller = (event) => {
  const claims = event?.requestContext?.authorizer?.claims || {};
  return {
    sub: claims.sub || '',
    displayName: claims['custom:display_name'] || claims.email || '',
  };
};

const getVal = (v, key) => {
  const raw = v instanceof Map ? v.get(key) : v?.[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const parseJsonArray = (raw) => {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const mapDiscussion = (v, messageCount = undefined) => ({
  id: getVal(v, 'id'),
  title: getVal(v, 'title') || null,
  entityType: getVal(v, 'entity_type'),
  entityId: getVal(v, 'entity_id'),
  entityTitle: getVal(v, 'entity_title'),
  sprintId: getVal(v, 'sprint_id'),
  status: getVal(v, 'status') || 'open',
  resolvedBy: getVal(v, 'resolved_by') || undefined,
  resolvedByName: getVal(v, 'resolved_by_name') || undefined,
  resolvedAt: getVal(v, 'resolved_at') || undefined,
  resolutionSummary: getVal(v, 'resolution_summary') || undefined,
  outcomeMessageId: getVal(v, 'outcome_message_id') || undefined,
  createdAt: getVal(v, 'created_at'),
  createdBy: getVal(v, 'created_by'),
  createdByName: getVal(v, 'created_by_name'),
  lastMessageAt: getVal(v, 'last_message_at'),
  ...(messageCount !== undefined ? { messageCount: Number(messageCount) } : {}),
});

const mapMessage = (v) => ({
  id: getVal(v, 'id'),
  content: getVal(v, 'content'),
  authorId: getVal(v, 'author_id'),
  authorName: getVal(v, 'author_name'),
  authorType: getVal(v, 'author_type') || 'user',
  command: getVal(v, 'command') || undefined,
  requestedBy: getVal(v, 'requested_by') || undefined,
  requestedByName: getVal(v, 'requested_by_name') || undefined,
  mentions: parseJsonArray(getVal(v, 'mentions')),
  redacted: getVal(v, 'redacted') === 'true' || getVal(v, 'redacted') === true,
  redactedBy: getVal(v, 'redacted_by') || undefined,
  redactedByName: getVal(v, 'redacted_by_name') || undefined,
  redactedAt: getVal(v, 'redacted_at') || undefined,
  createdAt: getVal(v, 'created_at'),
  updatedAt: getVal(v, 'updated_at'),
  discussionId: getVal(v, 'discussion_id'),
  sprintId: getVal(v, 'sprint_id'),
});

// One total order everywhere (plan §6): display order (createdAt, id),
// change order (updatedAt, id). Both server-assigned ISO strings.
const compareBy = (tsKey) => (a, b) => {
  if (a[tsKey] !== b[tsKey]) return a[tsKey] < b[tsKey] ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

// Canonical idempotency hash over the NORMALIZED full append payload —
// not content alone, because mentions affect persisted data and
// notifications (plan §7, review round 4).
const canonicalMentions = (mentions) => [...new Set(mentions)].sort();
const payloadHashOf = (content, mentions) =>
  createHash('sha256')
    .update(JSON.stringify({ content, mentions: canonicalMentions(mentions) }))
    .digest('hex');

// ─── Authorization ───

// Resolve the project a sprint belongs to (Project -HAS_SPRINT-> Sprint).
const fetchProjectIdForSprint = async (g, sprintId) => {
  const r = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .in_('HAS_SPRINT')
    .hasLabel('Project')
    .values('id')
    .next();
  return r.done ? null : r.value;
};

// Every route resolves the caller's role once (plan §7 role matrix).
// Returns { res } with an error response, or { projectId, role }.
const authorizeSprint = async (sprintId, sub, res) => {
  if (!sub) return { res: res(401, { error: 'Unauthorized' }) };
  const projectId = await query((g) => fetchProjectIdForSprint(g, sprintId));
  if (!projectId) return { res: res(404, { error: 'Sprint not found' }) };
  const role = await query((g) => fetchMembershipRole(g, projectId, sub));
  if (!role) return { res: res(403, { error: 'Not a project member' }) };
  return { projectId, role };
};

// ─── WebSocket fanout (server-driven, D8) ───

const broadcastToSprint = async (sprintId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint) return;
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': `sprint:${sprintId}` },
      }),
    );
    const api = new ApiGatewayManagementApiClient({ endpoint: websocketEndpoint });
    const data = JSON.stringify(payload);
    await Promise.all(
      (result.Items || [])
        // Never target connections whose scope token has expired (plan §4a).
        .filter((item) => isTokenLive(item.tokenExp))
        .map((item) =>
          api
            .send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
            .catch(() => {}),
        ),
    );
  } catch (err) {
    // Fanout is best-effort — persistence already succeeded; clients have the
    // change-delta reconciliation backstop (plan §6).
    console.error('WS fanout failed:', err.message);
  }
};

// ─── Realtime token issuance (PR 1, plan §4a) ───

// Doc-secret resolution: REALTIME_DOC_SECRET env wins (test seam / local),
// otherwise fetch the SSM SecureString named by REALTIME_SECRET_PARAM once
// per container and cache it.
let cachedSecret = null;
const getSecret = async () => {
  if (process.env.REALTIME_DOC_SECRET) return process.env.REALTIME_DOC_SECRET;
  if (cachedSecret) return cachedSecret;
  const paramName = process.env.REALTIME_SECRET_PARAM;
  if (!paramName) throw new Error('REALTIME_SECRET_PARAM is not configured');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cachedSecret = result.Parameter?.Value || '';
  if (!cachedSecret) throw new Error(`SSM parameter ${paramName} is empty`);
  return cachedSecret;
};

const issueRealtimeToken = async (event, res) => {
  const { sub } = getCaller(event);
  if (!sub) return res(401, { error: 'Unauthorized' });

  const { sprintId, projectId: pathProjectId } = event.pathParameters || {};

  let projectId = pathProjectId;
  let scopes;
  if (sprintId) {
    projectId = await query((g) => fetchProjectIdForSprint(g, sprintId));
    if (!projectId) return res(404, { error: 'Sprint not found' });
    scopes = [`sprint:${sprintId}`, `project:${projectId}`];
  } else if (pathProjectId) {
    scopes = [`project:${pathProjectId}`];
  } else {
    return res(400, { error: 'Missing sprintId or projectId' });
  }

  const role = await query((g) => fetchMembershipRole(g, projectId, sub));
  if (!role) return res(403, { error: 'Not a project member' });

  const secret = await getSecret();
  const { token, exp } = signRealtimeToken({ sub, scopes }, secret);
  return res(200, { token, exp, scopes });
};

// ─── Discussions: list ───

const listDiscussions = async (event, res) => {
  const { sprintId } = event.pathParameters || {};
  const auth = await authorizeSprint(sprintId, getCaller(event).sub, res);
  if (auth.res) return auth.res;

  const rows = await query((g) =>
    g
      .V()
      .has('Sprint', 'id', sprintId)
      .out('HAS_DISCUSSION')
      .hasLabel('Discussion')
      .project('props', 'messageCount')
      .by(__.valueMap())
      // message_count is computed, never stored — racy (plan §5).
      .by(__.out('HAS_MESSAGE').count())
      .toList(),
  );

  const discussions = rows
    .map((r) => mapDiscussion(r.get('props'), r.get('messageCount')))
    .sort((a, b) => {
      if (a.lastMessageAt !== b.lastMessageAt) return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  return res(200, discussions);
};

// ─── Discussions: atomic get-or-create (plan §5, D9) ───

// Anchor lookup: the ordered limit(1) makes even a residual duplicate behave
// deterministically (defense-in-depth).
const findDiscussionByAnchor = async (g, anchorLabel, entityId, entityType) => {
  const r = await g
    .V()
    .has(anchorLabel, 'id', entityId)
    .in_('DISCUSSES')
    .hasLabel('Discussion')
    .has('entity_type', entityType)
    .order()
    .by('created_at', order.asc)
    .limit(1)
    .project('props', 'messageCount')
    .by(__.valueMap())
    .by(__.out('HAS_MESSAGE').count())
    .next();
  if (r.done || !r.value) return null;
  return mapDiscussion(r.value.get('props'), r.value.get('messageCount'));
};

const anchorExistsInSprint = async (g, sprintId, entityType, entityId) => {
  if (entityType === 'sprint' || entityType === 'inception') return entityId === sprintId;
  const edge = entityType === 'review' ? 'HAS_REVIEW' : 'CONTAINS';
  const r = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .out(edge)
    .hasLabel(ANCHOR_LABELS[entityType])
    .has('id', entityId)
    .hasNext();
  return r;
};

const fetchAnchorTitle = async (g, anchorLabel, entityId) => {
  const r = await g.V().has(anchorLabel, 'id', entityId).valueMap('title', 'name').next();
  if (r.done || !r.value) return '';
  return getVal(r.value, 'title') || getVal(r.value, 'name') || '';
};

const createDiscussionVertex = async (
  g,
  { id, sprintId, entityType, entityId, entityTitle, createdAt, sub, displayName },
) => {
  const anchorLabel = ANCHOR_LABELS[entityType];
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .V()
    .has(anchorLabel, 'id', entityId)
    .as('a')
    .addV('Discussion')
    .property('id', id)
    .property('entity_type', entityType)
    .property('entity_id', entityId)
    .property('entity_title', entityTitle)
    .property('sprint_id', sprintId)
    .property('status', 'open')
    .property('created_at', createdAt)
    .property('created_by', sub)
    .property('created_by_name', displayName)
    .property('last_message_at', createdAt)
    .as('d')
    .addE('HAS_DISCUSSION')
    .from_('s')
    .to('d')
    .select('d')
    .addE('DISCUSSES')
    .from_('d')
    .to('a')
    .next();

  // `discussion_started` TimelineEvent on first creation (plan §7).
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('TimelineEvent')
    .property('id', randomUUID())
    .property('type', 'discussion_started')
    .property('title', `Discussion started on ${entityType}`)
    .property('detail', entityTitle || '')
    .property('user_id', sub)
    .property('user_name', displayName)
    .property('timestamp', createdAt)
    .property('sprint_id', sprintId)
    .property('question_id', '')
    .as('e')
    .addE('HAS_TIMELINE_EVENT')
    .from_('s')
    .to('e')
    .next();
};

const getOrCreateDiscussion = async (event, res) => {
  const { sprintId } = event.pathParameters || {};
  const caller = getCaller(event);
  const auth = await authorizeSprint(sprintId, caller.sub, res);
  if (auth.res) return auth.res;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return res(400, { error: 'Invalid JSON body' });
  }

  const entityType = body.entityType;
  if (!ENTITY_TYPES.includes(entityType)) {
    return res(400, { error: `Invalid entityType — must be one of ${ENTITY_TYPES.join(', ')}` });
  }
  const entityId =
    entityType === 'sprint' || entityType === 'inception' ? sprintId : String(body.entityId || '');
  if (!entityId) return res(400, { error: 'Missing entityId' });

  const anchorLabel = ANCHOR_LABELS[entityType];

  // Fast path: thread already exists — no lock (plan §5 step 1).
  const existing = await query((g) => findDiscussionByAnchor(g, anchorLabel, entityId, entityType));
  if (existing) return res(200, existing);

  // Validate the anchor lives in this sprint before creating anything.
  const anchorOk = await query((g) => anchorExistsInSprint(g, sprintId, entityType, entityId));
  if (!anchorOk) return res(404, { error: `${entityType} "${entityId}" not found in sprint` });

  const guardKey = `create:${sprintId}:${entityType}:${entityId}`;

  // Two iterations max: a crashed-winner takeover re-runs the acquire once.
  for (let attempt = 0; attempt < 2; attempt++) {
    let acquired = false;
    try {
      await ddb.send(
        new PutCommand({
          TableName: locksTable(),
          Item: {
            lockId: guardKey,
            kind: 'creation',
            expiresAt: nowSeconds() + CREATION_GUARD_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(lockId) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': nowSeconds() },
        }),
      );
      acquired = true;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }

    if (acquired) {
      // Winner: re-check the anchor (guard against a just-finished creator),
      // create vertex + edges, delete the guard (plan §5 step 2).
      const recheck = await query((g) =>
        findDiscussionByAnchor(g, anchorLabel, entityId, entityType),
      );
      if (recheck) {
        await ddb
          .send(new DeleteCommand({ TableName: locksTable(), Key: { lockId: guardKey } }))
          .catch(() => {});
        return res(200, recheck);
      }

      const id = `disc-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const entityTitle =
        (await query((g) => fetchAnchorTitle(g, anchorLabel, entityId))) ||
        String(body.entityTitle || '');

      await query((g) =>
        createDiscussionVertex(g, {
          id,
          sprintId,
          entityType,
          entityId,
          entityTitle,
          createdAt,
          sub: caller.sub,
          displayName: caller.displayName,
        }),
      );

      await ddb
        .send(new DeleteCommand({ TableName: locksTable(), Key: { lockId: guardKey } }))
        .catch(() => {});

      const created = await query((g) =>
        findDiscussionByAnchor(g, anchorLabel, entityId, entityType),
      );
      return res(200, created);
    }

    // Loser: short retry loop on the anchor lookup (plan §5 step 2).
    for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
      await sleep(POLL_INTERVAL_MS);
      const found = await query((g) =>
        findDiscussionByAnchor(g, anchorLabel, entityId, entityType),
      );
      if (found) return res(200, found);
    }

    const guard = await ddb.send(
      new GetCommand({ TableName: locksTable(), Key: { lockId: guardKey } }),
    );
    if (guard.Item && guard.Item.expiresAt >= nowSeconds()) {
      // Slow but healthy winner — the frontend retries transparently.
      return res(409, { reason: 'creation_in_progress', retryAfter: 1 });
    }
    // Guard expired (crashed winner) or already deleted — loop and become
    // the winner via the in-condition expiry check.
  }
  return res(409, { reason: 'creation_in_progress', retryAfter: 1 });
};

// ─── Messages: list (keyset pagination + change delta, plan §6/§7) ───

const fetchDiscussionInSprint = async (g, sprintId, discussionId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .has('sprint_id', sprintId)
    .valueMap()
    .next();
  return r.done ? null : r.value;
};

const parseCursor = (raw) => {
  if (!raw) return null;
  const idx = raw.indexOf(',');
  if (idx <= 0 || idx === raw.length - 1) return undefined; // malformed
  return { ts: raw.slice(0, idx), id: raw.slice(idx + 1) };
};

const listMessages = async (event, res) => {
  const { sprintId, discussionId } = event.pathParameters || {};
  const auth = await authorizeSprint(sprintId, getCaller(event).sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInSprint(g, sprintId, discussionId));
  if (!discussion) return res(404, { error: 'Discussion not found' });

  const params = event.queryStringParameters || {};
  let limit = Number(params.limit ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_PAGE_SIZE;
  limit = Math.min(limit, MAX_PAGE_SIZE);

  const before = parseCursor(params.before);
  const after = parseCursor(params.after);
  if (before === undefined || after === undefined) {
    return res(400, { error: 'Malformed cursor — expected "{timestamp},{id}"' });
  }
  if (before && after) {
    return res(400, { error: 'Use either ?before or ?after, not both' });
  }

  const rows = await query((g) =>
    g
      .V()
      .has('Discussion', 'id', discussionId)
      .out('HAS_MESSAGE')
      .hasLabel('DiscussionMessage')
      .valueMap()
      .toList(),
  );
  const all = rows.map(mapMessage);

  let messages;
  let hasMore;
  if (after) {
    // Change delta: keyed on (updatedAt, id) ascending so missed REDACTIONS
    // of older messages arrive too, not just new messages (plan §6).
    const sorted = all.sort(compareBy('updatedAt'));
    const newer = sorted.filter(
      (m) => m.updatedAt > after.ts || (m.updatedAt === after.ts && m.id > after.id),
    );
    messages = newer.slice(0, limit);
    hasMore = newer.length > limit;
  } else if (before) {
    // Older history: display order (createdAt, id), latest `limit` strictly
    // before the cursor, returned ascending.
    const sorted = all.sort(compareBy('createdAt'));
    const older = sorted.filter(
      (m) => m.createdAt < before.ts || (m.createdAt === before.ts && m.id < before.id),
    );
    messages = older.slice(-limit);
    hasMore = older.length > limit;
  } else {
    // Seeding: the latest page in display order, returned ascending.
    const sorted = all.sort(compareBy('createdAt'));
    messages = sorted.slice(-limit);
    hasMore = sorted.length > limit;
  }

  return res(200, { messages, hasMore });
};

// ─── Messages: atomic append via stateful message guard (plan §7, D9) ───

const fetchMessageInDiscussion = async (g, discussionId, messageId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .out('HAS_MESSAGE')
    .hasLabel('DiscussionMessage')
    .has('id', messageId)
    .valueMap()
    .next();
  return r.done ? null : r.value;
};

const createMessageVertex = async (g, { discussionId, sprintId, message }) => {
  await g
    .V()
    .has('Discussion', 'id', discussionId)
    .as('d')
    .addV('DiscussionMessage')
    .property('id', message.id)
    .property('content', message.content)
    .property('author_id', message.authorId)
    .property('author_name', message.authorName)
    .property('author_type', 'user')
    .property('mentions', JSON.stringify(message.mentions))
    .property('created_at', message.createdAt)
    .property('updated_at', message.updatedAt)
    .property('discussion_id', discussionId)
    .property('sprint_id', sprintId)
    .as('m')
    .addE('HAS_MESSAGE')
    .from_('d')
    .to('m')
    .select('d')
    .property(cardinality.single, 'last_message_at', message.createdAt)
    .next();
};

const fetchProjectMemberIds = async (g, projectId) => {
  return g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_MEMBER')
    .hasLabel('User')
    .values('id')
    .toList();
};

const postMessage = async (event, res) => {
  const { sprintId, discussionId } = event.pathParameters || {};
  const caller = getCaller(event);
  const auth = await authorizeSprint(sprintId, caller.sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInSprint(g, sprintId, discussionId));
  if (!discussion) return res(404, { error: 'Discussion not found' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return res(400, { error: 'Invalid JSON body' });
  }

  const messageId = String(body.id || '');
  if (!MESSAGE_ID_RE.test(messageId)) {
    return res(400, { error: 'Invalid message id — expected dm-{ts}-{rand}' });
  }
  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) return res(400, { error: 'Message content is required' });
  if (content.length > MAX_CONTENT_LENGTH) {
    return res(400, { error: `Message content exceeds ${MAX_CONTENT_LENGTH} characters` });
  }

  // Mentions: server-validated against project members — non-members stripped
  // (plan §5/§7). Canonical (sorted, deduped) for storage and hashing.
  let mentions = Array.isArray(body.mentions)
    ? body.mentions.filter((m) => typeof m === 'string' && m)
    : [];
  if (mentions.length > 0) {
    const memberIds = await query((g) => fetchProjectMemberIds(g, auth.projectId));
    const memberSet = new Set(memberIds);
    mentions = mentions.filter((m) => memberSet.has(m));
  }
  mentions = canonicalMentions(mentions);

  const payloadHash = payloadHashOf(content, mentions);
  const guardKey = `msg:${discussionId}:${messageId}`;
  const ownerToken = randomUUID();

  const echo = async () => {
    const vertex = await query((g) => fetchMessageInDiscussion(g, discussionId, messageId));
    return vertex ? mapMessage(vertex) : null;
  };

  // Two iterations max: a crashed-winner takeover re-runs the acquire once
  // (the in-condition expiry clause makes this caller the new winner).
  for (let attempt = 0; attempt < 2; attempt++) {
    let acquired = false;
    try {
      await ddb.send(
        new PutCommand({
          TableName: locksTable(),
          Item: {
            lockId: guardKey,
            kind: 'message',
            ownerToken,
            guardState: 'pending',
            authorId: caller.sub,
            payloadHash,
            // Single field serves the in-flight window (condition checks) AND
            // the TTL cleanup: 120 s while pending, bumped to 1 h on complete.
            // Lazy TTL deletion of a pending row is equivalent to expiry
            // takeover — never trusted, always re-checked in conditions.
            expiresAt: nowSeconds() + MESSAGE_GUARD_PENDING_SECONDS,
          },
          ConditionExpression:
            'attribute_not_exists(lockId) OR (guardState = :pending AND expiresAt < :now)',
          ExpressionAttributeValues: { ':pending': 'pending', ':now': nowSeconds() },
        }),
      );
      acquired = true;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }

    if (acquired) {
      // Winner. Idempotent re-check first: the vertex may already exist after
      // a takeover from a winner that crashed AFTER the Neptune write but
      // before marking complete, or after a complete-row TTL cleanup (≥1 h).
      const existingVertex = await query((g) =>
        fetchMessageInDiscussion(g, discussionId, messageId),
      );
      if (existingVertex) {
        const existing = mapMessage(existingVertex);
        const existingHash = payloadHashOf(existing.content, existing.mentions);
        if (existing.authorId !== caller.sub || existingHash !== payloadHash) {
          // Different message reusing the id — restore prior guard state
          // (delete ours) and conflict.
          await ddb
            .send(new DeleteCommand({ TableName: locksTable(), Key: { lockId: guardKey } }))
            .catch(() => {});
          return res(409, { reason: 'duplicate_message_id' });
        }
        // Idempotent echo: skip the write, mark complete.
        await completeGuard(guardKey, ownerToken);
        return res(200, existing);
      }

      const createdAt = new Date().toISOString();
      const message = {
        id: messageId,
        content,
        authorId: caller.sub,
        authorName: caller.displayName,
        authorType: 'user',
        mentions,
        redacted: false,
        createdAt,
        updatedAt: createdAt, // = created_at on create; bumped on redact (plan §5)
        discussionId,
        sprintId,
      };

      await query((g) => createMessageVertex(g, { discussionId, sprintId, message }));
      await completeGuard(guardKey, ownerToken);

      // Server-driven fanout with the FULL persisted message — sender
      // included; delivery never depends on the sender's tab surviving (D8).
      await broadcastToSprint(sprintId, {
        action: 'discussion.message',
        sprintId,
        discussionId,
        message,
      });

      return res(201, message);
    }

    // Condition failure → inspect the guard and branch (plan §7).
    const guard = await ddb.send(
      new GetCommand({ TableName: locksTable(), Key: { lockId: guardKey } }),
    );
    const item = guard.Item;
    if (!item) continue; // guard vanished between PutItem and GetItem — retry

    if (item.authorId !== caller.sub || item.payloadHash !== payloadHash) {
      // Different message reusing the id (content OR mentions mismatch).
      return res(409, { reason: 'duplicate_message_id' });
    }

    if (item.guardState === 'complete') {
      // Idempotent echo: the winner marked complete only after the Neptune
      // write, so the vertex is visible.
      const existing = await echo();
      if (existing) return res(200, existing);
      // Complete but not visible — should be impossible; let the client retry.
      return res(409, { reason: 'message_in_progress', retryAfter: 1 });
    }

    if (item.expiresAt >= nowSeconds()) {
      // Winner still in flight: short poll, then tell the client to retry
      // transparently with the same id.
      for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
        await sleep(POLL_INTERVAL_MS);
        const existing = await echo();
        if (existing) return res(200, existing);
      }
      return res(409, { reason: 'message_in_progress', retryAfter: 1 });
    }

    // pending + expired — crashed winner; per the takeover-safety invariant
    // the original executor is provably dead. Loop: the takeover clause in
    // the PutItem condition lets this caller become the new winner.
  }
  return res(409, { reason: 'message_in_progress', retryAfter: 1 });
};

const completeGuard = async (guardKey, ownerToken) => {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: locksTable(),
        Key: { lockId: guardKey },
        UpdateExpression: 'SET guardState = :complete, expiresAt = :exp',
        ConditionExpression: 'ownerToken = :token',
        ExpressionAttributeValues: {
          ':complete': 'complete',
          ':exp': nowSeconds() + MESSAGE_GUARD_COMPLETE_SECONDS,
          ':token': ownerToken,
        },
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // A takeover stole the guard mid-write — provably impossible for a live
      // winner (pending window > lambda timeout), so just log; the new owner
      // finishes the transition.
      console.warn(`Guard ${guardKey}: ownerToken mismatch on complete-transition (takeover?)`);
      return;
    }
    throw err;
  }
};

// ─── Router ───

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const path = event.resource || event.path || '';
    const method = event.httpMethod;

    if (method === 'POST' && path.endsWith('/realtime-token')) {
      return await issueRealtimeToken(event, res);
    }
    if (path.endsWith('/discussions')) {
      if (method === 'GET') return await listDiscussions(event, res);
      if (method === 'POST') return await getOrCreateDiscussion(event, res);
    }
    if (path.endsWith('/messages')) {
      if (method === 'GET') return await listMessages(event, res);
      if (method === 'POST') return await postMessage(event, res);
    }

    return res(404, { error: 'Not found' });
  } catch (err) {
    console.error('discussions handler error:', err);
    return res(500, { error: 'Internal server error' });
  }
};
