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

const claims = { sub: 'user-1', email: 'user@example.com' };

const event = ({ method, workflowId, skillId, body, path }) => {
  let resource = '/workflows';
  const pathParameters = {};
  if (workflowId) {
    resource = '/workflows/{workflowId}';
    pathParameters.workflowId = workflowId;
  }
  if (path === 'groupings') resource = '/workflows/{workflowId}/groupings';
  if (path === 'placements') resource = '/workflows/{workflowId}/placements';
  if (path === 'placement') {
    resource = '/workflows/{workflowId}/placements/{skillId}';
    pathParameters.skillId = skillId;
  }
  return {
    httpMethod: method,
    resource,
    pathParameters,
    body: body === undefined ? null : JSON.stringify(body),
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
    expect(res.body.groupings).toEqual([]);
    expect(res.body.placements).toEqual([]);
  });

  it('replaces the grouping tree (ordered, nestable)', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'groupings',
          body: {
            groupings: [
              { groupingId: 'ideation', path: '01', kind: 'phase' },
              { groupingId: 'requirements', path: '01.02', kind: 'stage' },
              { groupingId: 'construction', path: '02', kind: 'phase' },
            ],
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.groupings.map((g) => g.path)).toEqual(['01', '01.02', '02']);
    // Nesting is derived from the path.
    const nested = res.body.groupings.find((g) => g.path === '01.02');
    expect(nested.parentPath).toBe('01');
    expect(nested.order).toBe(2);
  });

  it('rejects a malformed grouping path', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          workflowId: 'wf',
          path: 'groupings',
          body: { groupings: [{ groupingId: 'x', path: 'nope' }] },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('adds, updates, and removes a skill placement', async () => {
    await createWorkflow({ id: 'wf', name: 'WF' });

    const added = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { skillId: 'scope-definition', groupingPath: '01', order: 4 },
        }),
      ),
    );
    expect(added.status).toBe(201);
    expect(added.body.skillId).toBe('scope-definition');
    expect(added.body.order).toBe(4);

    // Duplicate placement rejected.
    const dup = parse(
      await handler(
        event({
          method: 'POST',
          workflowId: 'wf',
          path: 'placements',
          body: { skillId: 'scope-definition' },
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
          skillId: 'scope-definition',
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
      event({ method: 'DELETE', workflowId: 'wf', skillId: 'scope-definition', path: 'placement' }),
    );
    expect(removed.statusCode).toBe(204);
    const after = parse(await handler(event({ method: 'GET', workflowId: 'wf' })));
    expect(after.body.placements).toHaveLength(0);
  });

  it('forks a workflow: copies groupings + placements, not META identity', async () => {
    await createWorkflow({ id: 'base', name: 'Base' });
    await handler(
      event({
        method: 'PUT',
        workflowId: 'base',
        path: 'groupings',
        body: { groupings: [{ groupingId: 'ideation', path: '01', kind: 'phase' }] },
      }),
    );
    await handler(
      event({
        method: 'POST',
        workflowId: 'base',
        path: 'placements',
        body: { skillId: 'scope-definition' },
      }),
    );

    const fork = parse(await createWorkflow({ id: 'fork', name: 'Fork', basedOn: 'base' }));
    expect(fork.status).toBe(201);
    expect(fork.body.basedOn).toBe('base');

    const loaded = parse(await handler(event({ method: 'GET', workflowId: 'fork' })));
    expect(loaded.body.groupings.map((g) => g.groupingId)).toEqual(['ideation']);
    expect(loaded.body.placements.map((p) => p.skillId)).toEqual(['scope-definition']);
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

  // SYSTEM read-only resolution: seed a raw SYSTEM workflow and confirm a tenant
  // can read it but cannot mutate it.
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

    it('GET resolves a SYSTEM workflow the tenant does not own', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      const res = parse(await handler(event({ method: 'GET', workflowId: 'aidlc-v2' })));
      expect(res.status).toBe(200);
      expect(res.body.readOnly).toBe(true);
    });

    it('refuses to mutate a SYSTEM workflow', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      // resolveTenant returns a non-SYSTEM tenant, so PUT targets the tenant
      // partition and 404s — the SYSTEM copy is never touched.
      const res = parse(
        await handler(event({ method: 'PUT', workflowId: 'aidlc-v2', body: { name: 'hacked' } })),
      );
      expect(res.status).toBe(404);
      expect(store.get('WF#SYSTEM#aidlc-v2|META').name).toBe('AI-DLC v2');
    });

    it('a tenant fork of a SYSTEM workflow is editable', async () => {
      seedSystem('aidlc-v2', 'AI-DLC v2');
      const fork = parse(
        await createWorkflow({ id: 'my-flow', name: 'Mine', basedOn: 'aidlc-v2' }),
      );
      expect(fork.status).toBe(201);
      expect(fork.body.readOnly).toBe(false);
    });
  });
});
