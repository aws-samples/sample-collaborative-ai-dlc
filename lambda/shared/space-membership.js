import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const PAGE_SIZE = 50;
const BY_USER_INDEX = 'by-user';
const ROLE_OWNER = 'owner';
const ROLE_MEMBER = 'member';

const accessTable = () => {
  if (!process.env.ACCESS_TABLE) throw new Error('ACCESS_TABLE is required');
  return process.env.ACCESS_TABLE;
};

const auditTable = () => {
  if (!process.env.AUDIT_TABLE) throw new Error('AUDIT_TABLE is required');
  return process.env.AUDIT_TABLE;
};

const spaceKey = (spaceId) => `SPACE#${spaceId}`;
const memberKey = (userId) => `MEMBER#${userId}`;
const ownerGuardKey = () => 'OWNER_GUARD';

const normalizeMembershipRole = (role) => {
  if (role === 'owner' || role === 'admin') return ROLE_OWNER;
  if (role === 'member') return ROLE_MEMBER;
  throw new Error('membershipRole must be owner or member');
};

const encodeToken = (key) =>
  key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;

const decodeToken = (token) => {
  if (!token) return undefined;
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('Invalid continuation token');
    error.code = 'INVALID_CONTINUATION_TOKEN';
    throw error;
  }
};

const membershipKey = (spaceId, userId) => ({
  pk: spaceKey(spaceId),
  sk: memberKey(userId),
});

const getMembership = async (ddb, spaceId, userId) => {
  if (!spaceId || !userId) return null;
  const result = await ddb.send(
    new GetCommand({
      TableName: accessTable(),
      Key: membershipKey(spaceId, userId),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  return {
    ...result.Item,
    membershipRole: normalizeMembershipRole(result.Item.membershipRole),
  };
};

const getMembershipRole = async (ddb, spaceId, userId) =>
  (await getMembership(ddb, spaceId, userId))?.membershipRole ?? null;

const listSpaceMembers = async (ddb, spaceId, { token, limit = PAGE_SIZE } = {}) => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: accessTable(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :member)',
      ExpressionAttributeValues: {
        ':pk': spaceKey(spaceId),
        ':member': 'MEMBER#',
      },
      ConsistentRead: true,
      ExclusiveStartKey: decodeToken(token),
      Limit: Math.min(PAGE_SIZE, Math.max(1, limit)),
    }),
  );
  return {
    items: (result.Items ?? []).map((item) => ({
      ...item,
      membershipRole: normalizeMembershipRole(item.membershipRole),
    })),
    nextToken: encodeToken(result.LastEvaluatedKey),
  };
};

const listUserSpaces = async (ddb, userId, { token, limit = PAGE_SIZE } = {}) => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: accessTable(),
      IndexName: BY_USER_INDEX,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ExclusiveStartKey: decodeToken(token),
      Limit: Math.min(PAGE_SIZE, Math.max(1, limit)),
    }),
  );
  return {
    items: (result.Items ?? []).map((item) => ({
      ...item,
      membershipRole: normalizeMembershipRole(item.membershipRole),
    })),
    nextToken: encodeToken(result.LastEvaluatedKey),
  };
};

const listAuditHistory = async (
  ddb,
  spaceId,
  { from = '', to = '\uffff', token, limit = PAGE_SIZE, newestFirst = true } = {},
) => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: auditTable(),
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': spaceKey(spaceId),
        ':from': `AUDIT#${from}`,
        ':to': `AUDIT#${to}`,
      },
      ExclusiveStartKey: decodeToken(token),
      Limit: Math.min(PAGE_SIZE, Math.max(1, limit)),
      ScanIndexForward: !newestFirst,
    }),
  );
  return { items: result.Items ?? [], nextToken: encodeToken(result.LastEvaluatedKey) };
};

const auditItem = ({ spaceId, actorId, action, targetUserId, before, after, now, changeId }) => ({
  pk: spaceKey(spaceId),
  sk: `AUDIT#${now}#${changeId}`,
  spaceId,
  actorId,
  action,
  targetUserId,
  before: before ?? null,
  after: after ?? null,
  changedAt: now,
  changeId,
});

