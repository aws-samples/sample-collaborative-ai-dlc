// Central store for user git-provider connection rows.
//
// Background: connections used to live in a single-key table (hash userId), so
// a user could hold exactly ONE git connection. That was fine when GitHub was
// the only provider, but GitLab (added in this branch) needs a second
// connection per user — and the single key meant connecting GitLab would
// overwrite the user's GitHub connection. Connections now live in a
// composite-key table (hash userId + range providerInstance) so a user can hold
// a GitHub AND a GitLab connection at once. For github/gitlab the stored row
// references an SSM token (parameterName) that backs BOTH repo and issue
// operations — one row, one token, both concerns.
//
// providerInstance: the range key is '<provider>#<instance>', mirroring the
// tracker-connections table (e.g. 'jira-cloud#cloud'). Only the SaaS 'public'
// instance exists today, so callers pass just a provider and the store pins
// '#public' at the DynamoDB boundary (the same way jira-cloud.js pins
// 'jira-cloud#cloud'). Storing the composite value now means future self-hosted
// / enterprise instances ('gitlab#self-hosted', …) need NO data migration —
// only a code change to vary the instance.
//
// Lazy migrate-on-read: pre-existing connections live in the legacy table
// keyed by userId alone. On main these are all GitHub rows (GitLab post-dates
// the single-key table); a dev environment that test-connected GitLab on the
// old code may also have a legacy GitLab row. Either way the logic is the same:
// readers try the new table first; on a miss they fall back to the legacy row,
// and — if its provider matches the requested one — atomically MOVE the
// observed row into the new table. A deletion leaves a credential-free
// tombstone in the authoritative table, fencing delayed migration and refresh.
// The SSM token itself never moves; only the DynamoDB row does.
//
// Env vars (all wired in terraform/modules/api/lambda):
//   GIT_PROVIDER_CONNECTIONS_TABLE — composite-key table (authoritative)
//   GIT_CONNECTIONS_TABLE          — legacy single-key table (read-fallback)

import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

// The only git-connection instance today is the SaaS one. Pinned here so the
// stored data already carries the composite key shape; callers never see it.
const DEFAULT_INSTANCE = 'public';

// Range-key value for a provider: '<provider>#<instance>'. Mirrors
// tracker-connections' providerInstance.
const instanceKey = (provider, instance = DEFAULT_INSTANCE) => `${provider}#${instance}`;

// Legacy rows predate the `provider` attribute and are always GitHub (GitLab
// post-dates the single-key table), so default a missing provider to github.
const rowProvider = (item) => item?.provider || 'github';

const newTable = () => process.env.GIT_PROVIDER_CONNECTIONS_TABLE;
const legacyTable = () => process.env.GIT_CONNECTIONS_TABLE;

// Missing generation/createdAt fields remain valid for existing connections,
// but must still be absent when a stale snapshot is used. In particular, a
// legacy refresh cannot update a connection which has since gained a UUID.
const IDENTITY_FIELDS = ['provider', 'parameterName', 'createdAt', 'generation', 'status'];
const LEGACY_FIELDS = [...IDENTITY_FIELDS, 'scope', 'updatedAt'];
const isDeleted = (item) => item?.status === 'deleted';
const connectionChanged = (cause) =>
  Object.assign(new Error('Git connection changed', { cause }), { code: 'CONNECTION_CHANGED' });
const isConditionalFailure = (error) =>
  error?.name === 'ConditionalCheckFailedException' ||
  (error?.name === 'TransactionCanceledException' &&
    error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed'));

const authoritativeTable = () => {
  const table = newTable();
  if (!table) throw new Error('GIT_PROVIDER_CONNECTIONS_TABLE is required');
  return table;
};

const readCurrent = async (ddb, userId, provider) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: authoritativeTable(),
      Key: { userId, providerInstance: instanceKey(provider) },
      ConsistentRead: true,
    }),
  );
  return Item ?? null;
};

// Raw lifecycle snapshot for guarding an explicit connect across its OAuth
// exchange. Unlike getGitConnection this includes tombstones and never migrates.
const getGitConnectionSnapshot = async (ddb, userId, provider) => {
  if (!userId || !provider) return null;
  return readCurrent(ddb, userId, provider);
};

// A null snapshot means true absence, never a tombstone. Callers guarding an
// OAuth exchange must capture the raw authoritative row (including tombstones)
// before the exchange and pass that snapshot to putGitConnection.
const snapshotCondition = (snapshot, fields = IDENTITY_FIELDS) => {
  const names = { '#key': 'userId' };
  if (!snapshot) {
    return {
      ConditionExpression: 'attribute_not_exists(#key)',
      ExpressionAttributeNames: names,
    };
  }
  const values = {};
  const conditions = ['attribute_exists(#key)'];
  for (const [index, field] of [...new Set(fields)].entries()) {
    const name = `#expected${index}`;
    names[name] = field;
    if (snapshot[field] === undefined) {
      conditions.push(`attribute_not_exists(${name})`);
    } else {
      const value = `:expected${index}`;
      values[value] = snapshot[field];
      conditions.push(`${name} = ${value}`);
    }
  }
  return {
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  };
};

