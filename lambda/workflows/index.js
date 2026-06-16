// Composition over the block library: a workflow references and arranges
// library blocks (a grouping tree + skill placements + scope/guardrail refs).
// Workflows share the blocks table (WF#… partitions); one Query loads the
// whole composition. No block bodies here, so no S3.
//
// Routes (all behind the Cognito authorizer):
//   GET    /workflows                              list (GSI1)
//   POST   /workflows                              create (META, optional fork)
//   GET    /workflows/{workflowId}                 full composition
//   PUT    /workflows/{workflowId}                 update META
//   DELETE /workflows/{workflowId}                 delete the whole partition
//   PUT    /workflows/{workflowId}/groupings       replace the grouping tree
//   POST   /workflows/{workflowId}/placements      add a skill placement
//   PUT    /workflows/{workflowId}/placements/{skillId}    update a placement
//   DELETE /workflows/{workflowId}/placements/{skillId}    remove a placement
//
// SYSTEM-owned workflows are the shipped baseline: read-only to tenants (fork
// to customize). Reads fall back to SYSTEM; writes never do.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { buildResponse } from '../shared/response.js';
import { resolveTenant, SYSTEM_TENANT } from '../shared/tenant.js';
import {
  META,
  workflowPk,
  groupingSk,
  placementSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validateGroupingNode,
} from '../shared/workflows.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const blocksTable = () => process.env.BLOCKS_TABLE;
const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};

const parseBody = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return undefined;
  }
};

// Chunk an array of write requests into BatchWrite-sized groups (25 max).
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const batchWrite = async (requests) => {
  for (const group of chunk(requests, 25)) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [blocksTable()]: group } }));
  }
};

// Every item in a workflow partition (used by load + delete).
const queryPartition = async (tenant, workflowId, opts = {}) => {
  const params = {
    TableName: blocksTable(),
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': workflowPk(tenant, workflowId) },
  };
  if (opts.skBeginsWith) {
    params.KeyConditionExpression += ' AND begins_with(sk, :sk)';
    params.ExpressionAttributeValues[':sk'] = opts.skBeginsWith;
  }
  if (opts.projection) params.ProjectionExpression = opts.projection;
  const { Items } = await ddb.send(new QueryCommand(params));
  return Items || [];
};

const loadMeta = async (tenant, workflowId) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: blocksTable(),
      Key: { pk: workflowPk(tenant, workflowId), sk: META },
    }),
  );
  return Item || null;
};

// Read resolution: a workflow the tenant can see is its own or the SYSTEM
// baseline (a tenant fork shadows it). Returns the owning tenant + meta.
const resolveWorkflow = async (tenant, workflowId) => {
  const own = await loadMeta(tenant, workflowId);
  if (own) return { owner: tenant, meta: own };
  if (tenant !== SYSTEM_TENANT) {
    const sys = await loadMeta(SYSTEM_TENANT, workflowId);
    if (sys) return { owner: SYSTEM_TENANT, meta: sys };
  }
  return null;
};

// ─── Handlers ───

