import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// ─── In-memory fakes ───
//
// The blocks table is a plain key-value store keyed by `pk|sk`, with GSI1
// queries served by scanning for a matching GSI1PK. S3 is a content-addressed
// map keyed by object Key. Together they let the handler's CRUD + versioning +
// body round-trip be tested without real AWS.
const tableStore = new Map();
const s3Store = new Map();

const keyOf = (pk, sk) => `${pk}|${sk}`;

const installFakes = () => {
  ddbMock.reset();
  s3Mock.reset();
  tableStore.clear();
  s3Store.clear();

  ddbMock.on(GetCommand).callsFake((input) => {
    const item = tableStore.get(keyOf(input.Key.pk, input.Key.sk));
    return { Item: item ? { ...item } : undefined };
  });

  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    let items = [...tableStore.values()];
    if (input.IndexName === 'GSI1') {
      items = items.filter((i) => i.GSI1PK === values[':pk']);
    } else {
      items = items.filter((i) => i.pk === values[':pk']);
    }
    return { Items: items.map((i) => ({ ...i })) };
  });

  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    for (const [table, requests] of Object.entries(input.RequestItems)) {
      if (table !== BLOCKS_TABLE) continue;
      for (const req of requests) {
        const item = req.PutRequest.Item;
        tableStore.set(keyOf(item.pk, item.sk), { ...item });
      }
    }
    return {};
  });

  ddbMock.on(DeleteCommand).callsFake((input) => {
    tableStore.delete(keyOf(input.Key.pk, input.Key.sk));
    return {};
  });

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    s3Store.set(input.Key, input.Body);
    return {};
  });

  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const body = s3Store.get(input.Key);
    return { Body: { transformToString: async () => body } };
  });
};

// ─── Event builders ───
const claims = { sub: 'user-1', email: 'user@example.com' };

const event = ({ method, type, id, body, sub = 'body' }) => {
  let resource = '/blocks/{type}';
  const pathParameters = { type };
  if (id) {
    resource = '/blocks/{type}/{id}';
    pathParameters.id = id;
  }
  if (id && sub === 'bodyPath') {
    resource = '/blocks/{type}/{id}/body';
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

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  installFakes();
});

const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });

