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
  phaseSk,
  placementSk,
  scopeRefSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validatePhaseNode,
} from '../shared/workflows.js';
import { blockPk, catalogGsi1Pk, LATEST } from '../shared/blocks.js';
import { compileWorkflow } from '../shared/compile.js';

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

// Replace the whole phase tree in one write: the editor sends the full
// ordered, nestable node list, so we write the new PHASE# items and delete any
// the new tree dropped. Phases are defined inline (id + name + kind), not
// referenced from a library — so the node carries its own label.
const putPhases = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined || !Array.isArray(input.phases)) {
    return res(400, { error: 'phases must be an array' });
  }
  for (const node of input.phases) {
    const err = validatePhaseNode(node);
    if (err) return res(400, { error: err });
  }

  const puts = input.phases.map((node) => ({
    PutRequest: {
      Item: {
        pk: workflowPk(tenant, workflowId),
        sk: phaseSk(node.path, node.phaseId),
        type: 'Phase',
        phaseId: node.phaseId,
        name: typeof node.name === 'string' ? node.name : node.phaseId,
        kind: node.kind ?? 'phase',
        path: node.path,
        parentPath: node.path.includes('.') ? node.path.split('.').slice(0, -1).join('.') : null,
        order: Number(node.path.split('.').at(-1)),
      },
    },
  }));

  // Only delete phases the new tree no longer contains. A node whose key is
  // unchanged is just overwritten by its Put — a key may not appear in both a
  // delete and a put of the same BatchWrite (DynamoDB rejects it as a
  // duplicate), and re-putting is an idempotent upsert anyway.
  const nextSks = new Set(puts.map((p) => p.PutRequest.Item.sk));
  const existing = await queryPartition(tenant, workflowId, {
    skBeginsWith: 'PHASE#',
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
  const stageId = input.stageId;
  if (typeof stageId !== 'string' || !stageId) return res(400, { error: 'stageId is required' });

  const sk = placementSk(stageId);
  const existing = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (existing.Item) return res(409, { error: 'Stage already placed' });

  const item = buildPlacementItem(tenant, workflowId, stageId, input);
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  return res(201, placementToApi(item));
};

const updatePlacement = async (event, res, tenant, workflowId, stageId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = placementSk(stageId);
  const current = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (!current.Item) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });

  const item = buildPlacementItem(tenant, workflowId, stageId, { ...current.Item, ...input });
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  return res(200, placementToApi(item));
};

const deletePlacement = async (event, res, tenant, workflowId, stageId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = placementSk(stageId);
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

// ── Scope refs ── make a library scope available in this workflow (the
// columns of the scope × skill matrix). Membership itself lives on placements.
const addScopeRef = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });
  const scopeId = input.scopeId;
  if (typeof scopeId !== 'string' || !scopeId) return res(400, { error: 'scopeId is required' });

  const item = {
    pk: workflowPk(tenant, workflowId),
    sk: scopeRefSk(scopeId),
    type: 'ScopeRef',
    scopeId,
    scopeTenant: input.scopeTenant ?? SYSTEM_TENANT,
  };
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  return res(201, scopeRefToApi(item));
};

