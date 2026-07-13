// Composition over the block library: a workflow references and arranges
// library blocks (a grouping tree + skill placements + scope/guardrail refs).
// Workflows share the blocks table (WF#… partitions); one Query loads the
// whole composition. No block bodies here, so no S3.
//
// Routes (all behind the Cognito authorizer):
//   GET    /workflows                              list (GSI1)
//   POST   /workflows                              create (META, optional fork)
//   GET    /workflows/{workflowId}[?version=N]     full composition (live or immutable snapshot)
//   PUT    /workflows/{workflowId}                 update META
//   DELETE /workflows/{workflowId}                 delete the whole partition
//   PUT    /workflows/{workflowId}/groupings       replace the grouping tree
//   POST   /workflows/{workflowId}/placements      add a skill placement
//   PUT    /workflows/{workflowId}/placements/{skillId}    update a placement
//   DELETE /workflows/{workflowId}/placements/{skillId}    remove a placement
//   PUT    /workflows/{workflowId}/scopes/{scopeId}/membership bulk replace membership
//   GET    /workflows/{workflowId}/compiled[?version=N]    derived views (live or snapshot)
//   GET    /workflows/{workflowId}/execution-preview?scope=<scope>[&version=N][&skip=a,b]
//
// SYSTEM-owned workflows are the imported baseline: read-only through the API
// and replaceable by the seed job. User-created or forked workflows live under
// the shared `default` owner. Reads fall back to SYSTEM; writes never do.

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
import { requirePlatformAdmin } from '../shared/authz.js';
import { resolveTenant, SYSTEM_TENANT } from '../shared/tenant.js';
import {
  META,
  workflowPk,
  workflowVersionPrefix,
  workflowVersionSk,
  isWorkflowVersionSk,
  liveSkFromVersionSk,
  phaseSk,
  placementSk,
  scopeRefSk,
  ruleRefSk,
  workflowGsi1Pk,
  validateId,
  validateName,
  validatePhaseNode,
} from '../shared/workflows.js';
import { blockPk, catalogGsi1Pk, LATEST, RULE_LAYERS, versionSk } from '../shared/blocks.js';
import { compileWorkflow } from '../shared/compile.js';
import { buildExecutionPlan } from '../shared/v2-execution-plan.js';
import { normalizeComposedGrid } from '../shared/composed-grid.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const blocksTable = () => process.env.BLOCKS_TABLE;
const getClaims = (event) => event?.requestContext?.authorizer?.claims || {};
const getRequestedVersion = (event) => {
  const raw = event?.queryStringParameters?.version;
  if (raw == null || raw === '') return { version: null };
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    return { error: 'version must be a positive integer' };
  }
  return { version };
};

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

const isLiveWorkflowItem = (item) => !isWorkflowVersionSk(item.sk);

const queryLivePartition = async (tenant, workflowId, opts = {}) =>
  (await queryPartition(tenant, workflowId, opts)).filter(isLiveWorkflowItem);

const querySnapshotPartition = async (tenant, workflowId, version) =>
  (await queryPartition(tenant, workflowId, { skBeginsWith: workflowVersionPrefix(version) })).map(
    (item) => ({ ...item, sk: liveSkFromVersionSk(item.sk) }),
  );

const queryWorkflowItems = async (tenant, workflowId, version = null) =>
  version == null
    ? queryLivePartition(tenant, workflowId)
    : querySnapshotPartition(tenant, workflowId, version);

const loadMeta = async (tenant, workflowId) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: blocksTable(),
      Key: { pk: workflowPk(tenant, workflowId), sk: META },
    }),
  );
  return Item || null;
};

const loadPlacedStageVersion = async (placement) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: blocksTable(),
      Key: {
        pk: blockPk(placement.stageTenant ?? SYSTEM_TENANT, 'STAGE', placement.stageId),
        sk: LATEST,
      },
    }),
  );
  return Item?.version ?? null;
};

