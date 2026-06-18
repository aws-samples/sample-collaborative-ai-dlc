// CRUD over the reusable building-blocks library. Generic across all block
// types; block metadata lives in the blocks DynamoDB table, while large
// bodies/scripts live in the artifacts S3 bucket under blocks/, referenced by a
// content-addressed pointer.
//
// Routes (all behind the Cognito authorizer):
//   GET    /blocks/{type}            list the catalog (user blocks + SYSTEM)
//   POST   /blocks/{type}            create a block (V#latest + V#1)
//   GET    /blocks/{type}/{id}       get one block's metadata (no body)
//   GET    /blocks/{type}/{id}/body  lazily resolve the body/script from S3
//   PUT    /blocks/{type}/{id}       new version (V#latest + immutable V#n+1)
//   DELETE /blocks/{type}/{id}       delete the block partition
//
// SYSTEM-owned blocks are the imported baseline: read-only through the API and
// replaceable by the seed job. User-created or forked blocks live under the
// shared `default` owner.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { buildResponse } from '../shared/response.js';
import { resolveTenant, SYSTEM_TENANT } from '../shared/tenant.js';
import {
  LATEST,
  normalizeType,
  blockPk,
  versionSk,
  catalogGsi1Pk,
  buildBodyRef,
  validateBlockInput,
  validateId,
} from '../shared/blocks.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const blocksTable = () => process.env.BLOCKS_TABLE;
const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;

const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};

// Fields that are managed by the service, never taken from caller input.
const RESERVED_FIELDS = new Set([
  'pk',
  'sk',
  'GSI1PK',
  'GSI1SK',
  'tenantId',
  'blockType',
  'blockId',
  'version',
  'bodyRef',
  'createdAt',
  'updatedAt',
]);

// Strips reserved/managed fields and the body from caller input, leaving the
// intrinsic block attributes to persist on the item.
const sanitizeInput = (input) => {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'body' || RESERVED_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
};

// Writes a block body to S3 (content-addressed) and returns its pointer, or
// null when there is no body.
const putBody = async (body) => {
  if (body == null || body === '') return null;
  const ref = buildBodyRef(body);
  await s3.send(
    new PutObjectCommand({
      Bucket: artifactsBucket(),
      Key: ref.s3Key,
      Body: body,
      ContentType: 'text/markdown',
    }),
  );
  return ref;
};

const streamToString = async (stream) => {
  if (typeof stream?.transformToString === 'function') {
    return stream.transformToString();
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

// ─── Handlers ───

const listBlocks = async (event, res, tenant, type) => {
  // The catalog is the tenant's own blocks plus the read-only SYSTEM baseline.
  const tenants = tenant === SYSTEM_TENANT ? [SYSTEM_TENANT] : [tenant, SYSTEM_TENANT];
  const results = await Promise.all(
    tenants.map((t) =>
      ddb.send(
        new QueryCommand({
          TableName: blocksTable(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': catalogGsi1Pk(t, type) },
        }),
      ),
    ),
  );
  const items = results.flatMap((r) => r.Items || []).map(toApi);
  return res(200, { blocks: items });
};

const getBlock = async (event, res, tenant, type, id) => {
  const item = await loadLatestResolved(tenant, type, id);
  if (!item) return res(404, { error: 'Not found' });
  return res(200, toApi(item));
};

const getBlockBody = async (event, res, tenant, type, id) => {
  const item = await loadLatestResolved(tenant, type, id);
  if (!item) return res(404, { error: 'Not found' });
  if (!item.bodyRef) return res(200, { body: '' });
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: artifactsBucket(), Key: item.bodyRef.s3Key }),
  );
  const body = await streamToString(obj.Body);
  return res(200, { body });
};

const createBlock = async (event, res, tenant, type) => {
  if (tenant === SYSTEM_TENANT) {
    return res(403, { error: 'SYSTEM blocks are read-only' });
  }
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const id = input.id ?? input.slug;
  const idError = validateId(id);
  if (idError) return res(400, { error: idError });

  const fieldErrors = validateBlockInput(type, input);
  if (fieldErrors.length) return res(400, { error: fieldErrors.join('; ') });

  const existing = await loadLatest(tenant, type, id);
  if (existing) return res(409, { error: 'Block already exists' });

  const bodyRef = await putBody(input.body);
  const now = new Date().toISOString();
  const item = {
    pk: blockPk(tenant, type, id),
    tenantId: tenant,
    blockType: type,
    blockId: id,
    version: 1,
    bodyRef,
    createdAt: now,
    updatedAt: now,
    ...sanitizeInput(input),
  };
  const latest = await persistVersion(item);
  return res(201, toApi(latest));
};