const listWorkflows = async (event, res, tenant) => {
  const tenants = tenant === SYSTEM_TENANT ? [SYSTEM_TENANT] : [tenant, SYSTEM_TENANT];
  const results = await Promise.all(
    tenants.map((t) =>
      ddb.send(
        new QueryCommand({
          TableName: blocksTable(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': workflowGsi1Pk(t) },
        }),
      ),
    ),
  );
  const workflows = results.flatMap((r) => r.Items || []).map(metaToApi);
  return res(200, { workflows });
};

const getWorkflow = async (event, res, tenant, workflowId) => {
  const resolved = await resolveWorkflow(tenant, workflowId);
  if (!resolved) return res(404, { error: 'Not found' });
  const items = await queryPartition(resolved.owner, workflowId);
  return res(200, composeWorkflow(resolved.owner, items));
};

const createWorkflow = async (event, res, tenant) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const id = input.id ?? input.slug;
  const idError = validateId(id);
  if (idError) return res(400, { error: idError });
  const nameError = validateName(input.name);
  if (nameError) return res(400, { error: nameError });

  if (await loadMeta(tenant, id)) return res(409, { error: 'Workflow already exists' });

  // Fork: copy the source workflow's grouping tree + placements + refs.
  let sourceItems = [];
  if (input.basedOn) {
    const src = await resolveWorkflow(tenant, input.basedOn);
    if (!src) return res(400, { error: 'basedOn workflow not found' });
    sourceItems = (await queryPartition(src.owner, input.basedOn)).filter((i) => i.sk !== META);
  }

  const now = new Date().toISOString();
  const meta = {
    pk: workflowPk(tenant, id),
    sk: META,
    type: 'Workflow',
    tenantId: tenant,
    workflowId: id,
    name: input.name,
    objective: typeof input.objective === 'string' ? input.objective : '',
    basedOn: input.basedOn ?? null,
    defaultScope: input.defaultScope ?? null,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    GSI1PK: workflowGsi1Pk(tenant),
    GSI1SK: input.name,
  };

  const requests = [{ PutRequest: { Item: meta } }];
  for (const item of sourceItems) {
    requests.push({ PutRequest: { Item: { ...item, pk: workflowPk(tenant, id) } } });
  }
  await batchWrite(requests);
  return res(201, metaToApi(meta));
};

const updateWorkflow = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const current = await loadMeta(tenant, workflowId);
  if (!current) return res(404, { error: 'Not found' });
  if (input.name != null) {
    const nameError = validateName(input.name);
    if (nameError) return res(400, { error: nameError });
  }

  const meta = {
    ...current,
    name: input.name ?? current.name,
    objective: input.objective ?? current.objective,
    defaultScope: input.defaultScope ?? current.defaultScope,
    status: input.status ?? current.status,
    updatedAt: new Date().toISOString(),
    GSI1SK: input.name ?? current.name,
  };
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: meta }));
  return res(200, metaToApi(meta));
};

const deleteWorkflow = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const items = await queryPartition(tenant, workflowId, { projection: 'pk, sk' });
  await batchWrite(items.map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } })));
  return res(204, {});
};

// Replace the whole grouping tree in one write: the editor sends the full
// ordered, nestable node list, so we delete the old GROUPING# items and write
// the new ones. Whole-tree replace keeps ordering/nesting trivially correct.
const putGroupings = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined || !Array.isArray(input.groupings)) {
    return res(400, { error: 'groupings must be an array' });
  }
  for (const node of input.groupings) {
    const err = validateGroupingNode(node);
    if (err) return res(400, { error: err });
  }

  const puts = input.groupings.map((node) => ({
    PutRequest: {
      Item: {
        pk: workflowPk(tenant, workflowId),
        sk: groupingSk(node.path, node.groupingId),
        type: 'GroupingRef',
        groupingId: node.groupingId,
        groupingTenant: node.groupingTenant ?? SYSTEM_TENANT,
        kind: node.kind ?? 'phase',
        path: node.path,
        parentPath: node.path.includes('.') ? node.path.split('.').slice(0, -1).join('.') : null,
        order: Number(node.path.split('.').at(-1)),
      },
    },
  }));

  // Only delete groupings that the new tree no longer contains. A node whose
  // key is unchanged is just overwritten by its Put — a key may not appear in
  // both a delete and a put of the same BatchWrite (DynamoDB rejects it as a
  // duplicate), and re-putting is an idempotent upsert anyway.
  const nextSks = new Set(puts.map((p) => p.PutRequest.Item.sk));
  const existing = await queryPartition(tenant, workflowId, {
    skBeginsWith: 'GROUPING#',
    projection: 'pk, sk',
  });
  const deletes = existing
    .filter((i) => !nextSks.has(i.sk))
    .map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } }));
  await batchWrite([...deletes, ...puts]);
  const items = await queryPartition(tenant, workflowId);
  return res(200, composeWorkflow(tenant, items));
};

const addPlacement = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });
  const skillId = input.skillId;
  if (typeof skillId !== 'string' || !skillId) return res(400, { error: 'skillId is required' });

  const sk = placementSk(skillId);
  const existing = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (existing.Item) return res(409, { error: 'Skill already placed' });

  const item = buildPlacementItem(tenant, workflowId, skillId, input);
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  return res(201, placementToApi(item));
};