const buildSnapshotItems = async (liveItems, version) => {
  const stageVersionByPlacement = new Map();
  const placements = liveItems.filter(
    (item) => item.type === 'StagePlacement' && item.pinnedVersion == null,
  );
  const versions = await Promise.all(placements.map(loadPlacedStageVersion));
  placements.forEach((placement, index) => {
    stageVersionByPlacement.set(placement.sk, versions[index]);
  });

  return liveItems.map((item) => {
    const snapshot = { ...item, sk: workflowVersionSk(version, item.sk), version };
    // Snapshots are not catalog rows; only live META should appear in GSI1 lists.
    delete snapshot.GSI1PK;
    delete snapshot.GSI1SK;
    if (snapshot.type === 'StagePlacement' && snapshot.pinnedVersion == null) {
      snapshot.pinnedVersion = stageVersionByPlacement.get(item.sk);
    }
    return snapshot;
  });
};

const writeWorkflowSnapshot = async (tenant, workflowId, version, liveItems = null) => {
  const items = liveItems ?? (await queryLivePartition(tenant, workflowId));
  const snapshots = await buildSnapshotItems(items, version);
  await batchWrite(snapshots.map((Item) => ({ PutRequest: { Item } })));
};

const bumpWorkflowVersion = async (tenant, workflowId, metaOverrides = {}) => {
  const current = await loadMeta(tenant, workflowId);
  if (!current) return null;
  const meta = {
    ...current,
    ...metaOverrides,
    version: (current.version ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: meta }));
  await writeWorkflowSnapshot(tenant, workflowId, meta.version);
  return meta;
};

// Read resolution: a workflow visible to the user library is either its own
// `default` copy or the SYSTEM baseline (a fork shadows the imported baseline).
// Returns the owning namespace + meta.
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
  const requested = getRequestedVersion(event);
  if (requested.error) return res(400, { error: requested.error });
  const resolved = await resolveWorkflow(tenant, workflowId);
  if (!resolved) return res(404, { error: 'Not found' });
  const items = await queryWorkflowItems(resolved.owner, workflowId, requested.version);
  if (requested.version != null && items.length === 0)
    return res(404, { error: 'Version not found' });
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
    sourceItems = (await queryLivePartition(src.owner, input.basedOn)).filter((i) => i.sk !== META);
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
    version: 1,
    createdAt: now,
    updatedAt: now,
    GSI1PK: workflowGsi1Pk(tenant),
    GSI1SK: input.name,
  };

  const liveItems = [meta];
  for (const item of sourceItems) {
    liveItems.push({ ...item, pk: workflowPk(tenant, id) });
  }
  const snapshotItems = await buildSnapshotItems(liveItems, meta.version);
  const requests = [...liveItems, ...snapshotItems].map((Item) => ({ PutRequest: { Item } }));
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

  const meta = await bumpWorkflowVersion(tenant, workflowId, {
    name: input.name ?? current.name,
    objective: input.objective ?? current.objective,
    defaultScope: input.defaultScope ?? current.defaultScope,
    status: input.status ?? current.status,
    GSI1SK: input.name ?? current.name,
  });
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
  await bumpWorkflowVersion(tenant, workflowId);
  const items = await queryLivePartition(tenant, workflowId);
  return res(200, composeWorkflow(tenant, items));
};

// The seeded SYSTEM baseline workflow — the single place that carries the
// upstream stage → scope wiring (derived from each stage's frontmatter
// `scopes` by the seed; the persisted STAGE blocks deliberately do NOT keep
// the field, so the baseline placement is the only recoverable source).
const BASELINE_WORKFLOW_ID = 'aidlc-v2';

// A new placement's default scope membership: copy the SYSTEM baseline
// placement for the same stage. A custom stage (no baseline placement) or a
// lookup failure defaults to {} — the composer then shows it un-wired and the
// user assigns membership by hand, same as before.
const baselineScopeMembership = async (stageId) => {
  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: blocksTable(),
        Key: {
          pk: workflowPk(SYSTEM_TENANT, BASELINE_WORKFLOW_ID),
          sk: placementSk(stageId),
        },
      }),
    );
    return Item?.scopeMembership && typeof Item.scopeMembership === 'object'
      ? Item.scopeMembership
      : {};
  } catch {
    return {};
  }
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

  // No membership in the request (the composer never sends one on add) →
  // default from the SYSTEM baseline instead of {}. Field incident: an empty
  // membership silently excludes the stage from EVERY scope (isInScope needs
  // an explicit EXECUTE), so a stage re-added via the composer never executed
  // again — reverse-engineering ended up un-wired for all scopes.
  const withMembership =
    input.scopeMembership && typeof input.scopeMembership === 'object'
      ? input
      : { ...input, scopeMembership: await baselineScopeMembership(stageId) };
  const item = buildPlacementItem(tenant, workflowId, stageId, withMembership);
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  await bumpWorkflowVersion(tenant, workflowId);
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
  await bumpWorkflowVersion(tenant, workflowId);
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
  await bumpWorkflowVersion(tenant, workflowId);
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
  await bumpWorkflowVersion(tenant, workflowId);
  return res(201, scopeRefToApi(item));
};