const validateSnapshotKey = (snapshot, userId, provider) => {
  if (
    snapshot &&
    (snapshot.userId !== userId ||
      rowProvider(snapshot) !== provider ||
      (snapshot.providerInstance !== undefined &&
        snapshot.providerInstance !== instanceKey(provider)))
  ) {
    throw connectionChanged();
  }
};

const requireActiveSnapshot = (item) => {
  if (
    !item?.userId ||
    typeof item.parameterName !== 'string' ||
    !item.parameterName ||
    isDeleted(item)
  ) {
    throw connectionChanged();
  }
  validateSnapshotKey(item, item.userId, rowProvider(item));
};

// For lifecycle side effects, including invalidation after disconnect. This
// accepts an exact tombstone as well as an active connection; it does NOT
// authorize token use or relax assertCurrentGitConnection's active-only check.
const buildGitConnectionConditionCheck = (snapshot) => {
  if (
    typeof snapshot?.userId !== 'string' ||
    !snapshot.userId ||
    typeof rowProvider(snapshot) !== 'string'
  ) {
    throw connectionChanged();
  }
  if (isDeleted(snapshot)) {
    if (
      !snapshot.userId ||
      typeof snapshot.generation !== 'string' ||
      !snapshot.generation ||
      snapshot.parameterName !== undefined
    ) {
      throw connectionChanged();
    }
    validateSnapshotKey(snapshot, snapshot.userId, rowProvider(snapshot));
  } else {
    requireActiveSnapshot(snapshot);
  }
  return {
    TableName: authoritativeTable(),
    Key: { userId: snapshot.userId, providerInstance: instanceKey(rowProvider(snapshot)) },
    ...snapshotCondition(snapshot),
  };
};

const sendConditional = async (ddb, command) => {
  try {
    return await ddb.send(command);
  } catch (error) {
    if (isConditionalFailure(error)) throw connectionChanged(error);
    throw error;
  }
};

// Resolve a user's connection for a specific provider.
//
// Returns the connection row (with userId + providerInstance + provider +
// parameterName + …) or null when the user has no connection for that provider.
// Performs the lazy migrate-on-read: a legacy row matching `provider` is moved
// into the new table before being returned.
//
// `ddb` is a DynamoDBDocumentClient.
const getGitConnection = async (ddb, userId, provider) => {
  if (!userId || !provider) return null;
  const providerInstance = instanceKey(provider);

  // 1. Authoritative read on the composite-key table.
  if (newTable()) {
    const item = await readCurrent(ddb, userId, provider);
    if (item) return isDeleted(item) ? null : item;
  }

  // 2. Fallback to the legacy single-key row.
  if (!legacyTable()) return null;
  const { Item: legacy } = await ddb.send(
    new GetCommand({ TableName: legacyTable(), Key: { userId }, ConsistentRead: true }),
  );
  if (!legacy || isDeleted(legacy)) return null;

  // The legacy table holds one pre-cutover row per user (in practice a GitHub
  // connection). Only satisfy this request when that row's provider matches the
  // one being asked for — otherwise this provider simply isn't connected.
  if (rowProvider(legacy) !== provider) return null;

  // 3. Both observations must hold in the SAME transaction. A conditional
  // destination Put followed by a legacy Delete can publish stale credentials
  // if a disconnect/reconnect replaces the legacy row between those writes.
  const migrated = { ...legacy, userId, providerInstance, provider };
  if (newTable()) {
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: newTable(),
                Item: migrated,
                ...snapshotCondition(null),
              },
            },
            {
              Delete: {
                TableName: legacyTable(),
                Key: { userId },
                ...snapshotCondition(legacy, [...LEGACY_FIELDS, ...Object.keys(legacy)]),
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      // A competing migration/connect/disconnect may have won. Never return
      // the captured legacy row or retry publishing it. One authoritative
      // reread is sufficient and bounds work under concurrent churn.
      const current = await readCurrent(ddb, userId, provider);
      return isDeleted(current) ? null : current;
    }
  }
  return migrated;
};

