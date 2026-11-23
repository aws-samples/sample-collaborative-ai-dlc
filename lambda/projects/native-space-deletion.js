import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../shared/native-space-inventory.js';
import { validateYjsScope, yjsScopeMarkerKey } from '../shared/yjs-scope-key.js';

// Atomically start the existing Yjs cleanup. A retry adopts an older Yjs
// tombstone and preserves its original timestamp, cursor and cleanup state.
export async function beginNativeSpaceDeletion({
  ddb,
  tableName,
  yjsTable,
  projectId,
  projectIdentity,
  now = Date.now(),
}) {
  if (!tableName || !yjsTable) return 'unavailable';
  validateYjsScope('project', projectId);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: nativeSpaceRetentionKey(projectId),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: nativeSpaceInventoryKey,
              ConditionExpression: '#version = :version',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':version': 1 },
            },
          },
          {
            Update: {
              TableName: yjsTable,
              Key: yjsScopeMarkerKey('project', projectId),
              ConditionExpression:
                'attribute_not_exists(projectIdentity) OR projectIdentity = :identity',
              UpdateExpression:
                'SET projectIdentity = :identity, deletedAt = if_not_exists(deletedAt, :now), ' +
                'cleanupPartition = if_not_exists(cleanupPartition, :partition), ' +
                'cleanupAfter = if_not_exists(cleanupAfter, :after), ' +
                'cleanupState = if_not_exists(cleanupState, :pending)',
              ExpressionAttributeValues: {
                ':identity': projectIdentity,
                ':now': now,
                ':partition': 'DELETED',
                ':after': now + 60_000,
                ':pending': 'pending',
              },
            },
          },
        ],
      }),
    );
    return 'started';
  } catch (error) {
    if (
      error.name === 'TransactionCanceledException' &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    )
      return 'retained';
    return 'unavailable';
  }
}
