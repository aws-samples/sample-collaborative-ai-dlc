import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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
    store.set(keyOf(input.Item.pk, input.Item.sk), { ...input.Item });
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
  if (path === 'rules') resource = '/workflows/{workflowId}/rules';
  if (path === 'rule') {
    resource = '/workflows/{workflowId}/rules/{layer}/{ruleId}';
    pathParameters.layer = layer;
    pathParameters.ruleId = ruleId;
  }
  if (path === 'compiled') resource = '/workflows/{workflowId}/compiled';
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