const putScopeMembership = async (event, res, tenant, workflowId, scopeId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const current = await loadMeta(tenant, workflowId);
  if (!current) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });
  if (!Array.isArray(input.stageIds)) {
    return res(400, { error: 'stageIds must be an array' });
  }
  if (typeof scopeId !== 'string' || !scopeId) return res(400, { error: 'scopeId is required' });

  const selected = new Set();
  for (const stageId of input.stageIds) {
    if (typeof stageId !== 'string' || !stageId) {
      return res(400, { error: 'stageIds must contain non-empty strings' });
    }
    selected.add(stageId);
  }

  const placements = await queryLivePartition(tenant, workflowId, { skBeginsWith: 'PLACEMENT#' });
  const placedIds = new Set(placements.map((p) => p.stageId));
  const unknown = [...selected].filter((stageId) => !placedIds.has(stageId));
  if (unknown.length > 0) {
    return res(400, { error: `stageIds are not placed in this workflow: ${unknown.join(', ')}` });
  }

  const scopeSk = scopeRefSk(scopeId);
  const { Item: existingScopeRef } = await ddb.send(
    new GetCommand({
      TableName: blocksTable(),
      Key: { pk: workflowPk(tenant, workflowId), sk: scopeSk },
    }),
  );

  const requests = placements.map((placement) => ({
    PutRequest: {
      Item: {
        ...placement,
        scopeMembership: {
          ...placement.scopeMembership,
          [scopeId]: selected.has(placement.stageId) ? 'EXECUTE' : 'SKIP',
        },
      },
    },
  }));
  if (!existingScopeRef) {
    requests.push({
      PutRequest: {
        Item: {
          pk: workflowPk(tenant, workflowId),
          sk: scopeSk,
          type: 'ScopeRef',
          scopeId,
          scopeTenant: input.scopeTenant ?? SYSTEM_TENANT,
        },
      },
    });
  }

  await batchWrite(requests);
  await bumpWorkflowVersion(tenant, workflowId, {
    defaultScope: current.defaultScope ?? scopeId,
  });
  const items = await queryLivePartition(tenant, workflowId);
  return res(200, composeWorkflow(tenant, items));
};

const removeScopeRef = async (event, res, tenant, workflowId, scopeId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const meta = await loadMeta(tenant, workflowId);
  if (!meta) return res(404, { error: 'Not found' });
  const sk = scopeRefSk(scopeId);
  const current = await ddb.send(
    new GetCommand({ TableName: blocksTable(), Key: { pk: workflowPk(tenant, workflowId), sk } }),
  );
  if (!current.Item) return res(404, { error: 'Not found' });

  const placements = await queryLivePartition(tenant, workflowId, { skBeginsWith: 'PLACEMENT#' });
  const scopeRefs = await queryLivePartition(tenant, workflowId, { skBeginsWith: 'SCOPEREF#' });
  const nextDefaultScope =
    meta.defaultScope === scopeId
      ? (scopeRefs
          .map((ref) => ref.scopeId)
          .filter((id) => id !== scopeId)
          .toSorted()[0] ?? null)
      : meta.defaultScope;

  const requests = [
    { DeleteRequest: { Key: { pk: workflowPk(tenant, workflowId), sk } } },
    ...placements
      .filter((placement) => Object.hasOwn(placement.scopeMembership ?? {}, scopeId))
      .map((placement) => {
        const scopeMembership = { ...placement.scopeMembership };
        delete scopeMembership[scopeId];
        return { PutRequest: { Item: { ...placement, scopeMembership } } };
      }),
  ];

  await batchWrite(requests);
  await bumpWorkflowVersion(tenant, workflowId, { defaultScope: nextDefaultScope });
  return res(204, {});
};

