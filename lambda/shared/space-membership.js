import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export const membershipKey = (spaceId, userId) => ({
  pk: `SPACE#${spaceId}`,
  sk: `MEMBER#${userId}`,
});

// Accepted only at the API/migration boundary. Persisted access roles have two values.
export const normalizeMembershipRole = (role) => (role === 'admin' ? 'owner' : role);
const validRole = (role) => role === 'owner' || role === 'member';
const conflict = () =>
  Object.assign(new Error('Membership changed. Reload and try again.'), { statusCode: 409 });

const encodeToken = (key) => (key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null);
const decodeToken = (token, expected) => {
  if (!token) return undefined;
  try {
    const key = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (
      typeof key.pk !== 'string' ||
      typeof key.sk !== 'string' ||
      !Object.entries(expected).every(([field, value]) => key[field] === value)
    )
      throw new Error();
    return key;
  } catch {
    throw Object.assign(new Error('Invalid continuation token'), { statusCode: 400 });
  }
};

export const createMembershipStore = ({
  ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})),
  accessTable = process.env.ACCESS_TABLE,
  auditTable = process.env.AUDIT_TABLE,
  now = () => new Date().toISOString(),
} = {}) => {
  const query = async (input, expected, token) => {
    const result = await ddb.send(
      new QueryCommand({
        ...input,
        Limit: 50,
        ExclusiveStartKey: decodeToken(token, expected),
      }),
    );
    return { items: result.Items || [], nextToken: encodeToken(result.LastEvaluatedKey) };
  };
  const get = async (spaceId, userId) => {
    if (!spaceId || !userId) return null;
    const result = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: membershipKey(spaceId, userId),
        ConsistentRead: true,
      }),
    );
    return validRole(result.Item?.membershipRole) ? result.Item : null;
  };
  const listMembers = (spaceId, token) =>
    query(
      {
        TableName: accessTable,
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `SPACE#${spaceId}`, ':prefix': 'MEMBER#' },
      },
      { pk: `SPACE#${spaceId}` },
      token,
    );
  const listUserSpaces = (userId, token) =>
    query(
      {
        TableName: accessTable,
        IndexName: 'by-user',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      },
      { userId },
      token,
    );
  const listHistory = (spaceId, { from, to, token } = {}) => {
    for (const time of [from, to]) {
      if (time && (!Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) {
        throw Object.assign(new Error('History dates must be ISO timestamps'), { statusCode: 400 });
      }
    }
    if (from && to && from > to) {
      throw Object.assign(new Error('History range is reversed'), { statusCode: 400 });
    }
    return query(
      {
        TableName: auditTable,
        ConsistentRead: true,
        ScanIndexForward: false,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `SPACE#${spaceId}`,
          ':from': `AUDIT#${from || ''}`,
          ':to': `AUDIT#${to || '\uffff'}#\uffff`,
        },
      },
      { pk: `SPACE#${spaceId}` },
      token,
    );
  };
  const hasOtherOwner = async (spaceId, userId) => {
    let nextToken;
    do {
      const page = await listMembers(spaceId, nextToken);
      if (page.items.some((m) => m.userId !== userId && m.membershipRole === 'owner')) return true;
      nextToken = page.nextToken;
    } while (nextToken);
    return false;
  };
  const change = async ({
    spaceId,
    userId,
    actorId,
    role,
    before = null,
    action,
    changeId = randomUUID(),
    migration = false,
  }) => {
    if (role !== null && !validRole(role)) throw new Error('Invalid membership role');
    const timestamp = now();
    const key = membershipKey(spaceId, userId);
    const after =
      role === null
        ? null
        : {
            ...key,
            userId,
            membershipRole: role,
            createdAt: before?.createdAt || timestamp,
            updatedAt: timestamp,
            revision: changeId,
          };
    const condition =
      before && !migration
        ? {
            ConditionExpression: 'revision = :revision',
            ExpressionAttributeValues: { ':revision': before.revision },
          }
        : { ConditionExpression: 'attribute_not_exists(pk)' };
    if (!migration && action !== 'space-created' && actorId === userId) {
      condition.ConditionExpression += ' AND membershipRole = :owner';
      condition.ExpressionAttributeValues = {
        ...condition.ExpressionAttributeValues,
        ':owner': 'owner',
      };
    }
    const writes = [
      after
        ? { Put: { TableName: accessTable, Item: after, ...condition } }
        : { Delete: { TableName: accessTable, Key: key, ...condition } },
      {
        Put: {
          TableName: auditTable,
          Item: {
            pk: key.pk,
            sk: `AUDIT#${timestamp}#${changeId}`,
            spaceId,
            actorId,
            action,
            targetUserId: userId,
            before,
            after,
            timestamp,
            changeId,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ];
    // Fence the actor's authority with the mutation, except for self-demotion/removal
    // where the membership write checks Owner access and revision on that record.
    if (!migration && action !== 'space-created' && actorId !== userId) {
      writes.push({
        ConditionCheck: {
          TableName: accessTable,
          Key: membershipKey(spaceId, actorId),
          ConditionExpression: 'membershipRole = :owner',
          ExpressionAttributeValues: { ':owner': 'owner' },
        },
      });
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
    } catch (error) {
      if (
        error.name === 'TransactionCanceledException' &&
        error.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')
      )
        throw conflict();
      throw error;
    }
    return after;
  };
  // Keep the deleting owner until every other page has drained. A failed batch
  // leaves that owner's permission intact so the existing delete can be retried.
  const deleteSpaceMembers = async (
    spaceId,
    actorId,
    { keepActor = false, beforeRemove = async () => {} } = {},
  ) => {
    let nextToken;
    do {
      const page = await listMembers(spaceId, nextToken);
      for (const member of page.items) {
        if (member.userId === actorId) continue;
        await beforeRemove(member.userId);
        await change({
          spaceId,
          userId: member.userId,
          actorId,
          role: null,
          before: member,
          action: 'space-deleted',
        });
      }
      nextToken = page.nextToken;
    } while (nextToken);
    if (!keepActor) {
      const before = await get(spaceId, actorId);
      if (before) {
        await beforeRemove(actorId);
        await change({
          spaceId,
          userId: actorId,
          actorId,
          role: null,
          before,
          action: 'space-deleted',
        });
      }
    }
  };
  return {
    get,
    listMembers,
    listUserSpaces,
    listHistory,
    hasOtherOwner,
    change,
    deleteSpaceMembers,
  };
};

export const membershipStore = createMembershipStore();

// The graph still owns resource lifecycle. A dangling access record never makes
// a missing Project accessible, and a database error never falls back to graph edges.
export const fetchMembershipRole = async (g, spaceId, userId, store = membershipStore) => {
  if (!userId || !(await g.V().has('Project', 'id', spaceId).hasNext())) return null;
  return (await store.get(spaceId, userId))?.membershipRole || null;
};
