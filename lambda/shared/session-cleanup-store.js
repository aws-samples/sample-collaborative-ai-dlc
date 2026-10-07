// Durable ownership of pending session releases.
//
// On the AgentCore Instances compute type a session keeps its EBS workspace
// volume (and its storage charges) until DeleteCapacityProviderSession is
// called. When that delete fails for anything other than a confirmed-absent
// session, the provider/session identity is persisted here so a poller can
// retry until the release succeeds — the caller's own state (a revision row,
// an intent partition) may be gone by then. This module is the ONLY writer and
// reader of the SESSION_CLEANUP# records; both the managed-environments
// poller and the intent-deletion cascade queue through it.
//
// Storage: the environment registry table. pk-per-session keeps the write
// idempotent (queueing the same session twice is a no-op overwrite); the
// GSI1 'SESSION_CLEANUP' partition follows the existing overloaded-GSI1
// pattern (ENVIRONMENTS, REVISION_STATUS#*) so the poller lists pending work
// without a scan.

import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const PARTITION = 'SESSION_CLEANUP';

const keyFor = (sessionId) => ({ pk: `${PARTITION}#${sessionId}`, sk: 'LOOKUP' });

const queryAll = async (ddb, input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

export const createSessionCleanupStore = ({
  ddb,
  tableName,
  clock = () => new Date().toISOString(),
} = {}) => {
  const table = () => tableName ?? process.env.ENVIRONMENT_REGISTRY_TABLE;

  // Queue a release that failed. `source` records who queued it (validation,
  // intent-deletion) and `context` any ids useful to an operator.
  const enqueue = async ({
    sessionId,
    capacityProviderArn,
    source = null,
    reason = null,
    context = {},
  }) => {
    if (!sessionId || !capacityProviderArn) return null;
    const createdAt = clock();
    const item = {
      ...keyFor(sessionId),
      GSI1PK: PARTITION,
      GSI1SK: `${createdAt}#${sessionId}`,
      type: 'SessionCleanup',
      sessionId,
      capacityProviderArn,
      source,
      reason,
      ...context,
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  const listPending = async () =>
    queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': PARTITION },
    });

  const recordAttempt = async (sessionId, reason = null) => {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: keyFor(sessionId),
        UpdateExpression:
          'SET attempts = if_not_exists(attempts, :zero) + :one, reason = :reason, updatedAt = :ts',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':reason': reason, ':ts': clock() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  const remove = async (sessionId) => {
    await ddb.send(new DeleteCommand({ TableName: table(), Key: keyFor(sessionId) }));
  };

  return { enqueue, listPending, recordAttempt, remove };
};

export default { createSessionCleanupStore };