const updateBlock = async (event, res, tenant, type, id) => {
  if (tenant === SYSTEM_TENANT) {
    return res(403, { error: 'SYSTEM blocks are read-only' });
  }
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const fieldErrors = validateBlockInput(type, input);
  if (fieldErrors.length) return res(400, { error: fieldErrors.join('; ') });

  const current = await loadLatest(tenant, type, id);
  if (!current) return res(404, { error: 'Not found' });

  // Reuse the existing body pointer unless a new body was supplied.
  const bodyRef = input.body != null ? await putBody(input.body) : current.bodyRef;
  const item = {
    pk: blockPk(tenant, type, id),
    tenantId: tenant,
    blockType: type,
    blockId: id,
    version: (current.version || 1) + 1,
    bodyRef,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    ...sanitizeInput(input),
  };
  const latest = await persistVersion(item);
  return res(200, toApi(latest));
};

const deleteBlock = async (event, res, tenant, type, id) => {
  if (tenant === SYSTEM_TENANT) {
    return res(403, { error: 'SYSTEM blocks are read-only' });
  }
  const current = await loadLatest(tenant, type, id);
  if (!current) return res(404, { error: 'Not found' });

  // Delete every version item in the block's partition.
  const versions = await ddb.send(
    new QueryCommand({
      TableName: blocksTable(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': blockPk(tenant, type, id) },
      ProjectionExpression: 'pk, sk',
    }),
  );
  await Promise.all(
    (versions.Items || []).map((v) =>
      ddb.send(new DeleteCommand({ TableName: blocksTable(), Key: { pk: v.pk, sk: v.sk } })),
    ),
  );
  return res(204, {});
};

// ─── Helpers ───

const loadLatest = async (tenant, type, id) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: blocksTable(),
      Key: { pk: blockPk(tenant, type, id), sk: LATEST },
    }),
  );
  return Item || null;
};

// Read resolution: a block visible to the user library is either its own
// `default` copy or the read-only SYSTEM baseline. The user copy wins (a fork
// shadows the imported baseline). Used by read paths; writes never fall back to
// SYSTEM.
const loadLatestResolved = async (tenant, type, id) => {
  if (tenant === SYSTEM_TENANT) return loadLatest(SYSTEM_TENANT, type, id);
  return (await loadLatest(tenant, type, id)) ?? (await loadLatest(SYSTEM_TENANT, type, id));
};

const parseBody = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return undefined;
  }
};

// Persists a block as two items in one write: the mutable V#latest pointer
// (which alone carries the GSI1 catalog keys, so a browse returns one row per
// block, not one per version) and an immutable V#<version> snapshot.
const persistVersion = async (item) => {
  const latest = {
    ...item,
    sk: LATEST,
    GSI1PK: catalogGsi1Pk(item.tenantId, item.blockType),
    GSI1SK: item.name,
  };
  const snapshot = { ...item, sk: versionSk(item.version) };
  await ddb.send(
    new BatchWriteCommand({
      RequestItems: {
        [blocksTable()]: [{ PutRequest: { Item: latest } }, { PutRequest: { Item: snapshot } }],
      },
    }),
  );
  return latest;
};

// Internal storage keys never exposed in the API shape.
const INTERNAL_KEYS = new Set(['pk', 'sk', 'GSI1PK', 'GSI1SK', 'bodyRef']);

// Maps a stored item to its API shape: drop the internal keys, expose a stable
// `id`, the body pointer metadata, and a `readOnly` flag for SYSTEM blocks.
const toApi = (item) => {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (!INTERNAL_KEYS.has(k)) out[k] = v;
  }
  out.id = item.blockId;
  out.hasBody = Boolean(item.bodyRef);
  out.bodyBytes = item.bodyRef?.bytes ?? 0;
  out.readOnly = item.tenantId === SYSTEM_TENANT;
  return out;
};

// ─── Router ───

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const method = event.httpMethod;
    const path = event.resource || event.path || '';
    const { type: rawType, id } = event.pathParameters || {};

    const type = normalizeType(rawType);
    if (!type) return res(404, { error: 'Unknown block type' });

    const tenant = resolveTenant(getClaims(event));

    if (path.endsWith('/body')) {
      if (method === 'GET') return await getBlockBody(event, res, tenant, type, id);
      return res(405, { error: 'Method not allowed' });
    }

    if (id) {
      if (method === 'GET') return await getBlock(event, res, tenant, type, id);
      if (method === 'PUT') return await updateBlock(event, res, tenant, type, id);
      if (method === 'DELETE') return await deleteBlock(event, res, tenant, type, id);
      return res(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') return await listBlocks(event, res, tenant, type);
    if (method === 'POST') return await createBlock(event, res, tenant, type);
    return res(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('building-blocks handler error:', err?.name || 'error');
    return res(500, { error: 'Internal server error' });
  }
};
