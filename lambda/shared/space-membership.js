import { randomUUID } from 'node:crypto';
import {
  normalizeExcludedRoles,
  normalizeLocalRoles,
  normalizeRoleMappings,
} from './business-roles.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export const membershipKey = (spaceId, userId) => ({
  pk: `SPACE#${spaceId}`,
  sk: `MEMBER#${userId}`,
});

// Business-role mappings saved from the Platform admin UI: one item per
// configured SSO connection. No userId field, so the by-user GSI skips it.
export const ssoMappingKey = (providerId) => ({ pk: 'PLATFORM', sk: `SSO#${providerId}` });

// SSO claims recorded at each federated sign-in (and once by the deployment
// backfill): the provider, the configured source attribute and its raw claim
// values, never calculated roles, so mapping changes apply on the next read.
// The subject is not named `userId`, so the by-user GSI skips the item.
export const ssoClaimsKey = (subject) => ({ pk: `USER#${subject}`, sk: 'SSO' });

// Stay clearly below DynamoDB's 400 KB item limit for the mapping and its audit
// record; the serialized form approximates the stored item size.
const MAX_ITEM_BYTES = 350_000;

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
    localRoles,
    excludedRoles,
  }) => {
    if (role !== null && !validRole(role)) throw new Error('Invalid membership role');
    // Role-list updates change exactly one field and leave membership intact.
    const roleField =
      localRoles !== undefined
        ? { name: 'localRoles', roles: normalizeLocalRoles(localRoles) }
        : excludedRoles !== undefined
          ? { name: 'excludedRoles', roles: normalizeExcludedRoles(excludedRoles) }
          : null;
    const timestamp = now();
    const key = membershipKey(spaceId, userId);
    const after =
      role === null
        ? null
        : {
            ...before,
            ...key,
            userId,
            membershipRole: role,
            createdAt: before?.createdAt || timestamp,
            updatedAt: timestamp,
            revision: changeId,
            ...(roleField ? { [roleField.name]: roleField.roles } : {}),
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
      roleField
        ? {
            Update: {
              TableName: accessTable,
              Key: key,
              ...condition,
              UpdateExpression: `SET ${roleField.name} = :roles, updatedAt = :timestamp, revision = :next`,
              ExpressionAttributeValues: {
                ...condition.ExpressionAttributeValues,
                ':roles': roleField.roles,
                ':timestamp': timestamp,
                ':next': changeId,
              },
            },
          }
        : after
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
            before: roleField ? before[roleField.name] || [] : before,
            after: roleField ? roleField.roles : after,
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
  const changeLocalRoles = async ({ spaceId, userId, actorId, localRoles, changeId }) => {
    const roles = normalizeLocalRoles(localRoles);
    const before = await get(spaceId, userId);
    if (!before) throw Object.assign(new Error('Member not found'), { statusCode: 404 });
    return change({
      spaceId,
      userId,
      actorId,
      before,
      role: before.membershipRole,
      localRoles: roles,
      action: 'local-roles-changed',
      changeId,
    });
  };
  // Exclusions apply to roles inherited through SSO. A new exclusion must target
  // a role the member currently inherits; existing exclusions may always be kept
  // or restored, so a company-group change never locks an exclusion in place.
  const changeExcludedRoles = async ({
    spaceId,
    userId,
    actorId,
    excludedRoles,
    inheritedSsoRoles = [],
    changeId,
  }) => {
    const roles = normalizeExcludedRoles(excludedRoles);
    const before = await get(spaceId, userId);
    if (!before) throw Object.assign(new Error('Member not found'), { statusCode: 404 });
    const existing = new Set(before.excludedRoles || []);
    const inherited = new Set(inheritedSsoRoles);
    const invalid = roles.filter((role) => !existing.has(role) && !inherited.has(role));
    if (invalid.length > 0) {
      throw Object.assign(
        new Error(`Only roles inherited through SSO can be excluded: ${invalid.join(', ')}`),
        { statusCode: 400 },
      );
    }
    return change({
      spaceId,
      userId,
      actorId,
      before,
      role: before.membershipRole,
      excludedRoles: roles,
      action: 'excluded-roles-changed',
      changeId,
    });
  };
  // UI business-role additions for one SSO connection. A missing item means
  // no additions; read errors propagate so callers never treat a failed read as
  // an empty role list.
  const readRoleMappingItem = async (providerId) => {
    if (!providerId) throw Object.assign(new Error('providerId is required'), { statusCode: 400 });
    const result = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: ssoMappingKey(providerId),
        ConsistentRead: true,
      }),
    );
    return result.Item || null;
  };
  const getRoleMappings = async (providerId) =>
    (await readRoleMappingItem(providerId))?.roleMappings || {};
  // The editable record: the revision fences UI saves against lost updates.
  const getRoleMappingRecord = async (providerId) => {
    const item = await readRoleMappingItem(providerId);
    return { roleMappings: item?.roleMappings || {}, revision: item?.revision || null };
  };
  // `expectedRevision` is the revision the editor loaded (null for a first
  // save). Saving the whole mapping over a newer revision would silently undo
  // the other editor's change, so stale saves are rejected instead.
  const saveRoleMappings = async ({
    providerId,
    actorId,
    roleMappings,
    expectedRevision = null,
    changeId = randomUUID(),
  }) => {
    const mappings = normalizeRoleMappings(roleMappings);
    const timestamp = now();
    const existing = await readRoleMappingItem(providerId);
    if ((existing?.revision || null) !== expectedRevision) throw conflict();
    const item = {
      ...ssoMappingKey(providerId),
      providerId,
      roleMappings: mappings,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      revision: changeId,
    };
    const audit = {
      pk: 'PLATFORM',
      sk: `AUDIT#${timestamp}#${changeId}`,
      actorId,
      action: 'sso-role-mappings-changed',
      providerId,
      before: existing?.roleMappings || {},
      after: mappings,
      timestamp,
      changeId,
    };
    for (const record of [item, audit]) {
      if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_ITEM_BYTES) {
        throw Object.assign(new Error('Role mapping exceeds the storage size limit'), {
          statusCode: 400,
        });
      }
    }
    const writes = [
      {
        Put: {
          TableName: accessTable,
          Item: item,
          ...(expectedRevision
            ? {
                ConditionExpression: 'revision = :revision',
                ExpressionAttributeValues: { ':revision': expectedRevision },
              }
            : { ConditionExpression: 'attribute_not_exists(pk)' }),
        },
      },
      {
        Put: {
          TableName: auditTable,
          Item: audit,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ];
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
    return { roleMappings: mappings, revision: changeId };
  };
  const ssoClaimsItem = ({ subject, providerName, sourceAttribute, claimValues, source }) => {
    if (!subject || !providerName) throw new Error('SSO claims require a subject and a provider');
    const item = {
      ...ssoClaimsKey(subject),
      subject,
      providerName,
      sourceAttribute: sourceAttribute ?? '',
      claimValues,
      source,
      recordedAt: now(),
    };
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES)
      throw new Error('SSO claims exceed the storage size limit');
    return item;
  };
  // A sign-in always replaces the copy: it carries the provider's current claims.
  const recordSsoClaims = async (claims) => {
    await ddb.send(
      new PutCommand({
        TableName: accessTable,
        Item: ssoClaimsItem({ ...claims, source: 'sign-in' }),
      }),
    );
  };
  // The deployment backfill never replaces a copy, so a sign-in during the
  // backfill keeps its newer claims. Returns whether the copy was written.
  const backfillSsoClaims = async (claims) => {
    try {
      await ddb.send(
        new PutCommand({
          TableName: accessTable,
          Item: ssoClaimsItem({ ...claims, source: 'backfill' }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  };
  // Null when the user has never signed in through SSO since the backfill; read
  // errors propagate so callers never treat a failed read as no SSO roles.
  const getSsoClaims = async (subject) => {
    const result = await ddb.send(
      new GetCommand({
        TableName: accessTable,
        Key: ssoClaimsKey(subject),
        ConsistentRead: true,
      }),
    );
    return result.Item || null;
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
    changeLocalRoles,
    changeExcludedRoles,
    getRoleMappings,
    getRoleMappingRecord,
    saveRoleMappings,
    recordSsoClaims,
    backfillSsoClaims,
    getSsoClaims,
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
