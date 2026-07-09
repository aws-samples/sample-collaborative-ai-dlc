// lambda/discussions — data-access layer. Neptune graph reads/writes and the
// DynamoDB locks / read-state access. No HTTP shapes here; callers pass plain
// args and receive vertices or mapped DTOs.

import { randomUUID } from 'node:crypto';
import { PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, cardinality, order, __, locksTable, readStateTable } from './clients.js';
import { MESSAGE_GUARD_COMPLETE_SECONDS } from './constants.js';
import { getVal, mapDiscussion, nowSeconds, isConditionalCheckFailed } from './mappers.js';

// ─── Read cursors (DynamoDB) ───
//
// The read-state table scopes a user's cursors to one root via the `sprintId`
// attribute (kept under that legacy name — it is an internal filter, not part of
// any external contract). It holds the scope ROOT id: a sprintId or an intentId.

export const upsertReadCursor = async (
  userId,
  discussionId,
  scopeRootId,
  lastReadAt,
  lastReadMessageId,
) => {
  if (!readStateTable()) return;
  await ddb.send(
    new PutCommand({
      TableName: readStateTable(),
      Item: { userId, discussionId, sprintId: scopeRootId, lastReadAt, lastReadMessageId },
    }),
  );
};

export const fetchReadCursors = async (userId, scopeRootId) => {
  if (!readStateTable()) return new Map();
  const result = await ddb.send(
    new QueryCommand({
      TableName: readStateTable(),
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'sprintId = :sid',
      ExpressionAttributeValues: { ':uid': userId, ':sid': scopeRootId },
    }),
  );
  return new Map((result.Items || []).map((item) => [item.discussionId, item]));
};

// ─── Authorization graph lookup ───

// Resolve the project a sprint belongs to (Project -HAS_SPRINT-> Sprint).
export const fetchProjectIdForSprint = async (g, sprintId) => {
  const r = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .in_('HAS_SPRINT')
    .hasLabel('Project')
    .values('id')
    .next();
  return r.done ? null : r.value;
};

// Resolve the project an intent belongs to (the Intent vertex carries project_id,
// set by init-ws). Used to authorize intent-scoped discussions.
export const fetchProjectIdForIntent = async (g, intentId) => {
  const r = await g.V().has('Intent', 'id', intentId).values('project_id').next();
  return r.done ? null : r.value;
};

// ─── Discussion / anchor graph reads ───

// Scope an anchor-vertex lookup by intent when the anchor's id space is
// intent-local. Agent-chosen Artifact ids are only unique WITHIN an intent, so
// a bare `has('Artifact','id',entityId)` can resolve a same-id artifact in a
// DIFFERENT intent and bind a discussion thread to the wrong vertex. A no-op
// for sprint scope and for self-anchored roots (Intent/Sprint ids are global).
const scopeAnchor = (traversal, scope, anchorLabel) =>
  scope?.kind === 'intent' && anchorLabel === scope.anchorLabels.artifact
    ? traversal.has('intent_id', scope.rootId)
    : traversal;