// ── Rule refs ── layer a library rule into this workflow. Keyed by layer + id
// so the same rule id can't be layered twice; the compiler resolves which
// stages each rule applies to (universal layers everywhere, phase rules by
// matching phase). Layers are V2's resolution chain incl. the two learnings
// tiers (sourced from shared/blocks.js so the enum lives in one place).
const VALID_RULE_LAYERS = new Set(RULE_LAYERS);

const addRuleRef = async (event, res, tenant, workflowId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  if (!(await loadMeta(tenant, workflowId))) return res(404, { error: 'Not found' });
  const input = parseBody(event);
  if (input === undefined) return res(400, { error: 'Invalid JSON body' });
  const ruleId = input.ruleId;
  if (typeof ruleId !== 'string' || !ruleId) return res(400, { error: 'ruleId is required' });
  const layer = input.layer;
  if (!VALID_RULE_LAYERS.has(layer)) {
    return res(400, { error: `layer must be one of ${[...VALID_RULE_LAYERS].join(', ')}` });
  }

  const item = {
    pk: workflowPk(tenant, workflowId),
    sk: ruleRefSk(layer, ruleId),
    type: 'RuleRef',
    ruleId,
    layer,
    ruleTenant: input.ruleTenant ?? SYSTEM_TENANT,
  };
  await ddb.send(new PutCommand({ TableName: blocksTable(), Item: item }));
  await bumpWorkflowVersion(tenant, workflowId);
  return res(201, ruleRefToApi(item));
};

const removeRuleRef = async (event, res, tenant, workflowId, layer, ruleId) => {
  if (tenant === SYSTEM_TENANT) return res(403, { error: 'SYSTEM workflows are read-only' });
  const sk = ruleRefSk(layer, ruleId);
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
  await bumpWorkflowVersion(tenant, workflowId);
  return res(204, {});
};

// ── Compiled views ── derive scope-grid + autonomy-profile + stage-graph from
// the placements, scope refs, and the library Stage blocks they reference.
// Computed on demand (no cache yet); the pure compilers live in shared/compile.
const getCompiled = async (event, res, tenant, workflowId) => {
  const requested = getRequestedVersion(event);
  if (requested.error) return res(400, { error: requested.error });
  const resolved = await resolveWorkflow(tenant, workflowId);
  if (!resolved) return res(404, { error: 'Not found' });
  const items = await queryWorkflowItems(resolved.owner, workflowId, requested.version);
  if (requested.version != null && items.length === 0)
    return res(404, { error: 'Version not found' });

  const placements = items.filter((i) => i.sk.startsWith('PLACEMENT#')).map(placementToApi);
  const scopeSlugs = items.filter((i) => i.sk.startsWith('SCOPEREF#')).map((i) => i.scopeId);
  const ruleRefs = items.filter((i) => i.sk.startsWith('RULEREF#')).map(ruleRefToApi);

  // Batch-get the referenced Stage library blocks (V#latest), keyed by id; the
  // artifact vocabulary (so the graph can flag unknown/typo names); and the
  // referenced Rule blocks (so the rule view can resolve layers + phase match).
  const stagesById = await loadStages(placements);
  const artifactsById = await loadArtifacts(resolved.owner);
  const rulesById = await loadRules(ruleRefs);
  const compiled = compileWorkflow(
    placements,
    scopeSlugs,
    stagesById,
    artifactsById,
    ruleRefs,
    rulesById,
  );
  return res(200, compiled);
};

