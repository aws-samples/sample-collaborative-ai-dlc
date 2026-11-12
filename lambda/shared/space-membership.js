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

const hasAnotherOwner = async (ddb, spaceId, targetUserId) => {
  let token;
  do {
    const page = await listSpaceMembers(ddb, spaceId, { token });
    if (
      page.items.some((item) => item.userId !== targetUserId && item.membershipRole === ROLE_OWNER)
    ) {
      return true;
    }
    token = page.nextToken;
  } while (token);
  return false;
};

const assertOwnerChangeAllowed = async (ddb, spaceId, targetUserId, before, nextRole) => {
  const previousRole = before?.membershipRole
    ? normalizeMembershipRole(before.membershipRole)
    : null;
  const normalizedNextRole = nextRole == null ? null : normalizeMembershipRole(nextRole);
  if (previousRole !== ROLE_OWNER || normalizedNextRole === ROLE_OWNER) return;
  if (!(await hasAnotherOwner(ddb, spaceId, targetUserId))) {
    const error = new Error('Cannot remove or demote the last owner. Transfer ownership first.');
    error.code = 'LAST_OWNER';
    throw error;
  }
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
  await assertOwnerChangeAllowed(ddb, spaceId, targetUserId, before, membershipRole);
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
  await assertOwnerChangeAllowed(ddb, spaceId, targetUserId, before, null);
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
  await ddb.send(new TransactWriteCommand({ TransactItems: transaction }));
  return true;
};

const deleteSpaceMemberships = async (ddb, spaceId, { preserveUserId } = {}) => {
  let preserved;
  let token;
  do {
    const page = await listSpaceMembers(ddb, spaceId, { token });
    for (const item of page.items) {
      if (item.userId === preserveUserId) {
        preserved = item;
        continue;
      }
      await ddb.send(
        new DeleteCommand({
          TableName: accessTable(),
          Key: { pk: item.pk, sk: item.sk },
        }),
      );
    }
    token = page.nextToken;
  } while (token);
  if (preserved) {
    await ddb.send(
      new DeleteCommand({
        TableName: accessTable(),
        Key: { pk: preserved.pk, sk: preserved.sk },
      }),
    );
  }
};

export {
  BY_USER_INDEX,
  PAGE_SIZE,
  ROLE_MEMBER,
  ROLE_OWNER,
  accessTable,
  assertOwnerChangeAllowed,
  auditTable,
  decodeToken,
  deleteSpaceMemberships,
  encodeToken,
  getMembership,
  getMembershipRole,
  hasAnotherOwner,
  listAuditHistory,
  listSpaceMembers,
  listUserSpaces,
  memberKey,
  membershipKey,
  normalizeMembershipRole,
  removeMembership,
  saveMembershipChange,
  spaceKey,
};
