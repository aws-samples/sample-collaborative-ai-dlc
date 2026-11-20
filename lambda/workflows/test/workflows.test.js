import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { LATEST } from '../../shared/blocks.js';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const BLOCKS_TABLE = 'blocks-test';

const ddbMock = mockClient(DynamoDBDocumentClient);

// In-memory blocks table keyed by `pk|sk`. Query supports the two access
// patterns the lambda uses: full-partition (pk =) with optional begins_with
// on sk, and GSI1 (by GSI1PK).
const store = new Map();
const keyOf = (pk, sk) => `${pk}|${sk}`;

const installFakes = () => {
  ddbMock.reset();
  store.clear();

  ddbMock.on(GetCommand).callsFake((input) => {
    const item = store.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: item ? { ...item } : undefined };
  });

  ddbMock.on(PutCommand).callsFake((input) => {
    const key = keyOf(input.Item.pk, input.Item.sk);
    if (input.ConditionExpression === 'attribute_not_exists(pk)' && store.has(key))
      throw Object.assign(new Error('Item exists'), { name: 'ConditionalCheckFailedException' });
    store.set(key, { ...input.Item });
    return {};
  });

  ddbMock.on(UpdateCommand).callsFake((input) => {
    const item = store.get(keyOf(input.Key.pk, input.Key.sk));
    if (!item || item.permissions != null)
      throw Object.assign(new Error('Placement changed'), {
        name: 'ConditionalCheckFailedException',
      });
    item.permissions = input.ExpressionAttributeValues[':permissions'];
    return {};
  });

  ddbMock.on(DeleteCommand).callsFake((input) => {
    store.delete(keyOf(input.Key.pk, input.Key.sk));
    return {};
  });

  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    let items = [...store.values()];
    if (input.IndexName === 'GSI1') {
      items = items.filter((i) => i.GSI1PK === values[':pk']);
    } else {
      items = items.filter((i) => i.pk === values[':pk']);
      if (values[':sk']) items = items.filter((i) => i.sk.startsWith(values[':sk']));
    }
    return { Items: items.map((i) => ({ ...i })) };
  });

  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    for (const [table, requests] of Object.entries(input.RequestItems)) {
      if (table !== BLOCKS_TABLE) continue;
      // DynamoDB rejects a BatchWrite that references the same key more than
      // once (e.g. a delete + put of the same key). Mirror that so tests catch
      // the collision instead of silently coalescing it.
      const seen = new Set();
      for (const req of requests) {
        const key = req.PutRequest
          ? keyOf(req.PutRequest.Item.pk, req.PutRequest.Item.sk)
          : keyOf(req.DeleteRequest.Key.pk, req.DeleteRequest.Key.sk);
        if (seen.has(key)) {
          const e = new Error('Provided list of item keys contains duplicates');
          e.name = 'ValidationException';
          throw e;
        }
        seen.add(key);
      }
      for (const req of requests) {
        if (req.PutRequest) {
          const item = req.PutRequest.Item;
          store.set(keyOf(item.pk, item.sk), { ...item });
        } else if (req.DeleteRequest) {
          store.delete(keyOf(req.DeleteRequest.Key.pk, req.DeleteRequest.Key.sk));
        }
      }
    }
    return {};
  });
};

// Workflow authoring requires the platform-admin group, so the default test
// caller is an admin; non-admin behaviour is covered explicitly below.
const claims = { sub: 'user-1', email: 'user@example.com', 'cognito:groups': 'platform-admin' };

const event = ({ method, workflowId, stageId, scopeId, layer, ruleId, body, path, query }) => {
  let resource = '/workflows';
  const pathParameters = {};
  if (workflowId) {
    resource = '/workflows/{workflowId}';
    pathParameters.workflowId = workflowId;
  }
  if (path === 'phases') resource = '/workflows/{workflowId}/phases';
  if (path === 'placements') resource = '/workflows/{workflowId}/placements';
  if (path === 'placement') {
    resource = '/workflows/{workflowId}/placements/{stageId}';
    pathParameters.stageId = stageId;
  }
  if (path === 'scopes') resource = '/workflows/{workflowId}/scopes';
  if (path === 'scope') {
    resource = '/workflows/{workflowId}/scopes/{scopeId}';
    pathParameters.scopeId = scopeId;
  }
  if (path === 'scope-membership') {
    resource = '/workflows/{workflowId}/scopes/{scopeId}/membership';
    pathParameters.scopeId = scopeId;
  }
  if (path === 'rules') resource = '/workflows/{workflowId}/rules';
  if (path === 'rule') {
    resource = '/workflows/{workflowId}/rules/{layer}/{ruleId}';
    pathParameters.layer = layer;
    pathParameters.ruleId = ruleId;
  }
  if (path === 'compiled') resource = '/workflows/{workflowId}/compiled';
  if (path === 'execution-preview') resource = '/workflows/{workflowId}/execution-preview';
  return {
    httpMethod: method,
    resource,
    pathParameters,
    body: body === undefined ? null : JSON.stringify(body),
    queryStringParameters: query ?? {},
    requestContext: { authorizer: { claims } },
    headers: {},
  };
};

let handler;
const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  installFakes();
});

// Helper: create a baseline workflow and return its id.
const createWorkflow = (body) => handler(event({ method: 'POST', body }));

