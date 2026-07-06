// lambda/discussions — HTTP handlers. One function per route; each takes
// (event, res), resolves authorization, talks to the data-access layer, fans
// out over WebSocket, and returns a response. The router in index.js dispatches
// to these by method + path.

import { randomUUID } from 'node:crypto';
import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { signRealtimeToken } from '../shared/realtime-token.js';
import { fetchMembershipRole } from '../shared/trackers.js';
import { ddb, query, cardinality, TextP, __, locksTable } from './clients.js';
import {
  MESSAGE_ID_RE,
  MAX_CONTENT_LENGTH,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SEARCH_MIN_QUERY,
  SEARCH_MAX_LIMIT,
  REDACTION_PLACEHOLDER,
  MENTION_EXCERPT_LENGTH,
  CREATION_GUARD_SECONDS,
  MESSAGE_GUARD_PENDING_SECONDS,
  POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from './constants.js';
import {
  getCaller,
  getVal,
  mapDiscussion,
  mapMessage,
  compareBy,
  canonicalMentions,
  payloadHashOf,
  countUnread,
  parseCursor,
  nowSeconds,
  sleep,
  isConditionalCheckFailed,
} from './mappers.js';
import {
  fetchReadCursors,
  upsertReadCursor,
  fetchProjectIdForSprint,
  fetchProjectIdForIntent,
  findDiscussionByAnchor,
  anchorExistsInScope,
  fetchAnchorTitle,
  createDiscussionVertex,
  fetchDiscussionInScope,
  fetchMessageInDiscussion,
  createMessageVertex,
  fetchProjectMemberIds,
  completeGuard,
} from './data-access.js';
import { authorizeScope, broadcastToScope, broadcastToUser, getSecret } from './services.js';
import { resolveScope } from './scope.js';

export const issueRealtimeToken = async (event, res) => {
  const { sub } = getCaller(event);
  if (!sub) return res(401, { error: 'Unauthorized' });

  const { sprintId, intentId, projectId: pathProjectId } = event.pathParameters || {};

  let projectId = pathProjectId;
  let scopes;
  if (sprintId) {
    projectId = await query((g) => fetchProjectIdForSprint(g, sprintId));
    if (!projectId) return res(404, { error: 'Sprint not found' });
    scopes = [`sprint:${sprintId}`, `project:${projectId}`];
  } else if (intentId) {
    // Intent realtime token: the route is project-scoped; verify the intent
    // belongs to the project when the Intent vertex exists (post-Start).
    projectId = (await query((g) => fetchProjectIdForIntent(g, intentId))) || pathProjectId;
    if (!projectId) return res(404, { error: 'Intent not found' });
    scopes = [`intent:${intentId}`, `project:${projectId}`];
  } else if (pathProjectId) {
    scopes = [`project:${pathProjectId}`];
  } else {
    return res(400, { error: 'Missing sprintId, intentId, or projectId' });
  }

  const role = await query((g) => fetchMembershipRole(g, projectId, sub));
  if (!role) return res(403, { error: 'Not a project member' });

  const secret = await getSecret();
  const { token, exp } = signRealtimeToken({ sub, scopes }, secret);
  return res(200, { token, exp, scopes });
};

export const listDiscussions = async (event, res) => {
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;

  const rows = await query((g) =>
    g
      .V()
      .has(scope.rootLabel, 'id', scope.rootId)
      .out('HAS_DISCUSSION')
      .hasLabel('Discussion')
      .project('props', 'messageCount', 'messageKeys')
      .by(__.valueMap())
      // message_count is computed, never stored — racy.
      .by(__.out('HAS_MESSAGE').count())
      // (created_at, id) keys for the per-caller unread computation.
      .by(__.out('HAS_MESSAGE').project('createdAt', 'id').by('created_at').by('id').fold())
      .toList(),
  );

  const cursors = await fetchReadCursors(caller.sub, scope.rootId);

  const discussions = rows
    .map((r) => {
      const d = mapDiscussion(r.get('props'), r.get('messageCount'));
      const keys = (r.get('messageKeys') || []).map((k) => ({
        createdAt: k instanceof Map ? k.get('createdAt') : k.createdAt,
        id: k instanceof Map ? k.get('id') : k.id,
      }));
      d.unreadCount = countUnread(keys, cursors.get(d.id));
      return d;
    })
    .toSorted((a, b) => {
      if (a.lastMessageAt !== b.lastMessageAt) return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  return res(200, discussions);
};

export const getOrCreateDiscussion = async (event, res) => {
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return res(400, { error: 'Invalid JSON body' });
  }

  const entityType = body.entityType;
  if (!scope.entityTypes.includes(entityType)) {
    return res(400, {
      error: `Invalid entityType — must be one of ${scope.entityTypes.join(', ')}`,
    });
  }
  // A self-anchored type (sprint/inception, or intent) targets the scope root.
  const entityId = scope.selfTypes.includes(entityType)
    ? scope.rootId
    : String(body.entityId || '');
  if (!entityId) return res(400, { error: 'Missing entityId' });

  const anchorLabel = scope.anchorLabels[entityType];

  // Fast path: thread already exists — no lock.
  const existing = await query((g) => findDiscussionByAnchor(g, anchorLabel, entityId, entityType));
  if (existing) return res(200, existing);

  // Validate the anchor lives in this scope before creating anything.
  const anchorOk = await query((g) => anchorExistsInScope(g, scope, entityType, entityId));
  if (!anchorOk)
    return res(404, { error: `${entityType} "${entityId}" not found in ${scope.kind}` });

  const guardKey = `create:${scope.rootId}:${entityType}:${entityId}`;

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
      // create vertex + edges, delete the guard.
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
          scope,
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

    // Loser: short retry loop on the anchor lookup.
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

export const listMessages = async (event, res) => {
  const { discussionId } = event.pathParameters || {};
  const scope = resolveScope(event.pathParameters);
  const auth = await authorizeScope(scope, getCaller(event).sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
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
    // of older messages arrive too, not just new messages.
    const sorted = all.toSorted(compareBy('updatedAt'));
    const newer = sorted.filter(
      (m) => m.updatedAt > after.ts || (m.updatedAt === after.ts && m.id > after.id),
    );
    messages = newer.slice(0, limit);
    hasMore = newer.length > limit;
  } else if (before) {
    // Older history: display order (createdAt, id), latest `limit` strictly
    // before the cursor, returned ascending.
    const sorted = all.toSorted(compareBy('createdAt'));
    const older = sorted.filter(
      (m) => m.createdAt < before.ts || (m.createdAt === before.ts && m.id < before.id),
    );
    messages = older.slice(-limit);
    hasMore = older.length > limit;
  } else {
    // Seeding: the latest page in display order, returned ascending.
    const sorted = all.toSorted(compareBy('createdAt'));
    messages = sorted.slice(-limit);
    hasMore = sorted.length > limit;
  }

  return res(200, { messages, hasMore });
};

export const postMessage = async (event, res) => {
  const { discussionId } = event.pathParameters || {};
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
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

  // Mentions: server-validated against project members — non-members
  // stripped. Canonical (sorted, deduped) for storage and hashing.
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
        updatedAt: createdAt, // = created_at on create; bumped on redact
        discussionId,
        // DTO field is `sprintId` for the v1 wire contract; carries the scope
        // root id (sprintId or intentId).
        sprintId: scope.rootId,
      };

      await query((g) => createMessageVertex(g, { discussionId, scope, message }));
      await completeGuard(guardKey, ownerToken);

      // Server-driven fanout with the FULL persisted message — sender
      // included; delivery never depends on the sender's tab surviving.
      await broadcastToScope(scope, {
        action: 'discussion.message',
        sprintId: scope.rootId,
        discussionId,
        message,
      });

      // Per-user mention notifications (online, in-app only; self-mention
      // makes no sense to notify).
      const excerpt =
        content.length > MENTION_EXCERPT_LENGTH
          ? `${content.slice(0, MENTION_EXCERPT_LENGTH)}…`
          : content;
      await Promise.all(
        mentions
          .filter((userId) => userId !== caller.sub)
          .map((userId) =>
            broadcastToUser(userId, {
              action: 'notification',
              type: 'discussion.mention',
              sprintId: scope.rootId,
              discussionId,
              messageId,
              byName: caller.displayName,
              excerpt,
            }),
          ),
      );

      // Auto-advance the author's read cursor — your own message is read.
      // Best-effort: a failure only leaves a stale badge.
      await upsertReadCursor(caller.sub, discussionId, scope.rootId, createdAt, messageId).catch(
        (err) => console.error('Read-cursor auto-advance failed:', err.message),
      );

      return res(201, message);
    }

    // Condition failure → inspect the guard and branch.
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

export const updateDiscussion = async (event, res) => {
  const { discussionId } = event.pathParameters || {};
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
  if (!discussion) return res(404, { error: 'Discussion not found' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return res(400, { error: 'Invalid JSON body' });
  }

  const status = body.status;
  if (status !== 'open' && status !== 'resolved') {
    return res(400, { error: 'status must be "open" or "resolved"' });
  }
  const resolutionSummary =
    typeof body.resolutionSummary === 'string' ? body.resolutionSummary.slice(0, 2000) : '';
  const outcomeMessageId = typeof body.outcomeMessageId === 'string' ? body.outcomeMessageId : '';

  if (outcomeMessageId) {
    const outcome = await query((g) => fetchMessageInDiscussion(g, discussionId, outcomeMessageId));
    if (!outcome) return res(400, { error: 'outcomeMessageId is not a message of this thread' });
  }

  const now = new Date().toISOString();
  // Resolve sets the audit fields; reopen clears them — `resolved_by*` is
  // shown in the UI (member-level resolve is audited).
  const resolved = status === 'resolved';
  await query((g) =>
    g
      .V()
      .has('Discussion', 'id', discussionId)
      .has(scope.idProp, scope.rootId)
      .property(cardinality.single, 'status', status)
      .property(cardinality.single, 'resolved_by', resolved ? caller.sub : '')
      .property(cardinality.single, 'resolved_by_name', resolved ? caller.displayName : '')
      .property(cardinality.single, 'resolved_at', resolved ? now : '')
      .property(cardinality.single, 'resolution_summary', resolved ? resolutionSummary : '')
      .property(cardinality.single, 'outcome_message_id', resolved ? outcomeMessageId : '')
      .next(),
  );

  if (resolved && scope.timeline) {
    await query((g) =>
      g
        .V()
        .has('Sprint', 'id', scope.rootId)
        .as('s')
        .addV('TimelineEvent')
        .property('id', randomUUID())
        .property('type', 'discussion_resolved')
        .property('title', `Discussion resolved on ${getVal(discussion, 'entity_type')}`)
        .property('detail', resolutionSummary)
        .property('user_id', caller.sub)
        .property('user_name', caller.displayName)
        .property('timestamp', now)
        .property('sprint_id', scope.rootId)
        .property('question_id', '')
        .as('e')
        .addE('HAS_TIMELINE_EVENT')
        .from_('s')
        .to('e')
        .next(),
    );
  }

  await broadcastToScope(scope, {
    action: 'discussion.updated',
    sprintId: scope.rootId,
    discussionId,
    status,
    resolutionSummary: resolved ? resolutionSummary : undefined,
    outcomeMessageId: resolved && outcomeMessageId ? outcomeMessageId : undefined,
  });

  const updated = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
  return res(200, mapDiscussion(updated));
};

export const redactMessage = async (event, res) => {
  const { discussionId, messageId } = event.pathParameters || {};
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;
  if (auth.role !== 'admin' && auth.role !== 'owner') {
    return res(403, { error: 'Only project admins or owners can redact messages' });
  }

  const discussion = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
  if (!discussion) return res(404, { error: 'Discussion not found' });

  const vertex = await query((g) => fetchMessageInDiscussion(g, discussionId, messageId));
  if (!vertex) return res(404, { error: 'Message not found' });

  const now = new Date().toISOString();
  const replacement = REDACTION_PLACEHOLDER(caller.displayName);

  // The original content is REPLACED (purged from Neptune); the audit trail
  // is preserved. `updated_at` is bumped so the redaction propagates through
  // the (updatedAt, id) change delta to clients that missed the WS event.
  await query((g) =>
    g
      .V()
      .has('Discussion', 'id', discussionId)
      .out('HAS_MESSAGE')
      .has('DiscussionMessage', 'id', messageId)
      .property(cardinality.single, 'content', replacement)
      .property(cardinality.single, 'redacted', 'true')
      .property(cardinality.single, 'redacted_by', caller.sub)
      .property(cardinality.single, 'redacted_by_name', caller.displayName)
      .property(cardinality.single, 'redacted_at', now)
      .property(cardinality.single, 'updated_at', now)
      .next(),
  );

  if (scope.timeline) {
    await query((g) =>
      g
        .V()
        .has('Sprint', 'id', scope.rootId)
        .as('s')
        .addV('TimelineEvent')
        .property('id', randomUUID())
        .property('type', 'message_redacted')
        .property('title', 'Discussion message redacted')
        .property('detail', '')
        .property('user_id', caller.sub)
        .property('user_name', caller.displayName)
        .property('timestamp', now)
        .property('sprint_id', scope.rootId)
        .property('question_id', '')
        .as('e')
        .addE('HAS_TIMELINE_EVENT')
        .from_('s')
        .to('e')
        .next(),
    );
  }

  await broadcastToScope(scope, {
    action: 'discussion.message.redacted',
    sprintId: scope.rootId,
    discussionId,
    messageId,
    content: replacement,
    redactedBy: caller.displayName,
    updatedAt: now,
  });

  const updated = await query((g) => fetchMessageInDiscussion(g, discussionId, messageId));
  return res(200, mapMessage(updated));
};

export const markRead = async (event, res) => {
  const { discussionId } = event.pathParameters || {};
  const scope = resolveScope(event.pathParameters);
  const caller = getCaller(event);
  const auth = await authorizeScope(scope, caller.sub, res);
  if (auth.res) return auth.res;

  const discussion = await query((g) => fetchDiscussionInScope(g, scope, discussionId));
  if (!discussion) return res(404, { error: 'Discussion not found' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return res(400, { error: 'Invalid JSON body' });
  }
  const lastReadAt = typeof body.lastReadAt === 'string' ? body.lastReadAt : '';
  const lastReadMessageId =
    typeof body.lastReadMessageId === 'string' ? body.lastReadMessageId : '';
  if (!lastReadAt || !lastReadMessageId) {
    return res(400, { error: 'lastReadAt and lastReadMessageId are required' });
  }

  await upsertReadCursor(caller.sub, discussionId, scope.rootId, lastReadAt, lastReadMessageId);
  return res(200, { lastReadAt, lastReadMessageId });
};

export const searchDiscussions = async (event, res) => {
  const scope = resolveScope(event.pathParameters);
  const auth = await authorizeScope(scope, getCaller(event).sub, res);
  if (auth.res) return auth.res;

  const params = event.queryStringParameters || {};
  const q = (params.q || '').trim();
  if (q.length < SEARCH_MIN_QUERY) {
    return res(400, { error: `q must be at least ${SEARCH_MIN_QUERY} characters` });
  }
  let limit = Number(params.limit ?? SEARCH_MAX_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) limit = SEARCH_MAX_LIMIT;
  limit = Math.min(limit, SEARCH_MAX_LIMIT);
  const author = params.author || '';
  const status = params.status || '';
  const entityType = params.entityType || '';
  if (status && status !== 'open' && status !== 'resolved') {
    return res(400, { error: 'status must be "open" or "resolved"' });
  }
  if (entityType && !scope.entityTypes.includes(entityType)) {
    return res(400, { error: 'Invalid entityType filter' });
  }

  // Message-content matches, each with its parent thread.
  const messageRows = await query((g) => {
    let t = g
      .V()
      .has(scope.rootLabel, 'id', scope.rootId)
      .out('HAS_DISCUSSION')
      .hasLabel('Discussion');
    if (status) t = t.has('status', status);
    if (entityType) t = t.has('entity_type', entityType);
    t = t.as('d').out('HAS_MESSAGE').has('content', TextP.containing(q));
    if (author) t = t.has('author_id', author);
    return t
      .project('message', 'discussion')
      .by(__.valueMap())
      .by(__.select('d').valueMap())
      .limit(limit)
      .toList();
  });

  // Thread matches on the denormalized entity title (no author filter — the
  // title has no author).
  const threadRows = author
    ? []
    : await query((g) => {
        let t = g
          .V()
          .has(scope.rootLabel, 'id', scope.rootId)
          .out('HAS_DISCUSSION')
          .hasLabel('Discussion')
          .has('entity_title', TextP.containing(q));
        if (status) t = t.has('status', status);
        if (entityType) t = t.has('entity_type', entityType);
        return t.valueMap().limit(limit).toList();
      });

  const results = [
    ...messageRows.map((r) => ({
      discussion: mapDiscussion(r.get('discussion')),
      message: mapMessage(r.get('message')),
    })),
    ...threadRows.map((v) => ({ discussion: mapDiscussion(v) })),
  ];

  // Deduplicate thread-only hits whose thread already appears via a message
  // hit, newest activity first, bounded.
  const seenThreadOnly = new Set(results.filter((r) => r.message).map((r) => r.discussion.id));
  const deduped = results.filter((r) => r.message || !seenThreadOnly.has(r.discussion.id));
  deduped.sort((a, b) => {
    const aTs = a.message?.createdAt || a.discussion.lastMessageAt;
    const bTs = b.message?.createdAt || b.discussion.lastMessageAt;
    return aTs < bTs ? 1 : -1;
  });

  return res(200, { results: deduped.slice(0, limit) });
};
