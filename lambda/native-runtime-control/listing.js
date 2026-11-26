// The index is discovery only; full, consistent binding validation stays in store.get.
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';
import { ID, UUID_V4, fail, matches, record } from './store.js';

export const NATIVE_DISCOVERY_INDEX = 'NativeByProjectCreatedAt';
const CURSOR_LIMIT = 2048;
const fields = (value, names) =>
  record(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const validLimit = (value) => Number.isInteger(value) && value >= 1 && value <= 50;
const cursorValue = ({ projectId, executionId, createdAt }) => ({
  v: 1,
  projectId,
  executionId,
  createdAt,
});
const encodeCursor = (value) =>
  Buffer.from(JSON.stringify(cursorValue(value))).toString('base64url');
const indexKey = (value) => ({
  ...nativeRuntimeBindingKey(value),
  projectId: value.projectId,
  createdAt: value.createdAt,
});
const decodeCursor = (value, projectId) => {
  try {
    if (
      typeof value !== 'string' ||
      value.length > CURSOR_LIMIT ||
      !matches(value, /^[A-Za-z0-9_-]+$/)
    )
      fail('INVALID');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !fields(parsed, ['v', 'projectId', 'executionId', 'createdAt']) ||
      parsed.v !== 1 ||
      parsed.projectId !== projectId ||
      !matches(parsed.executionId, UUID_V4) ||
      !timestamp(parsed.createdAt) ||
      encodeCursor(parsed) !== value
    )
      fail('INVALID');
    return indexKey(parsed);
  } catch {
    fail('INVALID');
  }
};

// REST API Gateway can provide either map or both. Reject duplicate values and
// conflicting maps instead of trusting whichever representation was read first.
export const nativeListQuery = (event, { collection, projectId }) => {
  const single = event.queryStringParameters;
  const multi = event.multiValueQueryStringParameters;
  for (const map of [single, multi]) {
    if (map != null && !record(map)) fail('INVALID');
  }
  const query = {};
  for (const [key, value] of Object.entries(single ?? {})) {
    if (!['view', 'limit', 'cursor'].includes(key) || typeof value !== 'string') fail('INVALID');
    query[key] = value;
  }
  for (const [key, values] of Object.entries(multi ?? {})) {
    if (
      !['view', 'limit', 'cursor'].includes(key) ||
      !Array.isArray(values) ||
      values.length !== 1 ||
      typeof values[0] !== 'string' ||
      (single != null && (!Object.hasOwn(single, key) || single[key] !== values[0]))
    )
      fail('INVALID');
    query[key] = values[0];
  }
  if (
    single != null &&
    multi != null &&
    Object.keys(single).some((key) => !Object.hasOwn(multi, key))
  )
    fail('INVALID');
  if (!Object.keys(query).length) return null;
  if (!collection || event.httpMethod !== 'GET' || query.view !== 'list') fail('INVALID');
  if (query.limit !== undefined && !matches(query.limit, /^(?:[1-9]|[1-4][0-9]|50)$/))
    fail('INVALID');
  const cursor = query.cursor ?? null;
  if (cursor !== null) decodeCursor(cursor, projectId);
  return { limit: query.limit === undefined ? 25 : Number(query.limit), cursor };
};

const validateHint = (hint, projectId) => {
  if (
    !fields(hint, ['pk', 'sk', 'projectId', 'createdAt', 'executionId']) ||
    hint.projectId !== projectId ||
    !matches(hint.executionId, UUID_V4) ||
    !timestamp(hint.createdAt)
  )
    fail('UNAVAILABLE');
  const key = nativeRuntimeBindingKey(hint);
  if (hint.pk !== key.pk || hint.sk !== key.sk) fail('UNAVAILABLE');
};

export const createNativeIntentListing = ({ ddb, tableName, store } = {}) => ({
  async list({ projectId, projectIdentity, limit = 25, cursor = null }) {
    if (
      !matches(projectId, ID) ||
      typeof projectIdentity !== 'string' ||
      !projectIdentity ||
      !validLimit(limit)
    )
      fail('INVALID');
    const start = cursor === null ? null : decodeCursor(cursor, projectId);
    if (!tableName || typeof tableName !== 'string') fail('UNAVAILABLE');
    let page;
    try {
      page = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: NATIVE_DISCOVERY_INDEX,
          KeyConditionExpression: '#project = :project',
          ExpressionAttributeNames: { '#project': 'projectId' },
          ExpressionAttributeValues: { ':project': projectId },
          ScanIndexForward: false,
          Limit: limit,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
    } catch {
      fail('UNAVAILABLE');
    }
    if (!record(page) || !Array.isArray(page.Items) || page.Items.length > limit)
      fail('UNAVAILABLE');
    const seen = new Set();
    let previousTime = start?.createdAt ?? Infinity;
    for (const hint of page.Items) {
      validateHint(hint, projectId);
      if (seen.has(hint.pk) || hint.pk === start?.pk || hint.createdAt > previousTime)
        fail('UNAVAILABLE');
      seen.add(hint.pk);
      previousTime = hint.createdAt;
    }
    let nextCursor = null;
    const lastKey = page.LastEvaluatedKey;
    if (lastKey !== undefined && !(record(lastKey) && !Object.keys(lastKey).length)) {
      const last = page.Items.at(-1);
      if (
        !last ||
        !fields(lastKey, ['pk', 'sk', 'projectId', 'createdAt']) ||
        Object.entries(indexKey(last)).some(([key, value]) => lastKey[key] !== value)
      )
        fail('UNAVAILABLE');
      nextCursor = encodeCursor(last);
    }

    const rows = [];
    // At most 50 consistent reads; never refill a short page or scan. A deleted
    // source row can leave an index hint temporarily, so keep the cursor moving.
    for (const hint of page.Items) {
      const row = await store.get({ projectId, executionId: hint.executionId });
      if (row === null) continue;
      if (
        row.projectId !== projectId ||
        row.executionId !== hint.executionId ||
        row.pk !== hint.pk ||
        row.sk !== hint.sk ||
        row.createdAt !== hint.createdAt
      )
        fail('UNAVAILABLE');
      if (row.projectIdentity !== projectIdentity) fail('FORBIDDEN');
      rows.push(row);
    }
    return { rows, nextCursor };
  },
});