describe('building-blocks handler', () => {
  it('returns 200 with empty body on OPTIONS', async () => {
    const res = await handler({ httpMethod: 'OPTIONS', headers: {} });
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown block type', async () => {
    const res = parse(await handler(event({ method: 'GET', type: 'widgets' })));
    expect(res.status).toBe(404);
  });

  it('creates a block, writing V#latest and V#1', async () => {
    const res = parse(
      await handler(
        event({
          method: 'POST',
          type: 'grouping',
          body: { id: 'ideation', name: 'Ideation', kind: 'phase' },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('ideation');
    expect(res.body.version).toBe(1);
    expect(res.body.kind).toBe('phase');
    // Both the mutable pointer and the immutable first snapshot exist.
    expect(tableStore.has('BLOCK#default#GROUPING#ideation|V#latest')).toBe(true);
    expect(tableStore.has('BLOCK#default#GROUPING#ideation|V#1')).toBe(true);
  });

  it('rejects a duplicate id with 409', async () => {
    const make = () =>
      handler(event({ method: 'POST', type: 'grouping', body: { id: 'dup', name: 'Dup' } }));
    await make();
    const res = parse(await make());
    expect(res.status).toBe(409);
  });

  it('validates the id (kebab-case) and required name', async () => {
    const badId = parse(
      await handler(event({ method: 'POST', type: 'scope', body: { id: 'Not Kebab', name: 'X' } })),
    );
    expect(badId.status).toBe(400);

    const noName = parse(
      await handler(event({ method: 'POST', type: 'scope', body: { id: 'mvp' } })),
    );
    expect(noName.status).toBe(400);
  });

  it('400s on malformed JSON', async () => {
    const res = parse(
      await handler({
        httpMethod: 'POST',
        resource: '/blocks/{type}',
        pathParameters: { type: 'scope' },
        body: '{not json',
        requestContext: { authorizer: { claims } },
        headers: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it('lists tenant blocks via GSI1', async () => {
    await handler(
      event({ method: 'POST', type: 'agent', body: { id: 'arch', name: 'Architect' } }),
    );
    await handler(event({ method: 'POST', type: 'agent', body: { id: 'dev', name: 'Developer' } }));
    const res = parse(await handler(event({ method: 'GET', type: 'agent' })));
    expect(res.status).toBe(200);
    expect(res.body.blocks).toHaveLength(2);
    expect(res.body.blocks.map((b) => b.id).toSorted()).toEqual(['arch', 'dev']);
  });

  it('gets a single block (metadata only, no body)', async () => {
    await handler(
      event({ method: 'POST', type: 'scope', body: { id: 'mvp', name: 'MVP', body: '# why mvp' } }),
    );
    const res = parse(await handler(event({ method: 'GET', type: 'scope', id: 'mvp' })));
    expect(res.status).toBe(200);
    expect(res.body.hasBody).toBe(true);
    expect(res.body.body).toBeUndefined();
  });

  it('round-trips a body through S3', async () => {
    await handler(
      event({
        method: 'POST',
        type: 'knowledge',
        body: { id: 'scoping', name: 'Scoping', body: '# Scoping guide' },
      }),
    );
    const res = parse(
      await handler(event({ method: 'GET', type: 'knowledge', id: 'scoping', sub: 'bodyPath' })),
    );
    expect(res.status).toBe(200);
    expect(res.body.body).toBe('# Scoping guide');
  });

  it('bumps the version on update and writes a new immutable snapshot', async () => {
    await handler(event({ method: 'POST', type: 'scope', body: { id: 'mvp', name: 'MVP' } }));
    const res = parse(
      await handler(event({ method: 'PUT', type: 'scope', id: 'mvp', body: { name: 'MVP v2' } })),
    );
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.name).toBe('MVP v2');
    expect(tableStore.has('BLOCK#default#SCOPE#mvp|V#2')).toBe(true);
    // V#latest reflects the new version.
    expect(tableStore.get('BLOCK#default#SCOPE#mvp|V#latest').version).toBe(2);
  });

  it('404s an update for a missing block', async () => {
    const res = parse(
      await handler(event({ method: 'PUT', type: 'scope', id: 'ghost', body: { name: 'X' } })),
    );
    expect(res.status).toBe(404);
  });

  it('deletes every version in the partition', async () => {
    await handler(event({ method: 'POST', type: 'scope', body: { id: 'tmp', name: 'Tmp' } }));
    await handler(event({ method: 'PUT', type: 'scope', id: 'tmp', body: { name: 'Tmp2' } }));
    const res = await handler(event({ method: 'DELETE', type: 'scope', id: 'tmp' }));
    expect(res.statusCode).toBe(204);
    expect([...tableStore.keys()].filter((k) => k.includes('SCOPE#tmp'))).toHaveLength(0);
  });

  // Regression: a tenant reads SYSTEM baseline blocks (e.g. the seeded `mvp`
  // scope) it does not own. The read paths must fall back to SYSTEM; writes
  // must not. Seed a raw SYSTEM item the way the seed lambda would.
  describe('SYSTEM baseline resolution', () => {
    const seedSystem = (type, id, attrs = {}, body) => {
      const TYPE = type.toUpperCase();
      const item = {
        pk: `BLOCK#SYSTEM#${TYPE}#${id}`,
        sk: 'V#latest',
        tenantId: 'SYSTEM',
        blockType: TYPE,
        blockId: id,
        name: attrs.name ?? id,
        version: 1,
        bodyRef: body
          ? { s3Key: `blocks/bodies/sha256/${id}`, sha256: id, bytes: body.length }
          : null,
        GSI1PK: `TENANT#SYSTEM#${TYPE}`,
        GSI1SK: attrs.name ?? id,
        ...attrs,
      };
      tableStore.set(`${item.pk}|V#latest`, item);
      if (body) s3Store.set(item.bodyRef.s3Key, body);
    };

    it('GET resolves a SYSTEM block the tenant does not own', async () => {
      seedSystem('scope', 'mvp', { name: 'MVP' });
      const res = parse(await handler(event({ method: 'GET', type: 'scope', id: 'mvp' })));
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('mvp');
      expect(res.body.readOnly).toBe(true);
    });

    it('GET body resolves a SYSTEM block body', async () => {
      seedSystem('knowledge', 'scoping', { name: 'Scoping' }, '# Scoping guide');
      const res = parse(
        await handler(event({ method: 'GET', type: 'knowledge', id: 'scoping', sub: 'bodyPath' })),
      );
      expect(res.status).toBe(200);
      expect(res.body.body).toBe('# Scoping guide');
    });

    it('a tenant clone shadows the SYSTEM baseline of the same id', async () => {
      seedSystem('scope', 'mvp', { name: 'MVP (system)' });
      await handler(
        event({ method: 'POST', type: 'scope', body: { id: 'mvp', name: 'MVP (mine)' } }),
      );
      const res = parse(await handler(event({ method: 'GET', type: 'scope', id: 'mvp' })));
      expect(res.body.name).toBe('MVP (mine)');
      expect(res.body.readOnly).toBe(false);
    });
  });
});