const saveMembershipChange = async (
  ddb,
  {
    spaceId,
    actorId,
    targetUserId,
    role,
    before = null,
    action = before ? 'role_changed' : 'member_added',
    now = new Date().toISOString(),
    changeId = randomUUID(),
  },
) => {
  const membershipRole = normalizeMembershipRole(role);
  const previousRole = before?.membershipRole
    ? normalizeMembershipRole(before.membershipRole)
    : null;
  const ownerDelta = Number(membershipRole === ROLE_OWNER) - Number(previousRole === ROLE_OWNER);
  const item = {
    ...membershipKey(spaceId, targetUserId),
    spaceId,
    userId: targetUserId,
    membershipRole,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  const transaction = [
    {
      Put: {
        TableName: accessTable(),
        Item: item,
        ConditionExpression: before ? 'attribute_exists(pk)' : 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: auditTable(),
        Item: auditItem({
          spaceId,
          actorId,
          action,
          targetUserId,
          before,
          after: item,
          now,
          changeId,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ];
  if (ownerDelta) {
    transaction.push({
      Update: {
        TableName: accessTable(),
        Key: { pk: spaceKey(spaceId), sk: ownerGuardKey() },
        UpdateExpression: 'ADD ownerCount :delta SET updatedAt = :now',
        ConditionExpression: ownerDelta < 0 ? 'ownerCount > :minimum' : undefined,
        ExpressionAttributeValues: {
          ':delta': ownerDelta,
          ':now': now,
          ...(ownerDelta < 0 ? { ':minimum': 1 } : {}),
        },
      },
    });
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: transaction }));
  return item;
};

const removeMembership = async (
  ddb,
  {
    spaceId,
    actorId,
    targetUserId,
    before,
    now = new Date().toISOString(),
    changeId = randomUUID(),
  },
) => {
  if (!before) return false;
  const previousRole = normalizeMembershipRole(before.membershipRole);
  const transaction = [
    {
      Delete: {
        TableName: accessTable(),
        Key: membershipKey(spaceId, targetUserId),
        ConditionExpression: 'membershipRole = :role',
        ExpressionAttributeValues: { ':role': previousRole },
      },
    },
    {
      Put: {
        TableName: auditTable(),
        Item: auditItem({
          spaceId,
          actorId,
          action: 'member_removed',
          targetUserId,
          before,
          after: null,
          now,
          changeId,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
  ];
  if (previousRole === ROLE_OWNER) {
    transaction.push({
      Update: {
        TableName: accessTable(),
        Key: { pk: spaceKey(spaceId), sk: ownerGuardKey() },
        UpdateExpression: 'ADD ownerCount :delta SET updatedAt = :now',
        ConditionExpression: 'ownerCount > :minimum',
        ExpressionAttributeValues: { ':delta': -1, ':minimum': 1, ':now': now },
      },
    });
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: transaction }));
  return true;
};

const deleteSpaceMemberships = async (ddb, spaceId) => {
  let token;
  do {
    const page = await listSpaceMembers(ddb, spaceId, { token });
    for (const item of page.items) {
      await ddb.send(
        new DeleteCommand({
          TableName: accessTable(),
          Key: { pk: item.pk, sk: item.sk },
        }),
      );
    }
    token = page.nextToken;
  } while (token);
  await ddb.send(
    new DeleteCommand({
      TableName: accessTable(),
      Key: { pk: spaceKey(spaceId), sk: ownerGuardKey() },
    }),
  );
};

export {
  BY_USER_INDEX,
  PAGE_SIZE,
  ROLE_MEMBER,
  ROLE_OWNER,
  accessTable,
  auditTable,
  decodeToken,
  deleteSpaceMemberships,
  encodeToken,
  getMembership,
  getMembershipRole,
  listAuditHistory,
  listSpaceMembers,
  listUserSpaces,
  memberKey,
  membershipKey,
  normalizeMembershipRole,
  ownerGuardKey,
  removeMembership,
  saveMembershipChange,
  spaceKey,
};
