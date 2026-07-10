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
// Block authoring requires the platform-admin group, so the default test
// caller is an admin; non-admin behaviour is covered explicitly below.
const claims = { sub: 'user-1', email: 'user@example.com', 'cognito:groups': 'platform-admin' };

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
  if (id && sub === 'scriptPath') {
    resource = '/blocks/{type}/{id}/script';
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
          type: 'agent',
          body: { id: 'architect', name: 'Architect', displayName: 'Architect Agent' },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('architect');
    expect(res.body.version).toBe(1);
    expect(res.body.displayName).toBe('Architect Agent');
    // Both the mutable pointer and the immutable first snapshot exist.
    expect(tableStore.has('BLOCK#default#AGENT#architect|V#latest')).toBe(true);
    expect(tableStore.has('BLOCK#default#AGENT#architect|V#1')).toBe(true);
  });

  it('rejects a duplicate id with 409', async () => {
    const make = () =>
      handler(event({ method: 'POST', type: 'agent', body: { id: 'dup', name: 'Dup' } }));
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

  it('enforces sensor fields (deterministic-only; command required)', async () => {
    // No command → 400 (a sensor is an executable check).
    const noCmd = parse(
      await handler(
        event({ method: 'POST', type: 'sensor', body: { id: 'linter', name: 'Linter' } }),
      ),
    );
    expect(noCmd.status).toBe(400);

    // Command present → 201 (mode defaults to deterministic).
    const ok = parse(
      await handler(
        event({
          method: 'POST',
          type: 'sensor',
          body: {
            id: 'linter',
            name: 'Linter',
            command: 'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
          },
        }),
      ),
    );
    expect(ok.status).toBe(201);

    // llm-judged is retired — sensors are deterministic-only; the LLM-judged
    // half of verification is a stage `reviewer`, not a sensor. → 400.
    const llm = parse(
      await handler(
        event({
          method: 'POST',
          type: 'sensor',
          body: { id: 'coherent', name: 'Coherent', mode: 'llm-judged', command: 'x' },
        }),
      ),
    );
    expect(llm.status).toBe(400);
  });

  it('validates the stage reviewer fields (reviewer string; positive max iterations)', async () => {
    // A non-integer reviewerMaxIterations → 400.
    const badIters = parse(
      await handler(
        event({
          method: 'POST',
          type: 'stage',
          body: {
            id: 'design',
            name: 'Design',
            reviewer: 'aidlc-product-lead-agent',
            reviewerMaxIterations: 0,
          },
        }),
      ),
    );
    expect(badIters.status).toBe(400);

    // A valid reviewer binding → 201.
    const ok = parse(
      await handler(
        event({
          method: 'POST',
          type: 'stage',
          body: {
            id: 'design',
            name: 'Design',
            reviewer: 'aidlc-architecture-reviewer-agent',
            reviewerMaxIterations: 2,
          },
        }),
      ),
    );
    expect(ok.status).toBe(201);
  });

  it('validates the plugin-era stage fields (number, when, requiredSections, producesKinds)', async () => {
    const post = (body) =>
      handler(event({ method: 'POST', type: 'stage', body })).then((r) => parse(r));

    // Display-only number must be "<int>.<int>".
    expect((await post({ id: 's-a', name: 'A', number: 'x.y' })).status).toBe(400);
    // `when` must carry exactly one known predicate with an artifact value.
    expect((await post({ id: 's-b', name: 'B', when: { nonsense: 'x' } })).status).toBe(400);
    // requiredSections must be non-empty strings.
    expect((await post({ id: 's-c', name: 'C', requiredSections: [''] })).status).toBe(400);
    // producesKinds: orphan key (not in produces/optionalProduces) → 400.
    expect(
      (
        await post({
          id: 's-d',
          name: 'D',
          produces: ['model'],
          producesKinds: { ghost: ['service'] },
        })
      ).status,
    ).toBe(400);
    // producesKinds: unknown kind value → 400.
    expect(
      (
        await post({
          id: 's-e',
          name: 'E',
          produces: ['model'],
          producesKinds: { model: ['microservice'] },
        })
      ).status,
    ).toBe(400);

    // A fully valid plugin-era stage → 201.
    const ok = await post({
      id: 's-ok',
      name: 'OK',
      number: '3.85',
      bundle: 'test-pro',
      when: { 'producer-in-plan': 'unit-of-work-dependency' },
      produces: ['model'],
      optionalProduces: ['ui-notes'],
      producesKinds: { model: ['service'], 'ui-notes': ['ui'] },
      requiredSections: ['Model'],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.producesKinds).toEqual({ model: ['service'], 'ui-notes': ['ui'] });
  });

  it('validates the agent tier against the tier enum', async () => {
    const bad = parse(
      await handler(
        event({
          method: 'POST',
          type: 'agent',
          body: { id: 'a-bad', name: 'Bad', tier: 'genius' },
        }),
      ),
    );
    expect(bad.status).toBe(400);
    const ok = parse(
      await handler(
        event({
          method: 'POST',
          type: 'agent',
          body: { id: 'a-ok', name: 'OK', tier: 'judgment' },
        }),
      ),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.tier).toBe('judgment');
  });

  it('validates scope depth and testStrategy against the depth enum', async () => {
    const badDepth = parse(
      await handler(
        event({ method: 'POST', type: 'scope', body: { id: 'x', name: 'X', depth: 'Deep' } }),
      ),
    );
    expect(badDepth.status).toBe(400);

    const ok = parse(
      await handler(
        event({
          method: 'POST',
          type: 'scope',
          body: { id: 'wkshop', name: 'Workshop', depth: 'Standard', testStrategy: 'Minimal' },
        }),
      ),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.testStrategy).toBe('Minimal');
  });

  it('validates knowledge tier and persists agentRef', async () => {
    const badTier = parse(
      await handler(
        event({
          method: 'POST',
          type: 'knowledge',
          body: { id: 'k1', name: 'K', tier: 'bogus' },
        }),
      ),
    );
    expect(badTier.status).toBe(400);

    const ok = parse(
      await handler(
        event({
          method: 'POST',
          type: 'knowledge',
          body: { id: 'k1', name: 'K', tier: 'methodology', agentRef: 'aidlc-product-agent' },
        }),
      ),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.tier).toBe('methodology');
    expect(ok.body.agentRef).toBe('aidlc-product-agent');
  });

  it('creates an artifact block', async () => {
    const res = parse(
      await handler(
        event({
          method: 'POST',
          type: 'artifact',
          body: { id: 'intent-statement', name: 'Intent Statement', terminal: false },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('intent-statement');
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

  it('lists user-owned blocks via GSI1', async () => {
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

  it('round-trips a sensor script through S3 (scriptRef, separate from body)', async () => {
    const created = parse(
      await handler(
        event({
          method: 'POST',
          type: 'sensor',
          body: {
            id: 'linter',
            name: 'Linter',
            command: 'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
            body: '# linter manifest',
            script: '// linter check script',
          },
        }),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body.hasScript).toBe(true);
    expect(created.body.scriptBytes).toBeGreaterThan(0);
    // The script resolves via the /script route, the manifest via /body.
    const script = parse(
      await handler(event({ method: 'GET', type: 'sensor', id: 'linter', sub: 'scriptPath' })),
    );
    expect(script.status).toBe(200);
    expect(script.body.script).toBe('// linter check script');
    const body = parse(
      await handler(event({ method: 'GET', type: 'sensor', id: 'linter', sub: 'bodyPath' })),
    );
    expect(body.body.body).toBe('# linter manifest');
  });

  it('preserves an existing script when an update omits it', async () => {
    await handler(
      event({
        method: 'POST',
        type: 'sensor',
        body: {
          id: 'linter',
          name: 'Linter',
          command: 'bun x.ts',
          script: '// v1 script',
        },
      }),
    );
    // Update touches only the name — the script pointer must carry forward.
    await handler(
      event({
        method: 'PUT',
        type: 'sensor',
        id: 'linter',
        body: { name: 'Linter v2', command: 'bun x.ts' },
      }),
    );
    const script = parse(
      await handler(event({ method: 'GET', type: 'sensor', id: 'linter', sub: 'scriptPath' })),
    );
    expect(script.body.script).toBe('// v1 script');
  });

  it('returns an empty script for a block with none', async () => {
    await handler(event({ method: 'POST', type: 'knowledge', body: { id: 'k1', name: 'K1' } }));
    const res = parse(
      await handler(event({ method: 'GET', type: 'knowledge', id: 'k1', sub: 'scriptPath' })),
    );
    expect(res.status).toBe(200);
    expect(res.body.script).toBe('');
  });

  it('creates a SKILL block with its invocation contract', async () => {
    const res = parse(
      await handler(
        event({
          method: 'POST',
          type: 'skill',
          body: {
            id: 'aidlc-replay',
            name: 'Replay',
            userInvocable: true,
            classification: 'read-only',
            body: '# Replay',
          },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.userInvocable).toBe(true);
    expect(res.body.classification).toBe('read-only');
    expect(tableStore.has('BLOCK#default#SKILL#aidlc-replay|V#1')).toBe(true);
  });

  it('rejects a SKILL with a non-boolean userInvocable', async () => {
    const res = parse(
      await handler(
        event({
          method: 'POST',
          type: 'skill',
          body: { id: 'bad', name: 'Bad', userInvocable: 'yes' },
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userInvocable/);
  });

  it('creates a TEMPLATE block', async () => {
    const res = parse(
      await handler(
        event({
          method: 'POST',
          type: 'template',
          body: { id: 'onboarding', name: 'Onboarding', body: '{{SLOT:title}}' },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(tableStore.has('BLOCK#default#TEMPLATE#onboarding|V#1')).toBe(true);
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

  // Regression: the shared user library reads SYSTEM baseline blocks (e.g. the
  // seeded `mvp` scope) it does not own. The read paths must fall back to SYSTEM;
  // writes must not. Seed a raw SYSTEM item the way the seed lambda would.
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

    it('GET resolves a SYSTEM block the user library does not own', async () => {
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

    it('a user fork shadows the SYSTEM baseline of the same id', async () => {
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

// ─── Platform-admin gating (shared/authz.js) ───
// Every mutation requires the Cognito platform-admin group; reads stay open.
describe('platform-admin gating', () => {
  const nonAdminClaims = { sub: 'user-2', email: 'user2@example.com' };
  const asNonAdmin = (ev) => ({
    ...ev,
    requestContext: { authorizer: { claims: nonAdminClaims } },
  });

  it('rejects non-admin mutations with 403 (create / update / delete)', async () => {
    for (const ev of [
      event({ method: 'POST', type: 'scope', body: { id: 'x', name: 'X' } }),
      event({ method: 'PUT', type: 'scope', id: 'x', body: { name: 'Y' } }),
      event({ method: 'DELETE', type: 'scope', id: 'x' }),
    ]) {
      const res = parse(await handler(asNonAdmin(ev)));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PLATFORM_ADMIN_REQUIRED');
    }
  });

  it('keeps reads open for non-admins', async () => {
    const res = parse(await handler(asNonAdmin(event({ method: 'GET', type: 'scope' }))));
    expect(res.status).toBe(200);
  });
});