// Explicit OAuth connect ONLY; refresh must use updateGitConnectionMetadata.
// expectedItem is mandatory: null requires absence; a raw row requires that
// lifecycle snapshot, including its tombstone generation, still to be current.
const putGitConnection = async (ddb, item, options) => {
  if (!item?.userId || !item?.provider) {
    throw new Error('putGitConnection requires userId and provider');
  }
  if (isDeleted(item)) throw new Error('Use deleteGitConnection to disconnect');
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !Object.hasOwn(options, 'expectedItem') ||
    (options.expectedItem !== null &&
      (!options.expectedItem ||
        typeof options.expectedItem !== 'object' ||
        Array.isArray(options.expectedItem)))
  ) {
    throw new Error(
      'putGitConnection requires explicit expectedItem (null or a connection snapshot)',
    );
  }
  const { expectedItem } = options;
  validateSnapshotKey(expectedItem, item.userId, item.provider);
  const row = { ...item, providerInstance: instanceKey(item.provider) };
  await sendConditional(
    ddb,
    new PutCommand({
      TableName: authoritativeTable(),
      Item: row,
      ...snapshotCondition(expectedItem),
    }),
  );
  return row;
};

// This is a live read, not a lease. The conditional metadata write must still
// succeed after SSM persistence, and callers must not return a refreshed token
// when that write loses. Each new connection must use a distinct SSM path.
const assertCurrentGitConnection = async (ddb, item) => {
  requireActiveSnapshot(item);
  const current = await readCurrent(ddb, item.userId, rowProvider(item));
  if (
    !current ||
    isDeleted(current) ||
    IDENTITY_FIELDS.some((field) => current[field] !== item[field])
  ) {
    throw connectionChanged();
  }
  return current;
};

// Update only refresh metadata. UpdateItem preserves attribution and other
// concurrent metadata; the condition prevents its normal upsert behavior.
const updateGitConnectionMetadata = async (ddb, item, metadata) => {
  requireActiveSnapshot(item);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Git connection metadata must be an object');
  }
  const entries = Object.entries(metadata);
  if (entries.some(([field]) => field !== 'scope' && field !== 'updatedAt')) {
    throw new Error('Only scope and updatedAt may be updated');
  }
  const changes = entries.filter(([, value]) => value !== undefined);
  if (!changes.length) return assertCurrentGitConnection(ddb, item);
  const condition = snapshotCondition(item);
  const names = { ...condition.ExpressionAttributeNames };
  const values = { ...condition.ExpressionAttributeValues };
  const updates = changes.map(([field, value], index) => {
    names[`#metadata${index}`] = field;
    values[`:metadata${index}`] = value;
    return `#metadata${index} = :metadata${index}`;
  });
  const { Attributes } = await sendConditional(
    ddb,
    new UpdateCommand({
      TableName: authoritativeTable(),
      Key: { userId: item.userId, providerInstance: instanceKey(rowProvider(item)) },
      ConditionExpression: condition.ConditionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      UpdateExpression: `SET ${updates.join(', ')}`,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Attributes;
};

// Revoke authority BEFORE the caller deletes SSM. Passing the originally read
// item is essential when disconnect has already performed asynchronous work.
// The default snapshots the raw row here, including an existing tombstone.
// Always mint a fresh tombstone generation: even another disconnect of an
// already deleted row must fence callbacks that previously observed that row.
const deleteGitConnection = async (ddb, userId, provider, { expectedItem } = {}) => {
  if (!userId || !provider) return;
  const current =
    expectedItem === undefined ? await readCurrent(ddb, userId, provider) : expectedItem;
  validateSnapshotKey(current, userId, provider);
  // Snapshot legacy before revocation. A subsequent replacement must survive
  // cleanup; the tombstone already prevents it from regaining authority.
  let legacy;
  if (legacyTable()) {
    ({ Item: legacy } = await ddb.send(
      new GetCommand({ TableName: legacyTable(), Key: { userId }, ConsistentRead: true }),
    ));
  }
  const tombstone = {
    userId,
    providerInstance: instanceKey(provider),
    provider,
    status: 'deleted',
    generation: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  await sendConditional(
    ddb,
    new PutCommand({
      TableName: authoritativeTable(),
      Item: tombstone,
      ...snapshotCondition(current),
    }),
  );
  if (legacy && rowProvider(legacy) === provider) {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: legacyTable(),
          Key: { userId },
          ...snapshotCondition(legacy, [...LEGACY_FIELDS, ...Object.keys(legacy)]),
        }),
      );
    } catch (error) {
      // Cleanup cannot undo the authoritative revocation. In particular, do
      // not retry a conditional failure against a newly observed legacy row.
      if (!isConditionalFailure(error)) throw error;
    }
  }
  return tombstone;
};

export {
  getGitConnection,
  getGitConnectionSnapshot,
  buildGitConnectionConditionCheck,
  putGitConnection,
  assertCurrentGitConnection,
  updateGitConnectionMetadata,
  deleteGitConnection,
  rowProvider,
  instanceKey,
};
export default {
  getGitConnection,
  getGitConnectionSnapshot,
  buildGitConnectionConditionCheck,
  putGitConnection,
  assertCurrentGitConnection,
  updateGitConnectionMetadata,
  deleteGitConnection,
  rowProvider,
  instanceKey,
};