export const findDiscussionByAnchor = async (
  g,
  anchorLabel,
  entityId,
  entityType,
  scope = null,
) => {
  const r = await scopeAnchor(g.V().has(anchorLabel, 'id', entityId), scope, anchorLabel)
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

// Does the anchor (entityType, entityId) exist under this scope's root vertex?
// - sprint: `sprint`/`inception` self-anchor on the Sprint; others hang off it
//   via CONTAINS (or HAS_REVIEW for `review`) — original v1 behaviour verbatim.
// - intent: `intent` self-anchors on the Intent; `artifact` and `question`
//   hang off it via CONTAINS (the same edge init-ws/graph-writer use for
//   produced artifacts and mirrored question gates).
export const anchorExistsInScope = async (g, scope, entityType, entityId) => {
  if (scope.kind === 'intent') {
    if (entityType === 'intent') return entityId === scope.rootId;
    if (entityType === 'artifact' || entityType === 'question') {
      return g
        .V()
        .has('Intent', 'id', scope.rootId)
        .out('CONTAINS')
        .hasLabel(scope.anchorLabels[entityType])
        .has('id', entityId)
        .hasNext();
    }
    return false;
  }
  // sprint scope (unchanged)
  if (entityType === 'sprint' || entityType === 'inception') return entityId === scope.rootId;
  const edge = entityType === 'review' ? 'HAS_REVIEW' : 'CONTAINS';
  const r = await g
    .V()
    .has('Sprint', 'id', scope.rootId)
    .out(edge)
    .hasLabel(scope.anchorLabels[entityType])
    .has('id', entityId)
    .hasNext();
  return r;
};

export const fetchAnchorTitle = async (g, anchorLabel, entityId, scope = null) => {
  const r = await scopeAnchor(g.V().has(anchorLabel, 'id', entityId), scope, anchorLabel)
    .valueMap('title', 'name')
    .next();
  if (r.done || !r.value) return '';
  return getVal(r.value, 'title') || getVal(r.value, 'name') || '';
};

export const createDiscussionVertex = async (
  g,
  { id, scope, entityType, entityId, entityTitle, createdAt, sub, displayName },
) => {
  const anchorLabel = scope.anchorLabels[entityType];
  // The Discussion vertex carries the scope-root id under its scope-specific
  // property (sprint_id | intent_id) AND hangs off the root via HAS_DISCUSSION,
  // plus a DISCUSSES edge to the concrete anchor. Sprint scope reproduces the
  // original graph exactly. The anchor bind is intent-scoped for artifacts
  // (scopeAnchor) so a same-id artifact in another intent is never targeted.
  await scopeAnchor(
    g.V().has(scope.rootLabel, 'id', scope.rootId).as('s').V().has(anchorLabel, 'id', entityId),
    scope,
    anchorLabel,
  )
    .as('a')
    .addV('Discussion')
    .property('id', id)
    .property('entity_type', entityType)
    .property('entity_id', entityId)
    .property('entity_title', entityTitle)
    .property(scope.idProp, scope.rootId)
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

  // `discussion_started` TimelineEvent on first creation — sprint scope only
  // (v2 process events live in the v2 process table, not the Sprint timeline).
  if (scope.timeline) {
    await g
      .V()
      .has('Sprint', 'id', scope.rootId)
      .as('s')
      .addV('TimelineEvent')
      .property('id', randomUUID())
      .property('type', 'discussion_started')
      .property('title', `Discussion started on ${entityType}`)
      .property('detail', entityTitle || '')
      .property('user_id', sub)
      .property('user_name', displayName)
      .property('timestamp', createdAt)
      .property('sprint_id', scope.rootId)
      .property('question_id', '')
      .as('e')
      .addE('HAS_TIMELINE_EVENT')
      .from_('s')
      .to('e')
      .next();
  }
};

export const fetchDiscussionInScope = async (g, scope, discussionId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .has(scope.idProp, scope.rootId)
    .valueMap()
    .next();
  return r.done ? null : r.value;
};

// ─── Message graph reads/writes ───

export const fetchMessageInDiscussion = async (g, discussionId, messageId) => {
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

export const fetchMessageByRequestId = async (g, discussionId, requestId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .out('HAS_MESSAGE')
    .hasLabel('DiscussionMessage')
    .has('request_id', requestId)
    .valueMap()
    .next();
  return r.done ? null : r.value;
};

export const createMessageVertex = async (g, { discussionId, scope, message }) => {
  let t = g
    .V()
    .has('Discussion', 'id', discussionId)
    .as('d')
    .addV('DiscussionMessage')
    .property('id', message.id)
    .property('content', message.content)
    .property('author_id', message.authorId)
    .property('author_name', message.authorName)
    .property('author_type', message.authorType || 'user')
    .property('mentions', JSON.stringify(message.mentions))
    .property('created_at', message.createdAt)
    .property('updated_at', message.updatedAt)
    .property('discussion_id', discussionId)
    .property(scope.idProp, scope.rootId);
  if (message.requestId) t = t.property('request_id', message.requestId);
  if (message.command) t = t.property('command', message.command);
  if (message.requestedBy) t = t.property('requested_by', message.requestedBy);
  if (message.requestedByName) t = t.property('requested_by_name', message.requestedByName);
  if (message.assistStatus) t = t.property('assist_status', message.assistStatus);
  await t
    .as('m')
    .addE('HAS_MESSAGE')
    .from_('d')
    .to('m')
    .select('d')
    .property(cardinality.single, 'last_message_at', message.createdAt)
    .next();
};

export const updateAssistMessageVertex = async (
  g,
  { discussionId, scope, messageId, content, assistStatus, updatedAt },
) => {
  await g
    .V()
    .has('DiscussionMessage', 'id', messageId)
    .has('discussion_id', discussionId)
    .has(scope.idProp, scope.rootId)
    .property(cardinality.single, 'content', content)
    .property(cardinality.single, 'assist_status', assistStatus)
    .property(cardinality.single, 'updated_at', updatedAt)
    .next();
};

export const fetchProjectMemberIds = async (g, projectId) => {
  return g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_MEMBER')
    .hasLabel('User')
    .values('id')
    .toList();
};

// ─── Message guard completion (DynamoDB) ───

export const completeGuard = async (guardKey, ownerToken) => {
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