const updatePlacement = async (event, res, tenant, workflowId, skillId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = placementSk(skillId);
  const current = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (!current.Item) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const item = buildPlacementItem(tenant, workflowId, skillId, { ...current.Item, ...input });
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  return res(200, placementToApi(item));
};

const deletePlacement = async (event, res, tenant, workflowId, skillId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = placementSk(skillId);
  const current = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (!current.Item) return res(404, { error: 'Not found' });
  await ddb.send(
    new DeleteCommand({
      TableName: blocksTable(),
      Key: { pk: workflowPk(tenant, workflowId), sk },
    }),
  );
  return res(204, {});
};

// ─── Shapers ───

const buildPlacementItem = (tenant, workflowId, skillId, input) => ({
  pk: workflowPk(tenant, workflowId),
  sk: placementSk(skillId),
  type: 'SkillPlacement',
  skillId,
  skillTenant: input.skillTenant ?? SYSTEM_TENANT,
  pinnedVersion: input.pinnedVersion ?? null,
  groupingPath: input.groupingPath ?? null,
  order: typeof input.order === 'number' ? input.order : 0,
  scopeMembership:
    input.scopeMembership && typeof input.scopeMembership === 'object' ? input.scopeMembership : {},
});

const metaToApi = (item) => ({
  id: item.workflowId,
  workflowId: item.workflowId,
  name: item.name,
  objective: item.objective ?? '',
  owner: item.tenantId,
  basedOn: item.basedOn ?? null,
  defaultScope: item.defaultScope ?? null,
  status: item.status ?? 'DRAFT',
  readOnly: item.tenantId === SYSTEM_TENANT,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const groupingToApi = (item) => ({
  groupingId: item.groupingId,
  groupingTenant: item.groupingTenant,
  kind: item.kind,
  path: item.path,
  parentPath: item.parentPath ?? null,
  order: item.order,
});

const placementToApi = (item) => ({
  skillId: item.skillId,
  skillTenant: item.skillTenant,
  pinnedVersion: item.pinnedVersion ?? null,
  groupingPath: item.groupingPath ?? null,
  order: item.order ?? 0,
  scopeMembership: item.scopeMembership ?? {},
});

// Assemble the partition items into the composition the editor loads.
const composeWorkflow = (owner, items) => {
  const meta = items.find((i) => i.sk === META);
  const groupings = items
    .filter((i) => i.sk.startsWith('GROUPING#'))
    .map(groupingToApi)
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const placements = items
    .filter((i) => i.sk.startsWith('PLACEMENT#'))
    .map(placementToApi)
    .toSorted((a, b) => a.order - b.order);
  return {
    ...(meta ? metaToApi(meta) : {}),
    owner,
    readOnly: owner === SYSTEM_TENANT,
    groupings,
    placements,
  };
};

// ─── Router ───

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const method = event.httpMethod;
    const path = event.resource || event.path || '';
    const { workflowId, skillId } = event.pathParameters || {};
    const tenant = resolveTenant(getClaims(event));

    if (path.endsWith('/placements/{skillId}')) {
      if (method === 'PUT') return await updatePlacement(event, res, tenant, workflowId, skillId);
      if (method === 'DELETE')
        return await deletePlacement(event, res, tenant, workflowId, skillId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/placements')) {
      if (method === 'POST') return await addPlacement(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/groupings')) {
      if (method === 'PUT') return await putGroupings(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (workflowId) {
      if (method === 'GET') return await getWorkflow(event, res, tenant, workflowId);
      if (method === 'PUT') return await updateWorkflow(event, res, tenant, workflowId);
      if (method === 'DELETE') return await deleteWorkflow(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (method === 'GET') return await listWorkflows(event, res, tenant);
    if (method === 'POST') return await createWorkflow(event, res, tenant);
    return res(405, { error: 'Method not allowed' });
  } catch (err) {
    // Log name + message (no PII in these handlers) so failures are diagnosable
    // from CloudWatch without a redeploy.
    console.error('workflows handler error:', err?.name || 'error', '-', err?.message || '');
    return res(500, { error: 'Internal server error' });
  }
};
