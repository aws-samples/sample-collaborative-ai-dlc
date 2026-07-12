// lambda/discussions — data-access layer. Neptune graph reads/writes and the
// DynamoDB locks / read-state access. No HTTP shapes here; callers pass plain
// args and receive vertices or mapped DTOs.

import { randomUUID } from 'node:crypto';
import { PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, cardinality, order, __, P, locksTable, readStateTable } from './clients.js';
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

// Append the per-type anchor-positioning steps to a traversal already at a
// vertex-start boundary (a fresh `g.V()` or a mid-traversal `.V()`). Factored
// out so both anchorTraversal (reads/exists/title) and createDiscussionVertex
// (which must first alias the root) share ONE definition of each anchor bind.
const anchorSteps = (t, scope, entityType, entityId) => {
  const anchorLabel = scope.anchorLabels[entityType];
  if (scope.kind === 'intent') {
    if (entityType === 'intent' || scope.rootAnchorTypes?.includes(entityType)) {
      return t.has('Intent', 'id', scope.rootId);
    }
    if (entityType === 'item') {
      // Both hops must be CURRENT: a rewind-superseded parent Artifact hides its
      // items even when the item row's own superseded_at is still '' — matching
      // the knowledge-graph read (currentArtifactIds filter in
      // intents/knowledge-graph.js). "Current" = superseded_at absent OR '',
      // expressed as "no non-empty value".
      return t
        .has('Intent', 'id', scope.rootId)
        .out('CONTAINS')
        .hasLabel('Artifact')
        .not(__.has('superseded_at', P.neq('')))
        .out('HAS_ITEM')
        .has('id', entityId)
        .not(__.has('superseded_at', P.neq('')));
    }
    // artifact / question
    let hop = t.has('Intent', 'id', scope.rootId).out('CONTAINS').hasLabel(anchorLabel);
    if (anchorLabel === scope.anchorLabels.artifact) hop = hop.has('intent_id', scope.rootId);
    return hop.has('id', entityId);
  }
  // sprint scope
  if (entityType === 'sprint' || entityType === 'inception') {
    return t.has('Sprint', 'id', scope.rootId);
  }
  const edge = entityType === 'review' ? 'HAS_REVIEW' : 'CONTAINS';
  return t.has('Sprint', 'id', scope.rootId).out(edge).hasLabel(anchorLabel).has('id', entityId);
};

// Position a fresh traversal ON the anchor vertex for (entityType, entityId)
// under this scope's root. ONE place defines every entity type's anchor bind,
// so the read/exists/create/title ops can never drift. Notable binds:
// - artifact → Intent --CONTAINS--> Artifact, scoped by intent_id (agent-chosen
//   Artifact ids are unique only WITHIN an intent).
// - item → Intent --CONTAINS--> Artifact --HAS_ITEM--> item: walked THROUGH the
//   root so it can never leave this intent, label-agnostic (all seven derived
//   labels), CURRENT rows only — "current" = superseded_at absent OR '' (matches
//   shared/graph-rows.js isCurrentRow), expressed as "no non-empty value".
const anchorTraversal = (g, scope, entityType, entityId) =>
  anchorSteps(g.V(), scope, entityType, entityId);

export const findDiscussionByAnchor = async (
  g,
  anchorLabel,
  entityId,
  entityType,
  scope = null,
) => {
  const r = await anchorTraversal(g, scope, entityType, entityId)
    .in_('DISCUSSES')
    .hasLabel('Discussion')
    .has('entity_type', entityType)
    .has('entity_id', entityId)
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
// Self-anchored roots need only an id match; everything else must resolve via
// the scoped anchorTraversal (which already applies scope/current-row guards).
export const anchorExistsInScope = async (g, scope, entityType, entityId) => {
  if (scope.kind === 'intent') {
    if (entityType === 'intent') return entityId === scope.rootId;
    if (scope.rootAnchorTypes?.includes(entityType)) return Boolean(entityId);
    return anchorTraversal(g, scope, entityType, entityId).hasNext();
  }
  // sprint scope
  if (entityType === 'sprint' || entityType === 'inception') return entityId === scope.rootId;
  return anchorTraversal(g, scope, entityType, entityId).hasNext();
};

export const fetchAnchorTitle = async (
  g,
  anchorLabel,
  entityId,
  scope = null,
  entityType = null,
) => {
  const r = await anchorTraversal(g, scope, entityType, entityId).valueMap('title', 'name').next();
  if (r.done || !r.value) return '';
  return getVal(r.value, 'title') || getVal(r.value, 'name') || '';
};

export const createDiscussionVertex = async (
  g,
  { id, scope, entityType, entityId, entityTitle, createdAt, sub, displayName },
) => {
  // The Discussion vertex carries the scope-root id under its scope-specific
  // property (sprint_id | intent_id) AND hangs off the root via HAS_DISCUSSION,
  // plus a DISCUSSES edge to the concrete anchor. Bind the root as 's', then
  // re-enter via anchorSteps to position on the anchor as 'a' — the SAME scoped
  // bind the reads use, so the DISCUSSES edge can never target the wrong vertex.
  await anchorSteps(
    g.V().has(scope.rootLabel, 'id', scope.rootId).as('s').V(),
    scope,
    entityType,
    entityId,
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