const removeScopeRef = async (event, res, tenant, workflowId, scopeId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = scopeRefSk(scopeId);
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

// ── Compiled views ── derive scope-grid + autonomy-profile + stage-graph from
// the placements, scope refs, and the library Stage blocks they reference.
// Computed on demand (no cache yet); the pure compilers live in shared/compile.
const getCompiled = async (event, res, tenant, workflowId) => {
  const resolved = await resolveWorkflow(tenant, workflowId);
  if (!resolved) return res(404, { error: 'Not found' });
  const items = await queryPartition(resolved.owner, workflowId);

  const placements = items.filter((i) => i.sk.startsWith('PLACEMENT#')).map(placementToApi);
  const scopeSlugs = items.filter((i) => i.sk.startsWith('SCOPEREF#')).map((i) => i.scopeId);

  // Batch-get the referenced Stage library blocks (V#latest), keyed by id, and
  // load the artifact vocabulary so the graph can flag unknown (typo) names.
  const stagesById = await loadStages(placements);
  const artifactsById = await loadArtifacts(resolved.owner);
  const compiled = compileWorkflow(placements, scopeSlugs, stagesById, artifactsById);
  return res(200, compiled);
};

// Load the artifact registry visible to the workflow's owner (its own ARTIFACT
// blocks plus the SYSTEM baseline), keyed by id. Used only to distinguish
// terminal outputs from unregistered names — absence is non-fatal (null grid).
const loadArtifacts = async (owner) => {
  const tenants = owner === SYSTEM_TENANT ? [SYSTEM_TENANT] : [owner, SYSTEM_TENANT];
  const results = await Promise.all(
    tenants.map((t) =>
      ddb.send(
        new QueryCommand({
          TableName: blocksTable(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': catalogGsi1Pk(t, 'ARTIFACT') },
        }),
      ),
    ),
  );
  const byId = {};
  // Owner's own blocks win over SYSTEM (listed first → set first, don't clobber).
  for (const r of results) {
    for (const item of r.Items || []) {
      if (!(item.blockId in byId)) byId[item.blockId] = item;
    }
  }
  return byId;
};

// Resolve each placement's Stage block from its owning tenant (pinned version
// support is deferred — we read V#latest, which is what the editor shows).
const loadStages = async (placements) => {
  const results = await Promise.all(
    placements.map((p) =>
      ddb.send(
        new GetCommand({
          TableName: blocksTable(),
          Key: { pk: blockPk(p.stageTenant ?? SYSTEM_TENANT, 'STAGE', p.stageId), sk: LATEST },
        }),
      ),
    ),
  );
  const stagesById = {};
  for (const { Item } of results) {
    if (Item) stagesById[Item.blockId] = Item;
  }
  return stagesById;
};

// ─── Shapers ───

const buildPlacementItem = (tenant, workflowId, stageId, input) => ({
  pk: workflowPk(tenant, workflowId),
  sk: placementSk(stageId),
  type: 'StagePlacement',
  stageId,
  stageTenant: input.stageTenant ?? SYSTEM_TENANT,
  pinnedVersion: input.pinnedVersion ?? null,
  phasePath: input.phasePath ?? null,
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

const phaseToApi = (item) => ({
  phaseId: item.phaseId,
  name: item.name ?? item.phaseId,
  kind: item.kind,
  path: item.path,
  parentPath: item.parentPath ?? null,
  order: item.order,
});

const placementToApi = (item) => ({
  stageId: item.stageId,
  stageTenant: item.stageTenant,
  pinnedVersion: item.pinnedVersion ?? null,
  phasePath: item.phasePath ?? null,
  order: item.order ?? 0,
  scopeMembership: item.scopeMembership ?? {},
});

const scopeRefToApi = (item) => ({ scopeId: item.scopeId, scopeTenant: item.scopeTenant });

// Assemble the partition items into the composition the editor loads.
const composeWorkflow = (owner, items) => {
  const meta = items.find((i) => i.sk === META);
  const phases = items
    .filter((i) => i.sk.startsWith('PHASE#'))
    .map(phaseToApi)
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const placements = items
    .filter((i) => i.sk.startsWith('PLACEMENT#'))
    .map(placementToApi)
    .toSorted((a, b) => a.order - b.order);
  const scopeRefs = items
    .filter((i) => i.sk.startsWith('SCOPEREF#'))
    .map(scopeRefToApi)
    .toSorted((a, b) => a.scopeId.localeCompare(b.scopeId));
  return {
    ...(meta ? metaToApi(meta) : {}),
    owner,
    readOnly: owner === SYSTEM_TENANT,
    phases,
    placements,
    scopeRefs,
  };
};

// ─── Router ───

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const method = event.httpMethod;
    const path = event.resource || event.path || '';
    const { workflowId, stageId, scopeId } = event.pathParameters || {};
    const tenant = resolveTenant(getClaims(event));

    if (path.endsWith('/placements/{stageId}')) {
      if (method === 'PUT') return await updatePlacement(event, res, tenant, workflowId, stageId);
      if (method === 'DELETE')
        return await deletePlacement(event, res, tenant, workflowId, stageId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/placements')) {
      if (method === 'POST') return await addPlacement(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/phases')) {
      if (method === 'PUT') return await putPhases(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/scopes/{scopeId}')) {
      if (method === 'DELETE') return await removeScopeRef(event, res, tenant, workflowId, scopeId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/scopes')) {
      if (method === 'POST') return await addScopeRef(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/compiled')) {
      if (method === 'GET') return await getCompiled(event, res, tenant, workflowId);
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
