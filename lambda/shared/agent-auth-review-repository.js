import { PutCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { assertIdentifier } from './agent-auth-protocol.js';
import { authScopeKey } from './agent-auth-inventory.js';
import { authReviewWrites } from './agent-auth-actions.js';

// Review persistence and locking; the action planner owns activation semantics.
export const createAgentAuthReviewRepository = ({
  ddb,
  tableName,
  get,
  requireTable,
  defaultConnectionId,
}) => ({
  async putReview(review) {
    requireTable();
    const { items: _items, ...storedReview } = review;
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: `AGENTAUTH#REVIEW#${review.id}`,
          sk: 'META',
          ...storedReview,
          type: 'AgentAuthReview',
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },
  async getReview(id) {
    requireTable();
    return get({ pk: `AGENTAUTH#REVIEW#${assertIdentifier(id, 'reviewId')}`, sk: 'META' });
  },
  async lockReview(review) {
    requireTable();
    const lock = {
      TableName: tableName,
      Key: authScopeKey(review.candidate),
      UpdateExpression:
        'SET pendingReview = :review, revision = :next, activityRevision = if_not_exists(activityRevision, :activity), #mode = if_not_exists(#mode, :mode), defaultConnectionId = if_not_exists(defaultConnectionId, :connection)',
      ConditionExpression:
        'attribute_not_exists(pendingReview) AND (attribute_not_exists(revision) OR revision = :revision) AND (attribute_not_exists(activityRevision) OR activityRevision = :activity)',
      ExpressionAttributeNames: { '#mode': 'mode' },
      ExpressionAttributeValues: {
        ':review': review.id,
        ':revision': review.policyRevision,
        ':next': review.policyRevision + 1,
        ':activity': review.activityRevision,
        ':mode': 'keys',
        ':connection': defaultConnectionId,
      },
    };
    if (review.configurationRevision === undefined) return ddb.send(new UpdateCommand(lock));
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: lock },
          {
            Update: {
              TableName: tableName,
              Key: authScopeKey(),
              UpdateExpression: 'ADD activityRevision :one',
              ConditionExpression:
                '(attribute_not_exists(revision) OR revision = :revision) AND attribute_not_exists(pendingReview)',
              ExpressionAttributeValues: { ':one': 1, ':revision': review.configurationRevision },
            },
          },
        ],
      }),
    );
  },
  async applyReview({ review, actorId, policy, now }) {
    requireTable();
    const { next, transactItems } = authReviewWrites({ review, actorId, policy, now, tableName });
    await ddb.send(
      new TransactWriteCommand({
        ClientRequestToken: review.id,
        TransactItems: transactItems,
      }),
    );
    return next;
  },
});