describe('workflows handler', () => {
  it('places a stage saved without a role mapping as unmapped, even under a default stage ID', async () => {
    const pk = 'BLOCK#default#STAGE#requirements-analysis';
    store.set(`${pk}|V#latest`, {
      pk,
      blockId: 'requirements-analysis',
      version: 1,
      permissions: null,
    });
    await createWorkflow({ id: 'unmapped-flow', name: 'Unmapped' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'unmapped-flow',
          path: 'placements',
          body: { stageId: 'requirements-analysis' },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.permissions).toBeNull();
  });

  it('copies custom stage defaults only when adding a placement, retaining existing workflow mappings', async () => {
    const permissions = { decisionMakerRoles: ['architect'], contributorRoles: ['developer'] };
    const pk = 'BLOCK#default#STAGE#custom-stage';
    store.set(`${pk}|V#latest`, { pk, blockId: 'custom-stage', version: 1, permissions });
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'custom-stage' },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.stageTenant).toBe('default');
    expect(added.body.permissions).toEqual(permissions);
    store.set(`${pk}|V#latest`, {
      pk,
      blockId: 'custom-stage',
      version: 2,
      permissions: { decisionMakerRoles: ['qa-tester'], contributorRoles: [] },
    });
    const updated = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          stageId: 'custom-stage',
          path: 'placement',
          body: { phasePath: '01' },
        }),
      ),
    );
    expect(updated.body.permissions).toEqual(permissions);
    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(loaded.body.cedarPolicies).toContain('architect');
    expect(loaded.body.cedarPolicies).not.toContain('qa-tester');
    const snapshot = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', query: { version: '2' } })),
    );
    expect(snapshot.body.placements[0].permissions).toEqual(permissions);
  });

  it.each([null, { decisionMakerRoles: ['qa-tester'], contributorRoles: [] }])(
    'keeps an explicit placement mapping instead of the stage defaults: %j',
    async (permissions) => {
      const pk = 'BLOCK#default#STAGE#custom-stage';
      store.set(`${pk}|V#latest`, {
        pk,
        blockId: 'custom-stage',
        version: 1,
        permissions: { decisionMakerRoles: ['architect'], contributorRoles: [] },
      });
      await createWorkflow({ id: 'wf', name: 'WF' });
      const added = parse(
        await handler(
          event({
            method: 'POST',
            workflowId: 'wf',
            path: 'placements',
            body: { stageId: 'custom-stage', permissions },
          }),
        ),
      );
      expect(added.body.permissions).toEqual(permissions);
    },
  );

  it('copies defaults from the exact pinned block version and tenant', async () => {
    const pk = 'BLOCK#default#STAGE#custom-stage';
    const permissions = { decisionMakerRoles: ['architect'], contributorRoles: [] };
    store.set(`${pk}|V#1`, { pk, blockId: 'custom-stage', version: 1, permissions });
    store.set(`${pk}|V#latest`, {
      pk,
      blockId: 'custom-stage',
      version: 2,
      permissions: { decisionMakerRoles: ['developer'], contributorRoles: [] },
    });
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'custom-stage', stageTenant: 'default', pinnedVersion: 1 },
        }),
      ),
    );
    expect(added.body.permissions).toEqual(permissions);
    expect(added.body.pinnedVersion).toBe(1);
  });

  it('does not offer default initialization for custom stages, but does for a missing saved policy', async () => {
    await createWorkflow({ id: 'custom-flow', name: 'Custom' });
    const pk = 'WF#default#custom-flow';
    store.set(`${pk}|PLACEMENT#custom`, {
      pk,
      sk: 'PLACEMENT#custom',
      type: 'StagePlacement',
      stageId: 'custom',
    });
    const current = () => handler(event({ method: 'GET', workflowId: 'custom-flow' }));
    expect(parse(await current()).body.needsDefaultResponsibilities).toBe(false);
    delete store.get(`${pk}|META`).cedarPolicies;
    expect(parse(await current()).body.needsDefaultResponsibilities).toBe(true);
  });

  it.each(['delete', 'assign'])(
    'default initialization preserves a concurrent stage %s',
    async (change) => {
      const workflowId = 'initialize-flow';
      await createWorkflow({ id: workflowId, name: 'Initialize' });
      const pk = `WF#default#${workflowId}`;
      store.set(`${pk}|PLACEMENT#requirements-analysis`, {
        pk,
        sk: 'PLACEMENT#requirements-analysis',
        type: 'StagePlacement',
        stageId: 'requirements-analysis',
      });
      const patchStarted = Promise.withResolvers();
      const finishPatch = Promise.withResolvers();
      ddbMock.on(UpdateCommand).callsFake(async (input) => {
        patchStarted.resolve();
        await finishPatch.promise;
        const item = store.get(keyOf(input.Key.pk, input.Key.sk));
        if (!item || item.permissions != null)
          throw Object.assign(new Error('Placement changed'), {
            name: 'ConditionalCheckFailedException',
          });
        item.permissions = input.ExpressionAttributeValues[':permissions'];
        return {};
      });
      const initializing = handler(
        event({
          method: 'PUT',
          workflowId,
          body: { applyDefaultPermissions: true },
        }),
      );
      const permissions = { decisionMakerRoles: ['architect'], contributorRoles: [] };
      let changed;
      try {
        await patchStarted.promise;
        changed = await handler(
          event({
            method: change === 'delete' ? 'DELETE' : 'PUT',
            workflowId,
            path: 'placement',
            stageId: 'requirements-analysis',
            ...(change === 'assign' ? { body: { permissions } } : {}),
          }),
        );
      } finally {
        finishPatch.resolve();
      }
      expect(parse(changed).status).toBe(change === 'delete' ? 204 : 200);
      expect(parse(await initializing).status).toBe(200);
      const current = parse(await handler(event({ method: 'GET', workflowId }))).body;
      if (change === 'delete') expect(current.placements).toEqual([]);
      else expect(current.placements[0].permissions).toEqual(permissions);
    },
  );

  it('does not restore a stage deleted while another request saves workflow metadata', async () => {
    await createWorkflow({ id: 'overlap-flow', name: 'Overlap' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'overlap-flow',
        path: 'placements',
        body: { stageId: 'requirements-analysis' },
      }),
    );
    const snapshotStarted = Promise.withResolvers();
    const finishSnapshot = Promise.withResolvers();
    ddbMock.on(GetCommand).callsFake(async (input) => {
      if (input.Key.sk === LATEST) {
        snapshotStarted.resolve();
        await finishSnapshot.promise;
      }
      const item = store.get(keyOf(input.Key.pk, input.Key.sk));
      return { Item: item ? { ...item } : undefined };
    });
    const saving = handler(
      event({ method: 'PUT', workflowId: 'overlap-flow', body: { name: 'Renamed' } }),
    );
    let deletion;
    try {
      await snapshotStarted.promise;
      deletion = await handler(
        event({
          method: 'DELETE',
          workflowId: 'overlap-flow',
          path: 'placement',
          stageId: 'requirements-analysis',
        }),
      );
    } finally {
      finishSnapshot.resolve();
    }
    // Both saves computed the same version: the deletion published it first,
    // so the rename is rejected instead of replacing the published version.
    const saved = parse(await saving);
    expect(saved.status).toBe(409);
    expect(saved.body.error).toMatch(/Reload it and try again/);
    expect(parse(deletion).status).toBe(204);
    const current = parse(await handler(event({ method: 'GET', workflowId: 'overlap-flow' })));
    expect(current.body.placements).toEqual([]);
    expect(current.body.name).toBe('Overlap');
    expect(store.has('WF#default#overlap-flow|PLACEMENT#requirements-analysis')).toBe(false);
    expect(store.get(`WF#default#overlap-flow|V#${current.body.version}#META`).name).toBe(
      'Overlap',
    );
  });

  it('chooses the next version from a strongly consistent read of the workflow', async () => {
    await createWorkflow({ id: 'consistent-flow', name: 'Consistent' });
    ddbMock.resetHistory();
    const saved = await handler(
      event({ method: 'PUT', workflowId: 'consistent-flow', body: { name: 'Renamed' } }),
    );
    expect(parse(saved).status).toBe(200);
    const metaReads = ddbMock
      .commandCalls(GetCommand)
      .map((call) => call.args[0].input)
      .filter((input) => input.Key.sk === 'META');
    expect(metaReads.length).toBeGreaterThan(0);
    expect(metaReads.every((input) => input.ConsistentRead === true)).toBe(true);
  });

  it('exposes a version only after its whole snapshot is written', async () => {
    await createWorkflow({ id: 'partial-flow', name: 'Partial' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'partial-flow',
        path: 'placements',
        body: { stageId: 'requirements-analysis' },
      }),
    );
    const before = parse(await handler(event({ method: 'GET', workflowId: 'partial-flow' }))).body;
    const next = before.version + 1;
    // The snapshot batch fails after the version number was computed.
    ddbMock.on(BatchWriteCommand).rejects(new Error('Throttled'));
    const failed = await handler(
      event({ method: 'PUT', workflowId: 'partial-flow', body: { name: 'Renamed' } }),
    );
    expect(parse(failed).status).toBe(500);
    expect(store.has(`WF#default#partial-flow|V#${next}#META`)).toBe(false);
    expect(store.get('WF#default#partial-flow|META').version).toBe(before.version);
  });

  it('publishes responsibilities in new complete snapshots and preserves older versions and copied policy bytes', async () => {
    await createWorkflow({ id: 'roles-flow', name: 'Roles' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'roles-flow',
        path: 'placements',
        body: { stageId: 'requirements-analysis' },
      }),
    );
    const current = parse(await handler(event({ method: 'GET', workflowId: 'roles-flow' }))).body;
    expect(current.businessRoles).toContainEqual({ id: 'architect', name: 'Architect' });
    expect(current.placements[0].permissions).toEqual({
      decisionMakerRoles: ['product-owner'],
      contributorRoles: ['business-analyst', 'architect', 'qa-tester', 'security-compliance'],
    });
    const previous = structuredClone(store.get('WF#default#roles-flow|V#2#META'));
    await handler(
      event({
        method: 'PUT',
        workflowId: 'roles-flow',
        path: 'placement',
        stageId: 'requirements-analysis',
        body: { permissions: { decisionMakerRoles: ['architect'], contributorRoles: [] } },
      }),
    );
    expect(store.get('WF#default#roles-flow|V#2#META')).toEqual(previous);
    const frozen = parse(
      await handler(
        event({
          method: 'GET',
          workflowId: 'roles-flow',
          query: { version: '2' },
        }),
      ),
    ).body;
    expect(frozen.cedarPolicies).toBe(previous.cedarPolicies);
    expect(frozen.placements[0].permissions.decisionMakerRoles).toEqual(['product-owner']);
    await createWorkflow({ id: 'copied-flow', name: 'Copy', basedOn: 'roles-flow' });
    const copied = parse(await handler(event({ method: 'GET', workflowId: 'copied-flow' }))).body;
    const latest = parse(await handler(event({ method: 'GET', workflowId: 'roles-flow' }))).body;
    expect(copied.cedarPolicies).toBe(latest.cedarPolicies);
    expect(copied.placements[0].permissions).toEqual(latest.placements[0].permissions);
  });

  it('adds defaults only in a new version, leaves custom stages unmapped, and refuses invalid roles before saving', async () => {
    await createWorkflow({ id: 'legacy-flow', name: 'Legacy' });
    const pk = 'WF#default#legacy-flow';
    store.set(`${pk}|PLACEMENT#requirements-analysis`, {
      pk,
      sk: 'PLACEMENT#requirements-analysis',
      type: 'StagePlacement',
      stageId: 'requirements-analysis',
    });
    store.set(`${pk}|PLACEMENT#custom`, {
      pk,
      sk: 'PLACEMENT#custom',
      type: 'StagePlacement',
      stageId: 'custom',
    });
    const before = parse(await handler(event({ method: 'GET', workflowId: 'legacy-flow' }))).body;
    expect(before.needsDefaultResponsibilities).toBe(true);
    const result = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'legacy-flow',
          body: { applyDefaultPermissions: true },
        }),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.body.version).toBe(2);
    expect(
      store.get(`${pk}|V#2#PLACEMENT#requirements-analysis`).permissions.decisionMakerRoles,
    ).toEqual(['product-owner']);
    expect(store.get(`${pk}|V#2#PLACEMENT#custom`).permissions).toBeNull();
    const after = parse(await handler(event({ method: 'GET', workflowId: 'legacy-flow' }))).body;
    expect(after.needsDefaultResponsibilities).toBe(false);
    expect(store.has(`${pk}|V#1#PLACEMENT#requirements-analysis`)).toBe(false);
    const invalid = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'legacy-flow',
          path: 'placement',
          stageId: 'custom',
          body: { permissions: { decisionMakerRoles: ['unknown'], contributorRoles: [] } },
        }),
      ),
    );
    expect(invalid.status).toBe(400);
    expect(store.get(`${pk}|PLACEMENT#custom`).permissions).toBeNull();
  });

  it('keeps a placement saved before responsibilities unmapped when another field changes', async () => {
    await createWorkflow({ id: 'moved-flow', name: 'Moved' });
    const pk = 'WF#default#moved-flow';
    store.set(`${pk}|PLACEMENT#requirements-analysis`, {
      pk,
      sk: 'PLACEMENT#requirements-analysis',
      type: 'StagePlacement',
      stageId: 'requirements-analysis',
      order: 1,
    });
    const move = (body) =>
      handler(
        event({
          method: 'PUT',
          workflowId: 'moved-flow',
          path: 'placement',
          stageId: 'requirements-analysis',
          body,
        }),
      );
    expect(parse(await move({ order: 2 })).status).toBe(200);
    expect(store.get(`${pk}|PLACEMENT#requirements-analysis`)).toMatchObject({ order: 2 });
    expect(store.get(`${pk}|PLACEMENT#requirements-analysis`)).not.toHaveProperty('permissions');
    expect(store.get(`${pk}|V#2#PLACEMENT#requirements-analysis`)).not.toHaveProperty(
      'permissions',
    );
    const moved = parse(await handler(event({ method: 'GET', workflowId: 'moved-flow' }))).body;
    expect(moved.needsDefaultResponsibilities).toBe(true);

    const permissions = { decisionMakerRoles: ['architect'], contributorRoles: [] };
    expect(parse(await move({ permissions })).status).toBe(200);
    expect(parse(await move({ order: 3 })).status).toBe(200);
    expect(store.get(`${pk}|PLACEMENT#requirements-analysis`).permissions).toEqual(permissions);
  });

  it('never reassigns responsibilities explicitly removed, when copying or applying defaults', async () => {
    await createWorkflow({ id: 'removed-flow', name: 'Removed' });
    const pk = 'WF#default#removed-flow';
    store.set(`${pk}|PLACEMENT#requirements-analysis`, {
      pk,
      sk: 'PLACEMENT#requirements-analysis',
      type: 'StagePlacement',
      stageId: 'requirements-analysis',
      permissions: null,
    });
    store.set(`${pk}|PLACEMENT#user-stories`, {
      pk,
      sk: 'PLACEMENT#user-stories',
      type: 'StagePlacement',
      stageId: 'user-stories',
    });
    const apply = await handler(
      event({ method: 'PUT', workflowId: 'removed-flow', body: { applyDefaultPermissions: true } }),
    );
    expect(parse(apply).status).toBe(200);
    expect(store.get(`${pk}|PLACEMENT#requirements-analysis`).permissions).toBeNull();
    expect(store.get(`${pk}|PLACEMENT#user-stories`).permissions.decisionMakerRoles).toEqual([
      'product-owner',
    ]);
    const source = parse(await handler(event({ method: 'GET', workflowId: 'removed-flow' }))).body;
    expect(source.needsDefaultResponsibilities).toBe(false);
    expect(source.cedarPolicies).not.toContain('Stage::"requirements-analysis"');

    await createWorkflow({ id: 'removed-copy', name: 'Copy', basedOn: 'removed-flow' });
    const copyPk = 'WF#default#removed-copy';
    expect(store.get(`${copyPk}|PLACEMENT#requirements-analysis`).permissions).toBeNull();
    const copy = parse(await handler(event({ method: 'GET', workflowId: 'removed-copy' }))).body;
    expect(copy.cedarPolicies).toBe(source.cedarPolicies);
    expect(copy.needsDefaultResponsibilities).toBe(false);
  });

  it('gives a copy defaults only for placements saved before responsibilities', async () => {
    await createWorkflow({ id: 'old-flow', name: 'Old' });
    const pk = 'WF#default#old-flow';
    store.set(`${pk}|PLACEMENT#requirements-analysis`, {
      pk,
      sk: 'PLACEMENT#requirements-analysis',
      type: 'StagePlacement',
      stageId: 'requirements-analysis',
    });
    store.set(`${pk}|PLACEMENT#user-stories`, {
      pk,
      sk: 'PLACEMENT#user-stories',
      type: 'StagePlacement',
      stageId: 'user-stories',
      permissions: null,
    });
    await createWorkflow({ id: 'old-copy', name: 'Copy', basedOn: 'old-flow' });
    const copyPk = 'WF#default#old-copy';
    expect(
      store.get(`${copyPk}|PLACEMENT#requirements-analysis`).permissions.decisionMakerRoles,
    ).toEqual(['product-owner']);
    expect(store.get(`${copyPk}|PLACEMENT#user-stories`).permissions).toBeNull();
    const copy = parse(await handler(event({ method: 'GET', workflowId: 'old-copy' }))).body;
    expect(copy.cedarPolicies).toContain('Stage::"requirements-analysis"');
    expect(copy.cedarPolicies).not.toContain('Stage::"user-stories"');
  });

  it('200 on OPTIONS', async () => {
    const res = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(res.statusCode).toBe(200);
  });

  it('creates a workflow META and lists it via GSI1', async () => {
    const created = parse(
      await createWorkflow({ id: 'mvp-flow', name: 'MVP Flow', objective: 'Ship the MVP' }),
    );
    expect(created.status).toBe(201);
    expect(created.body.id).toBe('mvp-flow');
    expect(created.body.status).toBe('DRAFT');

    const list = parse(await handler(event({ method: 'GET' })));
    expect(list.status).toBe(200);
    expect(list.body.workflows.map((w) => w.id)).toContain('mvp-flow');
  });

  it('validates id and name on create', async () => {
    expect(parse(await createWorkflow({ id: 'Bad Id', name: 'X' })).status).toBe(400);
    expect(parse(await createWorkflow({ id: 'ok-id' })).status).toBe(400);
  });

  it('409 on duplicate workflow id', async () => {
    await createWorkflow({ id: 'dup', name: 'Dup' });
    expect(parse(await createWorkflow({ id: 'dup', name: 'Dup' })).status).toBe(409);
  });

  it('loads the full composition in one query', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const res = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(res.status).toBe(200);
    expect(res.body.phases).toEqual([]);
    expect(res.body.placements).toEqual([]);
    expect(res.body.version).toBe(1);
  });

  it('writes immutable workflow snapshots and serves pinned versions', async () => {
    store.set('BLOCK#SYSTEM#STAGE#scope-definition|V#latest', {
      pk: 'BLOCK#SYSTEM#STAGE#scope-definition',
      sk: 'V#latest',
      tenantId: 'SYSTEM',
      blockType: 'STAGE',
      blockId: 'scope-definition',
      version: 7,
      produces: [],
      consumes: [],
      requires: [],
      blocksOn: [],
      sensors: ['linter'],
      reviewer: null,
      humanValidation: 'none',
    });
    store.set('BLOCK#SYSTEM#STAGE#scope-definition|V#7', {
      pk: 'BLOCK#SYSTEM#STAGE#scope-definition',
      sk: 'V#7',
      tenantId: 'SYSTEM',
      blockType: 'STAGE',
      blockId: 'scope-definition',
      version: 7,
      produces: [],
      consumes: [],
      requires: [],
      blocksOn: [],
      sensors: ['linter'],
      reviewer: null,
      humanValidation: 'none',
    });

    await createWorkflow({ id: 'wf', name: 'WF' });
    expect(store.has('WF#default#wf|V#1#META')).toBe(true);

    const v2 = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'phases',
          body: { phases: [{ phaseId: 'ideation', path: '01', kind: 'phase' }] },
        }),
      ),
    );
    expect(v2.body.version).toBe(2);

    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'scope-definition', phasePath: '01' },
      }),
    );

    const latest = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(latest.body.version).toBe(3);
    expect(latest.body.placements[0].pinnedVersion).toBeNull();

    const initial = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', query: { version: '1' } })),
    );
    expect(initial.body.version).toBe(1);
    expect(initial.body.phases).toEqual([]);
    expect(initial.body.placements).toEqual([]);

    const afterPhase = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', query: { version: '2' } })),
    );
    expect(afterPhase.body.version).toBe(2);
    expect(afterPhase.body.phases.map((p) => p.phaseId)).toEqual(['ideation']);
    expect(afterPhase.body.placements).toEqual([]);

    const afterPlacement = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', query: { version: '3' } })),
    );
    expect(afterPlacement.body.version).toBe(3);
    expect(afterPlacement.body.placements).toHaveLength(1);
    expect(afterPlacement.body.placements[0].pinnedVersion).toBe(7);

    store.set('BLOCK#SYSTEM#STAGE#scope-definition|V#latest', {
      pk: 'BLOCK#SYSTEM#STAGE#scope-definition',
      sk: 'V#latest',
      tenantId: 'SYSTEM',
      blockType: 'STAGE',
      blockId: 'scope-definition',
      version: 8,
      produces: [],
      consumes: [],
      requires: [],
      blocksOn: [],
      sensors: ['linter'],
      reviewer: 'aidlc-product-lead-agent',
      humanValidation: 'none',
    });

    const compiledPinned = parse(
      await handler(
        event({ method: 'GET', workflowId: 'wf', path: 'compiled', query: { version: '3' } }),
      ),
    );
    // Pinned V#7: deterministic sensor only, no reviewer → self-halting.
    expect(compiledPinned.body.autonomy.perStage['scope-definition']).toBe('self-halting');
    const compiledLatest = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', path: 'compiled' })),
    );
    // Latest V#8: a reviewer was added (no unconditional human gate) → mixed.
    expect(compiledLatest.body.autonomy.perStage['scope-definition']).toBe('mixed');

    await handler(
      event({
        method: 'PUT',
        workflowId: 'wf',
        path: 'phases',
        body: { phases: [{ phaseId: 'construction', path: '01', kind: 'phase' }] },
      }),
    );
    const stillV2 = parse(
      await handler(event({ method: 'GET', workflowId: 'wf', query: { version: '2' } })),
    );
    expect(stillV2.body.phases.map((p) => p.phaseId)).toEqual(['ideation']);
  });

  it('replaces the phase tree (ordered, nestable)', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'phases',
          body: {
            phases: [
              { phaseId: 'ideation', path: '01', kind: 'phase' },
              { phaseId: 'requirements', path: '01.02', kind: 'stage' },
              { phaseId: 'construction', path: '02', kind: 'phase' },
            ],
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.phases.map((g) => g.path)).toEqual(['01', '01.02', '02']);
    // Nesting is derived from the path.
    const nested = res.body.phases.find((g) => g.path === '01.02');
    expect(nested.parentPath).toBe('01');
    expect(nested.order).toBe(2);
  });

  it('adds a second phase when one already exists (no delete+put key collision)', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    // First tree: one phase.
    await handler(
      event({
        method: 'PUT',
        workflowId: 'wf',
        path: 'phases',
        body: { phases: [{ phaseId: 'ideation', path: '01', kind: 'phase' }] },
      }),
    );
    // Second tree: keep the first (unchanged key) and add a second. The
    // unchanged node must not appear in both a delete and a put of one
    // BatchWrite — that previously triggered a ValidationException → 500.
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'phases',
          body: {
            phases: [
              { phaseId: 'ideation', path: '01', kind: 'phase' },
              { phaseId: 'construction', path: '02', kind: 'phase' },
            ],
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.phases.map((g) => g.phaseId)).toEqual(['ideation', 'construction']);
  });

  it('removes a phase when the new tree omits it', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({
        method: 'PUT',
        workflowId: 'wf',
        path: 'phases',
        body: {
          phases: [
            { phaseId: 'ideation', path: '01', kind: 'phase' },
            { phaseId: 'construction', path: '02', kind: 'phase' },
          ],
        },
      }),
    );
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'phases',
          body: { phases: [{ phaseId: 'construction', path: '01', kind: 'phase' }] },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.phases.map((g) => g.phaseId)).toEqual(['construction']);
  });

  it('rejects a malformed phase path', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'phases',
          body: { phases: [{ phaseId: 'x', path: 'nope' }] },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('adds, updates, and removes a stage placement', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });

    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'scope-definition', phasePath: '01', order: 4 },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.stageId).toBe('scope-definition');
    expect(added.body.order).toBe(4);

    // Duplicate placement rejected.
    const dup = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'scope-definition' },
        }),
      ),
    );
    expect(dup.status).toBe(409);

    // Update scope membership.
    const updated = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          stageId: 'scope-definition',
          path: 'placement',
          body: { scopeMembership: { mvp: 'EXECUTE', enterprise: 'SKIP' } },
        }),
      ),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.scopeMembership).toEqual({ mvp: 'EXECUTE', enterprise: 'SKIP' });

    // It shows up in the composition.
    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(loaded.body.placements).toHaveLength(1);

    // Remove it.
    const removed = await handler(
      event({ method: 'DELETE', workflowId: 'wf', stageId: 'scope-definition', path: 'placement' }),
    );
    expect(removed.statusCode).toBe(204);
    const after = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(after.body.placements).toHaveLength(0);
  });

  it('defaults a new placement scopeMembership from the SYSTEM baseline (composer sends none)', async () => {
    // Field incident: adding a stage via the composer stored scopeMembership {}
    // — the stage was silently excluded from EVERY scope (reverse-engineering
    // was un-wired). The baseline placement carries the upstream wiring.
    store.set('WF#SYSTEM#aidlc-v2|PLACEMENT#reverse-engineering', {
      pk: 'WF#SYSTEM#aidlc-v2',
      sk: 'PLACEMENT#reverse-engineering',
      type: 'StagePlacement',
      stageId: 'reverse-engineering',
      scopeMembership: { mvp: 'EXECUTE', feature: 'EXECUTE', enterprise: 'EXECUTE' },
    });
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'reverse-engineering' },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.scopeMembership).toEqual({
      mvp: 'EXECUTE',
      feature: 'EXECUTE',
      enterprise: 'EXECUTE',
    });
  });

  it('an explicit scopeMembership in the request wins over the baseline default', async () => {
    store.set('WF#SYSTEM#aidlc-v2|PLACEMENT#reverse-engineering', {
      pk: 'WF#SYSTEM#aidlc-v2',
      sk: 'PLACEMENT#reverse-engineering',
      type: 'StagePlacement',
      stageId: 'reverse-engineering',
      scopeMembership: { mvp: 'EXECUTE' },
    });
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'reverse-engineering', scopeMembership: { mvp: 'SKIP' } },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.scopeMembership).toEqual({ mvp: 'SKIP' });
  });

  it('a custom stage with no baseline placement still defaults to {}', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId: 'my-custom-stage' },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.scopeMembership).toEqual({});
  });

  it('adds and removes scope refs, exposed in the composition', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const added = parse(
      await handler(
        event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'mvp' } }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.scopeId).toBe('mvp');

    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(loaded.body.scopeRefs.map((s) => s.scopeId)).toEqual(['mvp']);

    const removed = await handler(
      event({ method: 'DELETE', workflowId: 'wf', scopeId: 'mvp', path: 'scope' }),
    );
    expect(removed.statusCode).toBe(204);
    const after = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(after.body.scopeRefs).toEqual([]);
  });

  it('bulk writes scope membership as EXECUTE for selected stages and SKIP for the rest', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'capture', scopeMembership: { old: 'EXECUTE' } },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'design', scopeMembership: { old: 'SKIP' } },
      }),
    );

    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          scopeId: 'mvp',
          path: 'scope-membership',
          body: { stageIds: ['capture'] },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.defaultScope).toBe('mvp');
    expect(res.body.scopeRefs.map((s) => s.scopeId)).toEqual(['mvp']);
    expect(res.body.placements.find((p) => p.stageId === 'capture').scopeMembership).toEqual({
      old: 'EXECUTE',
      mvp: 'EXECUTE',
    });
    expect(res.body.placements.find((p) => p.stageId === 'design').scopeMembership).toEqual({
      old: 'SKIP',
      mvp: 'SKIP',
    });
  });

  it('scope removal cleans placement membership keys and repairs defaultScope', async () => {
    await createWorkflow({ id: 'wf', name: 'WF', defaultScope: 'mvp' });
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'mvp' } }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'scopes',
        body: { scopeId: 'enterprise' },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: {
          stageId: 'capture',
          scopeMembership: { mvp: 'EXECUTE', enterprise: 'EXECUTE' },
        },
      }),
    );

    const removed = await handler(
      event({ method: 'DELETE', workflowId: 'wf', scopeId: 'mvp', path: 'scope' }),
    );
    expect(removed.statusCode).toBe(204);

    const after = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(after.body.defaultScope).toBe('enterprise');
    expect(after.body.scopeRefs.map((s) => s.scopeId)).toEqual(['enterprise']);
    expect(after.body.placements[0].scopeMembership).toEqual({ enterprise: 'EXECUTE' });
  });

  it('adds and removes rule refs, exposed in the composition and rejecting bad layers', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });

    const bad = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'rules',
          body: { ruleId: 'aidlc-org', layer: 'nonsense' },
        }),
      ),
    );
    expect(bad.status).toBe(400);

    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'rules',
          body: { ruleId: 'aidlc-org', layer: 'org' },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ ruleId: 'aidlc-org', layer: 'org' });

    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(loaded.body.ruleRefs.map((r) => `${r.layer}:${r.ruleId}`)).toEqual(['org:aidlc-org']);

    const removed = await handler(
      event({
        method: 'DELETE',
        workflowId: 'wf',
        layer: 'org',
        ruleId: 'aidlc-org',
        path: 'rule',
      }),
    );
    expect(removed.statusCode).toBe(204);
    const after = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(after.body.ruleRefs).toEqual([]);
  });

  it('compiles the rule view: universal layers everywhere, phase rules by phase match', async () => {
    const seedRule = (id, layer, phase) => {
      store.set(`BLOCK#SYSTEM#RULE#${id}|V#latest`, {
        pk: `BLOCK#SYSTEM#RULE#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: 'RULE',
        blockId: id,
        layer,
        phase: phase ?? null,
      });
    };
    const seedStage = (id, phase) => {
      store.set(`BLOCK#SYSTEM#STAGE#${id}|V#latest`, {
        pk: `BLOCK#SYSTEM#STAGE#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: 'STAGE',
        blockId: id,
        phase,
        produces: [],
        consumes: [],
        requires: [],
        blocksOn: [],
        sensors: [],
        reviewer: null,
        humanValidation: 'none',
      });
    };
    seedRule('aidlc-org', 'org');
    seedRule('aidlc-phase-ideation', 'phase', 'ideation');
    seedStage('intent-capture', 'ideation');

    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'intent-capture' },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'rules',
        body: { ruleId: 'aidlc-org', layer: 'org' },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'rules',
        body: { ruleId: 'aidlc-phase-ideation', layer: 'phase' },
      }),
    );

    const res = parse(await handler(event({ method: 'GET', workflowId: 'wf', path: 'compiled' })));
    expect(res.status).toBe(200);
    expect(res.body.rules.universal.map((u) => u.ruleId)).toEqual(['aidlc-org']);
    expect(res.body.rules.perStage['intent-capture']).toEqual({
      universal: ['aidlc-org'],
      phase: ['aidlc-phase-ideation'],
    });
    expect(res.body.rules.unresolved).toEqual([]);
  });

  it('compiles scope-grid + autonomy + graph from placements and referenced stages', async () => {
    // Seed two library Stage blocks the placements will reference.
    const seedStage = (id, attrs) => {
      store.set(`BLOCK#SYSTEM#STAGE#${id}|V#latest`, {
        pk: `BLOCK#SYSTEM#STAGE#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: 'STAGE',
        blockId: id,
        ...attrs,
      });
    };
    seedStage('scope-definition', {
      produces: ['scope-document'],
      consumes: [],
      requires: [],
      blocksOn: [],
      sensors: ['linter'],
      reviewer: null,
      humanValidation: 'none',
    });
    seedStage('design', {
      produces: [],
      consumes: [{ artifact: 'scope-document', required: true }],
      requires: [],
      blocksOn: [],
      sensors: [],
      reviewer: 'aidlc-architecture-reviewer-agent',
      humanValidation: 'none',
    });

    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'mvp' } }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'scope-definition', scopeMembership: { mvp: 'EXECUTE' } },
      }),
    );
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'placements', body: { stageId: 'design' } }),
    );

    const res = parse(await handler(event({ method: 'GET', workflowId: 'wf', path: 'compiled' })));
    expect(res.status).toBe(200);
    // scope grid: scope-definition EXECUTE under mvp, design defaults to SKIP.
    expect(res.body.scopeGrid.mvp).toEqual({ 'scope-definition': 'EXECUTE', design: 'SKIP' });
    // autonomy: deterministic sensor only → self-halting; a reviewer → mixed.
    expect(res.body.autonomy.perStage['scope-definition']).toBe('self-halting');
    expect(res.body.autonomy.perStage.design).toBe('mixed');
    expect(res.body.autonomy.rollup).toEqual({ selfHalting: 1, mixed: 1, humanGated: 0, total: 2 });
    // graph: scope-document produced by scope-definition, consumed by design.
    expect(res.body.graph.edges).toContainEqual({
      from: 'scope-definition',
      to: 'design',
      artifact: 'scope-document',
      kind: 'data',
    });
    expect(res.body.graph.acyclic).toBe(true);
  });

  it('execution preview uses the runtime planner for branch sections and validation', async () => {
    const seedStage = (id, attrs = {}) => {
      store.set(`BLOCK#SYSTEM#STAGE#${id}|V#latest`, {
        pk: `BLOCK#SYSTEM#STAGE#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: 'STAGE',
        blockId: id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        supportAgents: [],
        produces: [],
        consumes: [],
        requires: [],
        blocksOn: [],
        sensors: [],
        reviewer: null,
        humanValidation: 'none',
        ...attrs,
      });
    };
    seedStage('units-gen', { produces: ['unit-of-work-dependency'] });
    seedStage('fd', {
      forEach: 'unit-of-work',
      consumes: [{ artifact: 'unit-of-work-dependency', required: true }],
    });
    seedStage('cg', { forEach: 'unit-of-work', requires: ['fd'] });

    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'feature' } }),
    );
    for (const [stageId, order] of [
      ['units-gen', 0],
      ['fd', 1],
      ['cg', 2],
    ]) {
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { stageId, order, scopeMembership: { feature: 'EXECUTE' } },
        }),
      );
    }

    const res = parse(
      await handler(
        event({
          method: 'GET',
          workflowId: 'wf',
          path: 'execution-preview',
          query: { scope: 'feature' },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.plan.sections).toEqual([{ index: 1, stageIds: ['fd', 'cg'] }]);
  });

  it('execution preview reports missing, degraded, and unsupported forEach conditions', async () => {
    const seedStage = (id, attrs = {}) => {
      store.set(`BLOCK#SYSTEM#STAGE#${id}|V#latest`, {
        pk: `BLOCK#SYSTEM#STAGE#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: 'STAGE',
        blockId: id,
        version: 1,
        phase: 'construction',
        mode: 'inline',
        leadAgent: 'orchestrator',
        supportAgents: [],
        produces: [],
        consumes: [],
        requires: [],
        blocksOn: [],
        sensors: [],
        reviewer: null,
        humanValidation: 'none',
        ...attrs,
      });
    };
    seedStage('units-gen', { produces: ['unit-of-work-dependency'] });
    seedStage('fd', { forEach: 'unit-of-work' });
    seedStage('unsupported', { forEach: 'user-story' });

    await createWorkflow({ id: 'wf', name: 'WF' });
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'feature' } }),
    );
    await handler(
      event({ method: 'POST', workflowId: 'wf', path: 'scopes', body: { scopeId: 'lean' } }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: {
          stageId: 'units-gen',
          order: 0,
          scopeMembership: { feature: 'SKIP', lean: 'SKIP' },
        },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'fd', order: 1, scopeMembership: { feature: 'EXECUTE', lean: 'EXECUTE' } },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'wf',
        path: 'placements',
        body: { stageId: 'unsupported', order: 2, scopeMembership: { feature: 'EXECUTE' } },
      }),
    );

    const degraded = parse(
      await handler(
        event({
          method: 'GET',
          workflowId: 'wf',
          path: 'execution-preview',
          query: { scope: 'lean' },
        }),
      ),
    );
    expect(degraded.body.valid).toBe(true);
    expect(degraded.body.warnings.map((w) => w.code)).toContain('scope_absent_unit_dag');
    expect(degraded.body.plan.stages.find((s) => s.stageId === 'fd').forEachDegraded).toBe(true);

    const unsupported = parse(
      await handler(
        event({
          method: 'GET',
          workflowId: 'wf',
          path: 'execution-preview',
          query: { scope: 'feature' },
        }),
      ),
    );
    expect(unsupported.body.valid).toBe(false);
    expect(unsupported.body.errors.map((e) => e.code)).toContain('unsupported_for_each');

    await createWorkflow({ id: 'missing', name: 'Missing Producer' });
    await handler(
      event({
        method: 'POST',
        workflowId: 'missing',
        path: 'placements',
        body: { stageId: 'fd', scopeMembership: { feature: 'EXECUTE' } },
      }),
    );
    const missing = parse(
      await handler(
        event({
          method: 'GET',
          workflowId: 'missing',
          path: 'execution-preview',
          query: { scope: 'feature' },
        }),
      ),
    );
    expect(missing.body.valid).toBe(false);
    expect(missing.body.errors.map((e) => e.code)).toContain('no_unit_dag_producer');
  });

  it('forks a workflow: copies phases + placements, not META identity', async () => {
    await createWorkflow({ id: 'base', name: 'Base' });
    await handler(
      event({
        method: 'PUT',
        workflowId: 'base',
        path: 'phases',
        body: { phases: [{ phaseId: 'ideation', path: '01', kind: 'phase' }] },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'base',
        path: 'placements',
        body: { stageId: 'scope-definition' },
      }),
    );

    const fork = parse(await createWorkflow({ id: 'fork', name: 'Fork', basedOn: 'base' }));
    expect(fork.status).toBe(201);
    expect(fork.body.basedOn).toBe('base');

    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'fork' })));
    expect(loaded.body.phases.map((g) => g.phaseId)).toEqual(['ideation']);
    expect(loaded.body.placements.map((p) => p.stageId)).toEqual(['scope-definition']);
  });

  it('updates and deletes a workflow', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const upd = parse(
      await handler(event({ method: 'PUT', workflowId: 'wf', body: { name: 'Renamed' } })),
    );
    expect(upd.body.name).toBe('Renamed');

    const del = await handler(event({ method: 'DELETE', workflowId: 'wf' }));
    expect(del.statusCode).toBe(204);
    expect(parse(await handler(event({ method: 'GET', workflowId: 'wf' }))).status).toBe(404);
  });

  it('404s an unknown workflow', async () => {
    expect(parse(await handler(event({ method: 'GET', workflowId: 'ghost' }))).status).toBe(404);
  });

  // SYSTEM read-only resolution: seed a raw SYSTEM workflow and confirm the
  // shared user library can read it but cannot mutate it.
  describe('SYSTEM baseline', () => {
    const seedSystem = (id, name) => {
      store.set(`WF#SYSTEM#${id}|META`, {
        pk: `WF#SYSTEM#${id}`,
        sk: 'META',
        type: 'Workflow',
        tenantId: 'SYSTEM',
        workflowId: id,
        name,
        objective: '',
        status: 'PUBLISHED',
        GSI1PK: 'TENANT#SYSTEM#WORKFLOW',
        GSI1SK: name,
      });
    };

    it('GET resolves a SYSTEM workflow the user library does not own', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      const res = parse(await handler(event({ method: 'GET', workflowId: 'aidlc-v2' })));
      expect(res.status).toBe(200);
      expect(res.body.readOnly).toBe(true);
    });

    it('refuses to mutate a SYSTEM workflow', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      // resolveTenant returns the shared user owner, so PUT targets `default`
      // and 404s — the SYSTEM copy is never touched.
      const res = parse(
        await handler(event({ method: 'PUT', workflowId: 'aidlc-v2', body: { name: 'hacked' } })),
      );
      expect(res.status).toBe(404);
      expect(store.get('WF#SYSTEM#aidlc-v2|META').name).toBe('AI-DLC v2');
    });

    it('a user fork of a SYSTEM workflow is editable', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      const fork = parse(
        await createWorkflow({ id: 'my-flow', name: 'Mine', basedOn: 'aidlc-v2' }),
      );
      expect(fork.status).toBe(201);
      expect(fork.body.readOnly).toBe(false);
    });
  });
});

// ─── Platform-admin gating (shared/authz.js) ───
// Every mutation requires the Cognito platform-admin group; reads stay open.
describe('platform-admin gating', () => {
  const nonAdminClaims = { sub: 'user-2', email: 'user2@example.com' };
  const asNonAdmin = (ev) => ({
    ...ev,
    requestContext: { authorizer: { claims: nonAdminClaims } },
  });

  it('rejects non-admin mutations with 403 (create / update / placements)', async () => {
    for (const ev of [
      event({ method: 'POST', body: { id: 'wf-x', name: 'X' } }),
      event({ method: 'PUT', workflowId: 'wf-x', body: { name: 'Y' } }),
      event({ method: 'DELETE', workflowId: 'wf-x' }),
      event({ method: 'POST', workflowId: 'wf-x', path: 'placements', body: {} }),
      event({ method: 'PUT', workflowId: 'wf-x', path: 'phases', body: { phases: [] } }),
    ]) {
      const res = parse(await handler(asNonAdmin(ev)));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLATFORM_ADMIN_REQUIRED');
    }
  });

  it('keeps reads open for non-admins (list + compiled)', async () => {
    const list = parse(await handler(asNonAdmin(event({ method: 'GET' }))));
    expect(list.status).toBe(200);
  });
});