// Load everything buildExecutionPlan needs for one workflow version: the
// assembled composition, the referenced library blocks, and the compiled
// editor view. Shared by the execution preview (GET, scope+skip query) and
// the composed-grid dry run (POST, grid in body).
const loadPlanInputs = async (event, tenant, workflowId) => {
  const requested = getRequestedVersion(event);
  if (requested.error) return { status: 400, body: { error: requested.error } };
  const resolved = await resolveWorkflow(tenant, workflowId);
  if (!resolved) return { status: 404, body: { error: 'Not found' } };
  const items = await queryWorkflowItems(resolved.owner, workflowId, requested.version);
  if (requested.version != null && items.length === 0)
    return { status: 404, body: { error: 'Version not found' } };

  const workflow = composeWorkflow(resolved.owner, items);
  const placements = workflow.placements;
  const ruleRefs = workflow.ruleRefs;
  const scopeSlugs = workflow.scopeRefs.map((scopeRef) => scopeRef.scopeId);

  const [stagesById, artifactsById, rulesById, agentsById, sensorsById] = await Promise.all([
    loadStages(placements),
    loadArtifacts(resolved.owner),
    loadRules(ruleRefs),
    loadCatalogByType(resolved.owner, 'AGENT'),
    loadCatalogByType(resolved.owner, 'SENSOR'),
  ]);
  const compiled = compileWorkflow(
    placements,
    scopeSlugs,
    stagesById,
    artifactsById,
    ruleRefs,
    rulesById,
  );
  return {
    workflow,
    library: { stagesById, artifactsById, rulesById, agentsById, sensorsById },
    compiled,
  };
};

