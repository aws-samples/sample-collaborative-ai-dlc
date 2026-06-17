// lambda/discussions — data-access layer. Neptune graph reads/writes and the
// DynamoDB locks / read-state access. No HTTP shapes here; callers pass plain
// args and receive vertices or mapped DTOs.

import { randomUUID } from 'node:crypto';
import { PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, cardinality, order, __, locksTable, readStateTable } from './clients.js';
import { ANCHOR_LABELS, MESSAGE_GUARD_COMPLETE_SECONDS } from './constants.js';
import { getVal, mapDiscussion, nowSeconds, isConditionalCheckFailed } from './mappers.js';

// ─── Read cursors (DynamoDB) ───

export const upsertReadCursor = async (
  userId,
  discussionId,
  sprintId,
  lastReadAt,
  lastReadMessageId,
) => {
  if (!readStateTable()) return;
  await ddb.send(
    new PutCommand({
      TableName: readStateTable(),
      Item: { userId, discussionId, sprintId, lastReadAt, lastReadMessageId },
    }),
  );
};

export const fetchReadCursors = async (userId, sprintId) => {
  if (!readStateTable()) return new Map();
  const result = await ddb.send(
    new QueryCommand({
      TableName: readStateTable(),
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'sprintId = :sid',
      ExpressionAttributeValues: { ':uid': userId, ':sid': sprintId },
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

// ─── Discussion / anchor graph reads ───

export const findDiscussionByAnchor = async (g, anchorLabel, entityId, entityType) => {
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

export const anchorExistsInSprint = async (g, sprintId, entityType, entityId) => {
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

export const fetchAnchorTitle = async (g, anchorLabel, entityId) => {
  const r = await g.V().has(anchorLabel, 'id', entityId).valueMap('title', 'name').next();
  if (r.done || !r.value) return '';
  return getVal(r.value, 'title') || getVal(r.value, 'name') || '';
};

export const createDiscussionVertex = async (
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

  // `discussion_started` TimelineEvent on first creation.
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

export const fetchDiscussionInSprint = async (g, sprintId, discussionId) => {
  const r = await g
    .V()
    .has('Discussion', 'id', discussionId)
    .has('sprint_id', sprintId)
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

export const createMessageVertex = async (g, { discussionId, sprintId, message }) => {
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