const getExecutionPreview = async (event, res, tenant, workflowId) => {
  const scope = event?.queryStringParameters?.scope;
  if (typeof scope !== 'string' || !scope) {
    return res(400, { error: 'scope query parameter is required' });
  }
  // Optional per-intent skip overlay preview (`skip=a,b,c`): lets the intent
  // creation UI dry-run a stage deselection and show the resulting warnings
  // (expected-absent inputs, degraded sections) BEFORE the intent exists.
  const skipParam = event?.queryStringParameters?.skip;
  const skipStageIds =
    typeof skipParam === 'string' && skipParam.trim()
      ? [
          ...new Set(
            skipParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]
      : null;

  const inputs = await loadPlanInputs(event, tenant, workflowId);
  if (inputs.status) return res(inputs.status, inputs.body);

  const preview = buildExecutionPlan({
    workflow: inputs.workflow,
    scope,
    library: inputs.library,
    compiled: inputs.compiled,
    ...(skipStageIds ? { skipStageIds } : {}),
  });
  return res(200, preview);
};

// POST /workflows/{id}/validate-grid — dry-run a composed EXECUTE/SKIP grid
// against the pinned workflow (upstream's validate-grid). Body:
//   { composedGrid: {stageId: EXECUTE|SKIP}, scope?, skipStageIds?, strict? }
// `scope` is the provenance label only (defaults to "composed"); `strict`
// promotes starved required inputs to errors (the in-flight recompose rule).
// Read-only despite the verb — a grid over 30+ stages does not fit a query
// string — so it is exempted from the admin guard in the router.
const validateGrid = async (event, res, tenant, workflowId) => {
  let data;
  try {
    data = event.body ? JSON.parse(event.body) : {};
  } catch {
    return res(400, { error: 'Request body must be valid JSON' });
  }
  const { value: composedGrid, error: gridError } = normalizeComposedGrid(data.composedGrid);
  if (gridError) return res(400, { error: gridError });
  if (!composedGrid) return res(400, { error: 'composedGrid is required' });
  const skipStageIds =
    Array.isArray(data.skipStageIds) && data.skipStageIds.length
      ? [...new Set(data.skipStageIds.filter((s) => typeof s === 'string' && s.trim()))]
      : null;

  const inputs = await loadPlanInputs(event, tenant, workflowId);
  if (inputs.status) return res(inputs.status, inputs.body);

  const result = buildExecutionPlan({
    workflow: inputs.workflow,
    scope: typeof data.scope === 'string' && data.scope ? data.scope : 'composed',
    library: inputs.library,
    compiled: inputs.compiled,
    composedGrid,
    ...(skipStageIds ? { skipStageIds } : {}),
    strict: data.strict === true,
  });
  return res(200, result);
};

const loadCatalogByType = async (owner, type) => {
  const tenants = owner === SYSTEM_TENANT ? [SYSTEM_TENANT] : [owner, SYSTEM_TENANT];
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
  const byId = {};
  for (const r of results) {
    for (const item of r.Items || []) {
      if (!(item.blockId in byId)) byId[item.blockId] = item;
    }
  }
  return byId;
};

// Resolve each rule ref's Rule block from its owning tenant (own or SYSTEM).
const loadRules = async (ruleRefs) => {
  const results = await Promise.all(
    ruleRefs.map((ref) =>
      ddb.send(
        new GetCommand({
          TableName: blocksTable(),
          Key: { pk: blockPk(ref.ruleTenant ?? SYSTEM_TENANT, 'RULE', ref.ruleId), sk: LATEST },
        }),
      ),
    ),
  );
  const rulesById = {};
  for (const { Item } of results) {
    if (Item) rulesById[Item.blockId] = Item;
  }
  return rulesById;
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

// Resolve each placement's Stage block from its owning tenant. Live workflows
// normally read V#latest; immutable workflow snapshots freeze null pins to the
// current stage version when the snapshot is written, so compiled ?version=N
// views replay the stage definitions that were current at that workflow version.
const loadStages = async (placements) => {
  const results = await Promise.all(
    placements.map((p) =>
      ddb.send(
        new GetCommand({
          TableName: blocksTable(),
          Key: {
            pk: blockPk(p.stageTenant ?? SYSTEM_TENANT, 'STAGE', p.stageId),
            sk: p.pinnedVersion ? versionSk(Number(p.pinnedVersion)) : LATEST,
          },
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
  version: item.version ?? 1,
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

const ruleRefToApi = (item) => ({
  ruleId: item.ruleId,
  layer: item.layer,
  ruleTenant: item.ruleTenant ?? SYSTEM_TENANT,
});

// Assemble the partition items into the composition the editor loads.
const composeWorkflow = (owner, items) => {
  const liveItems = items.filter(isLiveWorkflowItem);
  const meta = liveItems.find((i) => i.sk === META);
  const phases = liveItems
    .filter((i) => i.sk.startsWith('PHASE#'))
    .map(phaseToApi)
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const placements = liveItems
    .filter((i) => i.sk.startsWith('PLACEMENT#'))
    .map(placementToApi)
    .toSorted((a, b) => a.order - b.order);
  const scopeRefs = liveItems
    .filter((i) => i.sk.startsWith('SCOPEREF#'))
    .map(scopeRefToApi)
    .toSorted((a, b) => a.scopeId.localeCompare(b.scopeId));
  const ruleRefs = liveItems
    .filter((i) => i.sk.startsWith('RULEREF#'))
    .map(ruleRefToApi)
    .toSorted((a, b) => a.layer.localeCompare(b.layer) || a.ruleId.localeCompare(b.ruleId));
  return {
    ...(meta ? metaToApi(meta) : {}),
    owner,
    readOnly: owner === SYSTEM_TENANT,
    phases,
    placements,
    scopeRefs,
    ruleRefs,
  };
};

// ─── Router ───

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const method = event.httpMethod;
    const path = event.resource || event.path || '';

    // Workflow AUTHORING is platform-admin only: every mutation (create/update/
    // delete workflows, placements, phases, scope/rule refs) requires the
    // Cognito platform-admin group (shared/authz.js). Reads stay open — project
    // creation lists workflows and runs load compiled plans for every user.
    // validate-grid is a POST purely because a composed grid does not fit a
    // query string: it computes a dry-run plan and writes NOTHING, so it stays
    // open like the GET reads (the compose UI runs it for every user).
    if (method !== 'GET' && !path.endsWith('/validate-grid')) {
      const denied = requirePlatformAdmin(event);
      if (denied) return res(denied.statusCode, { error: denied.error, code: denied.code });
    }

    const { workflowId, stageId, scopeId, layer, ruleId } = event.pathParameters || {};
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
    if (path.endsWith('/scopes/{scopeId}/membership')) {
      if (method === 'PUT')
        return await putScopeMembership(event, res, tenant, workflowId, scopeId);
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
    if (path.endsWith('/rules/{layer}/{ruleId}')) {
      if (method === 'DELETE')
        return await removeRuleRef(event, res, tenant, workflowId, layer, ruleId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/rules')) {
      if (method === 'POST') return await addRuleRef(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/compiled')) {
      if (method === 'GET') return await getCompiled(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/execution-preview')) {
      if (method === 'GET') return await getExecutionPreview(event, res, tenant, workflowId);
      return res(405, { error: 'Method not allowed' });
    }
    if (path.endsWith('/validate-grid')) {
      if (method === 'POST') return await validateGrid(event, res, tenant, workflowId);
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
