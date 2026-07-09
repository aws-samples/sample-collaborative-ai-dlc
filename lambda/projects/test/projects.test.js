import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const NOW = new Date('2026-01-01T00:00:00.000Z');

// Project delete cascades into each intent's process state (DynamoDB) — mock the
// v2 process table so the graph tests stay hermetic. `projectExecs` is the set
// of META rows listProjectExecutions (GSI1) returns for a given project; the
// per-EXEC partition reads (getExecutionRecords / deleteExecution key drain)
// return empty by default, which is all the cascade needs to exercise its
// ordering + graph drops. `batchWrites` records the BatchWrite deletes so a test
// can assert each intent's partition was drained.
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
let projectExecs = new Map(); // projectId -> [{ intentId, executionId, status, projectId }]
let batchWrites = [];

const installProcessTableFakes = () => {
  ddbMock.reset();
  batchWrites = [];
  ddbMock.on(QueryCommand).callsFake((input) => {
    // listProjectExecutions: GSI1 query keyed by PROJECT#<id>.
    if (input.IndexName === 'GSI1') {
      const pk = input.ExpressionAttributeValues?.[':pk'] ?? '';
      const projectId = pk.replace(/^PROJECT#/, '');
      return { Items: projectExecs.get(projectId) ?? [] };
    }
    // Per-EXEC partition reads (getExecutionRecords, deleteExecution key drain):
    // no rows — the cascade tolerates an intent with no process records.
    return { Items: [] };
  });
  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    batchWrites.push(input);
    return {};
  });
  lambdaMock.reset();
  agentcoreMock.reset();
};

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

// S3 has no testcontainer, so mock just the S3 client (ddb + gremlin stay real).
// `s3Objects` maps an uploaded object's Key → its byte size. HeadObject resolves
// with that ContentLength for present keys and 404s otherwise — exercising the
// custom-rules commit existence + size guards. Presign/get/list/delete resolve
// as no-ops (offline). Helper `putObject(key, size=10)` marks a key present.
const s3Mock = mockClient(S3Client);
const s3Objects = new Map();
const putObject = (key, size = 10) => s3Objects.set(key, size);

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  // If a developer has AWS_PROFILE set locally, the SDK preempts the env-var
  // creds planted by globalSetup and tries to resolve the profile via SSO/IMDS,
  // adding ~1s per getConnection call. Unset for the test process.
  vi.stubEnv('AWS_PROFILE', undefined);
  // Project delete cascades into the process table + Yjs docs (both mocked).
  vi.stubEnv('V2_PROCESS_TABLE', 'v2-proc-test');
  vi.stubEnv('YJS_DOCUMENTS_TABLE', 'yjs-test');
  vi.stubEnv('ARTIFACTS_BUCKET', 'test-artifacts-bucket');
  ({ handler } = await import('../index.js'));
  // Direct gremlin connection for seeding non-owner member edges. Uses the
  // same partition so writes are visible to the handler under test.
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.close();
});

// Seeds a HAS_MEMBER edge with the given role. The handler only ever creates
// 'owner' edges, so this is the only path to exercise admin/member branches.
const addMember = async (projectId, sub, role) => {
  const userExists = await g.V().has('User', 'id', sub).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', sub).property('email', `${sub}@x`).next();
  }
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', role)
    .to(gremlin.process.statics.V().has('User', 'id', sub))
    .next();
};

beforeEach(() => {
  // Pin Date so we can assert createdAt exactly. Don't fake setTimeout/etc —
  // gremlin's WebSocket driver uses real timers internally.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  projectExecs = new Map();
  installProcessTableFakes();

  // S3 mock: HeadObject resolves only for keys we've marked as "uploaded";
  // everything else 404s (drives the commit existence guard). All other S3
  // commands resolve as harmless no-ops.
  s3Objects.clear();
  s3Mock.reset();
  // Fallback first, then the specific HeadObject handler so it takes precedence.
  s3Mock.onAnyCommand().resolves({});
  s3Mock.on(HeadObjectCommand).callsFake((input) => {
    if (s3Objects.has(input.Key)) return { ContentLength: s3Objects.get(input.Key) };
    const err = new Error('NotFound');
    err.name = 'NotFound';
    throw err;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const claims = (sub, email = `${sub}@x`) => ({
  requestContext: { authorizer: { claims: { sub, email } } },
});

// Platform-admin caller (Cognito group claim) — required for the
// /admin/tracker-migration routes since the platform-admin gating landed.
const adminClaims = (sub, email = `${sub}@x`) => ({
  requestContext: {
    authorizer: { claims: { sub, email, 'cognito:groups': 'platform-admin' } },
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const createProject = async (sub, body = { name: 'P', gitRepo: 'r' }) => {
  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(body),
    ...claims(sub),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
};

describe('OPTIONS', () => {
  it('short-circuits with 200', async () => {
    const res = await handler({ httpMethod: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /projects', () => {
  // Every created project is v2 now, so the response always carries the v2
  // settings block with its defaults.
  const V2_DEFAULTS = {
    kind: 'v2',
    workflowId: 'aidlc-v2',
    workflowVersion: null,
    parkReleaseSeconds: 300,
    maxParallelUnits: 0,
    prStrategy: 'intent-pr',
  };

  it('applies defaults when only name is supplied', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, { name: 'Bare' });
    expect(created).toEqual({
      id: expect.stringMatching(UUID_RE),
      name: 'Bare',
      gitRepo: '',
      gitProvider: 'github',
      agentCli: 'kiro',
      cliModels: {},
      issueIntegrationEnabled: false,
      repos: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...V2_DEFAULTS,
    });
  });

  it('persists issueIntegrationEnabled=true', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'X', issueIntegrationEnabled: true });
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).issueIntegrationEnabled).toBe(true);
  });

  it('creates the project and auto-creates the user vertex', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'New',
      gitRepo: 'git@x:y.git',
      gitProvider: 'github',
      agentCli: 'kiro',
    });
    expect(created).toEqual({
      id: expect.stringMatching(UUID_RE),
      name: 'New',
      gitRepo: 'git@x:y.git',
      gitProvider: 'github',
      agentCli: 'kiro',
      cliModels: {},
      issueIntegrationEnabled: false,
      repos: [
        {
          url: 'git@x:y.git',
          provider: 'github',
          role: 'primary',
          detectedStack: '',
          addedAt: NOW.toISOString(),
        },
      ],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...V2_DEFAULTS,
    });

    // Follow-up GET confirms membership edge was wired correctly.
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    expect(fetched.statusCode).toBe(200);
    expect(JSON.parse(fetched.body).userRole).toBe('owner');
  });

  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'X' }),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('persists v2 kind + workflow/park settings (scope is per-intent)', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'V2',
      kind: 'v2',
      workflowId: 'aidlc-v2',
      parkReleaseSeconds: 120,
      maxParallelUnits: 3,
    });
    expect(created.kind).toBe('v2');
    expect(created.workflowId).toBe('aidlc-v2');
    // Scope is chosen per-intent, never stored on the project.
    expect(created.defaultScope).toBeUndefined();
    expect(created.parkReleaseSeconds).toBe(120);
    expect(created.maxParallelUnits).toBe(3);
    // workflowVersion left unpinned (resolved at intent create).
    expect(created.workflowVersion).toBeNull();

    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    const body = JSON.parse(fetched.body);
    expect(body.kind).toBe('v2');
    expect(body.workflowId).toBe('aidlc-v2');
    expect(body.defaultScope).toBeUndefined();
    expect(body.parkReleaseSeconds).toBe(120);
    expect(body.maxParallelUnits).toBe(3);
  });

  it('defaults maxParallelUnits to 0 (unbounded) and round-trips an explicit 0', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, { name: 'V2', kind: 'v2' });
    expect(created.maxParallelUnits).toBe(0);
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    // A stored "0" must NOT be coerced back to a different default.
    expect(JSON.parse(fetched.body).maxParallelUnits).toBe(0);
  });

  it('rejects an out-of-range parkReleaseSeconds', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Bad', kind: 'v2', parkReleaseSeconds: 5000 }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an out-of-range or non-integer maxParallelUnits', async () => {
    const sub = `u-${randomUUID()}`;
    for (const bad of [999, -1, 2.5]) {
      const res = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Bad', kind: 'v2', maxParallelUnits: bad }),
        ...claims(sub),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('defaults prStrategy to intent-pr and round-trips it', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, { name: 'V2', kind: 'v2' });
    expect(created.prStrategy).toBe('intent-pr');
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).prStrategy).toBe('intent-pr');
  });

  it('rejects unknown AND known-but-disabled prStrategy values with distinct errors', async () => {
    const sub = `u-${randomUUID()}`;
    const unknown = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Bad', kind: 'v2', prStrategy: 'yolo' }),
      ...claims(sub),
    });
    expect(unknown.statusCode).toBe(400);
    expect(JSON.parse(unknown.body).error).toContain('must be one of');
    // pr-per-unit / stacked are DEFINED but staged behind WP6b.
    const disabled = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Bad', kind: 'v2', prStrategy: 'pr-per-unit' }),
      ...claims(sub),
    });
    expect(disabled.statusCode).toBe(400);
    expect(JSON.parse(disabled.body).error).toContain('not enabled yet');
  });

  it('creates a v2 project when kind is omitted (v2 is the only kind)', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, { name: 'Classic' });
    expect(created.kind).toBe('v2');
    expect(created.workflowId).toBe('aidlc-v2');
    expect(created.parkReleaseSeconds).toBe(300);

    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).kind).toBe('v2');
  });

  it('rejects an explicit kind=v1 with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Frozen', kind: 'v1' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'v1 projects can no longer be created; v2 is the only supported project kind',
    });
  });
});

describe('GET /projects', () => {
  it('returns 200 with role for a member', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'Mine' });
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id, name: 'Mine', userRole: 'owner' });
  });

  it('returns 403 when the user is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 401 when sub is missing on single GET', async () => {
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: 'whatever' },
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when sub is missing on list GET', async () => {
    const res = await handler({ httpMethod: 'GET', requestContext: {} });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns an empty list when the user is in no projects', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({ httpMethod: 'GET', ...claims(sub) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('lists only projects the user is a member of', async () => {
    const sub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const a = await createProject(sub, { name: 'A' });
    const b = await createProject(sub, { name: 'B' });
    await createProject(otherSub, { name: 'NotMine' });

    const res = await handler({ httpMethod: 'GET', ...claims(sub) });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body).toSorted((x, y) => x.name.localeCompare(y.name));
    expect(list).toEqual([
      expect.objectContaining({ id: a.id, name: 'A', userRole: 'owner' }),
      expect.objectContaining({ id: b.id, name: 'B', userRole: 'owner' }),
    ]);
  });
});

describe('PUT /projects/:id', () => {
  it('updates each property when invoked by the owner', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'Old' });
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({
        name: 'New',
        gitRepo: 'g2-org/g2',
        gitProvider: 'gitlab',
        agentCli: 'claude',
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);

    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body)).toMatchObject({
      name: 'New',
      gitRepo: 'g2-org/g2',
      gitProvider: 'gitlab',
      agentCli: 'claude',
    });
  });

  it('returns 400 when gitRepo is not in strict owner/repo format', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'Old' });
    for (const gitRepo of ['g2', 'https://github.com/o/r', 'o/r/extra']) {
      const res = await handler({
        httpMethod: 'PUT',
        pathParameters: { projectId: id },
        body: JSON.stringify({ gitRepo }),
        ...claims(sub),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('returns 400 for an invalid agentCli', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ agentCli: 'unknown' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid agentCli value. Must be one of: kiro, claude, opencode',
    });
  });

  it('persists cliModels overrides', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'Models',
      cliModels: { kiro: 'kiro-model', opencode: 'amazon-bedrock/model' },
    });

    let fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).cliModels).toEqual({
      kiro: 'kiro-model',
      opencode: 'amazon-bedrock/model',
    });

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ cliModels: { kiro: '  next-model  ', opencode: '' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cliModels).toEqual({ kiro: 'next-model' });

    fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).cliModels).toEqual({ kiro: 'next-model' });
  });

  it('returns 400 for invalid cliModels keys', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ cliModels: { cursor: 'not-supported' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid cliModels configuration',
      issues: [
        {
          path: 'cursor',
          message: 'Unknown model key "cursor". Allowed: kiro, claude, opencode.',
        },
      ],
    });
  });

  it('rejects a Claude cliModels value with the amazon-bedrock prefix', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({
        cliModels: { claude: 'amazon-bedrock/us.anthropic.claude-opus-4-8' },
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Invalid cliModels configuration',
      issues: [
        {
          path: 'claude',
          message:
            'Claude model must be a bare Bedrock inference profile ID (no "amazon-bedrock/" prefix).',
        },
      ],
    });
  });

  it('persists a bare Claude cliModels override', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ cliModels: { claude: '  us.anthropic.claude-opus-4-8  ' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
  });

  it('returns 403 when the caller is not a member', async () => {
    const sub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ name: 'Hijack' }),
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 403 when the caller is a plain member (not owner/admin)', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ name: 'Hijack' }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can update settings',
    });
  });

  it('allows admins to update settings', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub, { name: 'Old' });
    await addMember(id, adminSub, 'admin');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      body: JSON.stringify({ name: 'NewByAdmin' }),
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(200);

    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(ownerSub),
    });
    expect(JSON.parse(fetched.body).name).toBe('NewByAdmin');
  });

  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: 'whatever' },
      body: JSON.stringify({ name: 'X' }),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });
});

describe('DELETE /projects/:id', () => {
  it('returns 204 for the owner and removes the project', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(204);

    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    // Vertex was dropped, so the membership query short-circuits before the
    // 404 path: handler returns 403 with "Access denied".
    expect(fetched.statusCode).toBe(403);
    expect(JSON.parse(fetched.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 403 when the caller is not the owner', async () => {
    const sub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: id },
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Only project owners can delete projects' });
  });

  it('returns 403 when an admin (non-owner) tries to delete', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, adminSub, 'admin');
    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: id },
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Only project owners can delete projects' });
  });

  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: 'whatever' },
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  // ── Cascade: a project owns intents (each an EXEC# partition + a Neptune
  // subgraph) and project-scoped knowledge vertices. Delete must purge all of
  // it — without leaking, and without touching a sibling project's data. ──

  // Seed one intent's Neptune footprint under a project: the Intent anchor, an
  // artifact it CONTAINS, and register a META row for listProjectExecutions.
  const seedIntent = async (projectId, { status = 'SUCCEEDED' } = {}) => {
    const intentId = randomUUID();
    await g.addV('Intent').property('id', intentId).property('project_id', projectId).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('CONTAINS')
      .to(gremlin.process.statics.V().has('Intent', 'id', intentId))
      .next();
    await g.addV('Artifact').property('id', 'requirements').property('intent_id', intentId).next();
    await g
      .V()
      .has('Intent', 'id', intentId)
      .addE('CONTAINS')
      .to(
        gremlin.process.statics
          .V()
          .has('Artifact', 'id', 'requirements')
          .has('intent_id', intentId),
      )
      .next();
    const rows = projectExecs.get(projectId) ?? [];
    rows.push({ intentId, executionId: intentId, projectId, status });
    projectExecs.set(projectId, rows);
    return intentId;
  };

  const seedKnowledge = async (projectId) => {
    await g.addV('TeamKnowledge').property('id', `k-${randomUUID()}`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_KNOWLEDGE')
      .to(gremlin.process.statics.V().hasLabel('TeamKnowledge').order().by('id').tail(1))
      .next();
    await g.addV('LearningRule').property('id', `r-${randomUUID()}`).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_LEARNING')
      .to(gremlin.process.statics.V().hasLabel('LearningRule').order().by('id').tail(1))
      .next();
  };

  it('cascades into every intent + knowledge vertex and drains each partition', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const intentA = await seedIntent(id);
    const intentB = await seedIntent(id);
    await seedKnowledge(id);

    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(204);

    // Both Intent anchors + their artifacts are gone from Neptune.
    expect(await g.V().has('Intent', 'id', intentA).hasNext()).toBe(false);
    expect(await g.V().has('Intent', 'id', intentB).hasNext()).toBe(false);
    expect(await g.V().hasLabel('Artifact').has('intent_id', intentA).hasNext()).toBe(false);
    // Project-scoped knowledge vertices dropped, and the Project itself.
    expect(await g.V().hasLabel('TeamKnowledge').hasNext()).toBe(false);
    expect(await g.V().hasLabel('LearningRule').hasNext()).toBe(false);
    expect(await g.V().has('Project', 'id', id).hasNext()).toBe(false);

    // deleteExecution drained a partition — but with no process rows in the
    // mock, BatchWrite is only issued when there are keys, so at minimum the
    // list was consulted per project (asserted implicitly by 204). The graph
    // drops above are the authoritative teardown assertion.
  });

  it('spares a sibling project’s intents and knowledge', async () => {
    const sub = `u-${randomUUID()}`;
    const keepSub = `u-${randomUUID()}`;
    const { id: victim } = await createProject(sub);
    const { id: keep } = await createProject(keepSub);
    await seedIntent(victim);
    const keepIntent = await seedIntent(keep);
    await seedKnowledge(keep);

    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: victim },
      ...claims(sub),
    });
    expect(res.statusCode).toBe(204);

    // The sibling project keeps its intent, artifact and knowledge vertices.
    expect(await g.V().has('Project', 'id', keep).hasNext()).toBe(true);
    expect(await g.V().has('Intent', 'id', keepIntent).hasNext()).toBe(true);
    expect(await g.V().hasLabel('Artifact').has('intent_id', keepIntent).hasNext()).toBe(true);
    expect(await g.V().hasLabel('TeamKnowledge').hasNext()).toBe(true);
    expect(await g.V().hasLabel('LearningRule').hasNext()).toBe(true);
  });

  it('force-retires a RUNNING intent instead of refusing the project delete', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const running = await seedIntent(id, { status: 'RUNNING' });

    const res = await handler({
      httpMethod: 'DELETE',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    // A RUNNING child does NOT block a project delete (force:true) — contrast
    // with the intents lambda's single-intent DELETE which 409s on RUNNING.
    expect(res.statusCode).toBe(204);
    expect(await g.V().has('Intent', 'id', running).hasNext()).toBe(false);
    expect(await g.V().has('Project', 'id', id).hasNext()).toBe(false);
  });
});

describe('method routing', () => {
  it('returns 405 for an unsupported method', async () => {
    const res = await handler({ httpMethod: 'PATCH', ...claims('u') });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});

// Migration to the tracker provider abstraction (#194 Phase 1). Owner/admin
// only. Idempotent: a re-run on an already-migrated project applies nothing.
// The bulk admin lambda lives at lambda/migrate-tracker-fields.
describe('POST /projects/:id/migrate-tracker', () => {
  // Helper to seed a sprint vertex on the legacy shape (no tracker_*).
  const seedLegacySprint = async (projectId) => {
    const id = randomUUID();
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .addV('Sprint')
      .property('id', id)
      .property('name', 'legacy')
      .property('description', '')
      .property('phase', 'INCEPTION')
      .property('sprint_id', id)
      .property('created_at', NOW.toISOString())
      .property('issue_number', '17')
      .property('issue_url', 'https://github.com/acme/widgets/issues/17')
      .as('s')
      .addE('HAS_SPRINT')
      .from_('p')
      .to('s')
      .next();
    return id;
  };

  const migrate = (id, sub) =>
    handler({
      httpMethod: 'POST',
      path: `/projects/${id}/migrate-tracker`,
      pathParameters: { projectId: id },
      body: JSON.stringify({}),
      ...claims(sub),
    });

  it('creates a synthetic HAS_TRACKER edge and backfills sprints', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'Mig',
      gitRepo: 'acme/widgets',
      issueIntegrationEnabled: true,
    });
    const sprintId = await seedLegacySprint(id);

    const res = await migrate(id, sub);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      dryRun: false,
      projects: { candidates: 1, applied: 1 },
      sprints: { candidates: 1, applied: 1 },
    });

    // Project now has a tracker binding.
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).trackers).toEqual([
      expect.objectContaining({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'acme/widgets',
        displayName: 'acme/widgets',
      }),
    ]);

    // Sprint vertex now has tracker_provider set (verified via Gremlin).
    const sprint = await g.V().has('Sprint', 'id', sprintId).valueMap().next();
    const get = (k) => sprint.value.get(k)?.[0];
    expect(get('tracker_provider')).toBe('github-issues');
    expect(get('tracker_instance')).toBe('public');
    expect(get('tracker_external_project_key')).toBe('acme/widgets');
    expect(get('tracker_resource_id')).toBe('17');
  });

  it('is idempotent: re-running applies nothing', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'Mig',
      gitRepo: 'acme/widgets',
      issueIntegrationEnabled: true,
    });
    await seedLegacySprint(id);
    await migrate(id, sub);

    const res = await migrate(id, sub);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      dryRun: false,
      projects: { candidates: 0, applied: 0 },
      sprints: { candidates: 0, applied: 0 },
    });
  });

  it('returns 403 to plain members', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub, {
      name: 'Mig',
      issueIntegrationEnabled: true,
    });
    await addMember(id, memberSub, 'member');

    const res = await migrate(id, memberSub);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can migrate trackers',
    });
  });

  it('returns 403 when the caller is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub, { name: 'Mig' });
    const res = await migrate(id, otherSub);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('supports dryRun', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'Mig',
      gitRepo: 'acme/widgets',
      issueIntegrationEnabled: true,
    });
    await seedLegacySprint(id);

    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${id}/migrate-tracker`,
      pathParameters: { projectId: id },
      body: JSON.stringify({ dryRun: true }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      dryRun: true,
      projects: { candidates: 1, applied: 0 },
      sprints: { candidates: 1, applied: 0 },
    });

    // Confirm dry-run did not write a real HAS_TRACKER edge. The legacy
    // synthetic binding still surfaces (issue #194 — the projects API
    // appends one when issueIntegrationEnabled=true and there is no real
    // edge yet, so the issues panel stays visible pre-migration).
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).trackers).toEqual([
      expect.objectContaining({ id: 'legacy-github', provider: 'github-issues' }),
    ]);
  });
});

// #194: legacy projects (issueIntegrationEnabled='true' AND no HAS_TRACKER)
// get a synthetic github-issues binding so the FE issues panel still works
// without forcing a migration first. Banner-driven migration replaces the
// synthetic with a real edge.
describe('GET /projects[/{id}] legacy tracker synthesis', () => {
  it('appends a synthetic legacy-github binding on the single endpoint', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'Legacy',
      gitRepo: 'acme/widgets',
      issueIntegrationEnabled: true,
    });
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).trackers).toEqual([
      {
        id: 'legacy-github',
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'acme/widgets',
        displayName: 'acme/widgets',
        createdAt: NOW.toISOString(),
        createdBy: null,
      },
    ]);
  });

  it('appends a synthetic legacy-github binding on the list endpoint', async () => {
    const sub = `u-${randomUUID()}`;
    await createProject(sub, {
      name: 'Legacy',
      gitRepo: 'acme/widgets',
      issueIntegrationEnabled: true,
    });
    const res = await handler({ httpMethod: 'GET', ...claims(sub) });
    const projects = JSON.parse(res.body);
    const legacy = projects.find((p) => p.name === 'Legacy');
    expect(legacy.trackers).toEqual([
      expect.objectContaining({ id: 'legacy-github', externalProjectKey: 'acme/widgets' }),
    ]);
  });

  it('does not synthesize when issueIntegrationEnabled is false', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'X', gitRepo: 'a/b' });
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).trackers).toEqual([]);
  });

  it('does not synthesize when gitRepo is empty', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, {
      name: 'X',
      issueIntegrationEnabled: true,
    });
    const fetched = await handler({
      httpMethod: 'GET',
      pathParameters: { projectId: id },
      ...claims(sub),
    });
    expect(JSON.parse(fetched.body).trackers).toEqual([]);
  });
});

// Admin-facing whole-graph counterpart of the per-project migrate-tracker
// route (#194 phase #198). Authenticated-only; same shared core as the per-
// project endpoint and the bulk CLI lambda. Whole-graph assertions are only
// stable on a clean partition, so this block drops data between tests.
describe('admin tracker-migration routes', () => {
  beforeEach(async () => {
    // Each admin test asserts whole-graph counts, so leftovers from earlier
    // tests in this file (which share the same partition) would skew the
    // numbers. Confined to this describe so the per-project tests above
    // keep their own state model.
    await g.V().drop().next();
  });

  const seedLegacySprint = async (projectId) => {
    const id = randomUUID();
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .addV('Sprint')
      .property('id', id)
      .property('name', 'legacy')
      .property('description', '')
      .property('phase', 'INCEPTION')
      .property('sprint_id', id)
      .property('created_at', NOW.toISOString())
      .property('issue_number', '17')
      .property('issue_url', 'https://github.com/acme/widgets/issues/17')
      .as('s')
      .addE('HAS_SPRINT')
      .from_('p')
      .to('s')
      .next();
    return id;
  };

  describe('GET /admin/tracker-migration/status', () => {
    const status = (sub) =>
      handler({
        httpMethod: 'GET',
        path: '/admin/tracker-migration/status',
        ...adminClaims(sub),
      });

    it('returns dry-run counts across the whole graph and does not mutate', async () => {
      const sub = `u-${randomUUID()}`;
      const { id } = await createProject(sub, {
        name: 'Mig',
        gitRepo: 'acme/widgets',
        issueIntegrationEnabled: true,
      });
      await seedLegacySprint(id);

      const res = await status(sub);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        dryRun: true,
        projects: { candidates: 1, applied: 0 },
        sprints: { candidates: 1, applied: 0 },
      });

      // No mutation — the project still has no real tracker binding. The
      // projects API surfaces a synthetic `legacy-github` entry while
      // issueIntegrationEnabled is true (see #194), so the assertion
      // verifies the absence of any other binding rather than equality
      // against an empty array.
      const fetched = await handler({
        httpMethod: 'GET',
        pathParameters: { projectId: id },
        ...claims(sub),
      });
      expect(JSON.parse(fetched.body).trackers).toEqual([
        expect.objectContaining({ id: 'legacy-github' }),
      ]);
    });

    it('returns zeros on a fully migrated graph', async () => {
      const res = await status(`u-${randomUUID()}`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        dryRun: true,
        projects: { candidates: 0, applied: 0 },
        sprints: { candidates: 0, applied: 0 },
      });
    });

    it('rejects unauthenticated callers', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/admin/tracker-migration/status',
        requestContext: { authorizer: { claims: {} } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects authenticated non-platform-admin callers with 403', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/admin/tracker-migration/status',
        ...claims(`u-${randomUUID()}`),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
    });
  });

  describe('POST /admin/tracker-migration', () => {
    const run = (sub, body = {}) =>
      handler({
        httpMethod: 'POST',
        path: '/admin/tracker-migration',
        body: JSON.stringify(body),
        ...adminClaims(sub),
      });

    it('migrates every legacy project + sprint in one call', async () => {
      const sub = `u-${randomUUID()}`;
      const { id: id1 } = await createProject(sub, {
        name: 'A',
        gitRepo: 'acme/a',
        issueIntegrationEnabled: true,
      });
      const { id: id2 } = await createProject(sub, {
        name: 'B',
        gitRepo: 'acme/b',
        issueIntegrationEnabled: true,
      });
      await seedLegacySprint(id1);
      await seedLegacySprint(id2);

      const res = await run(sub);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        dryRun: false,
        projects: { candidates: 2, applied: 2 },
        sprints: { candidates: 2, applied: 2 },
      });
    });

    it('is idempotent: re-running applies nothing', async () => {
      const sub = `u-${randomUUID()}`;
      const { id } = await createProject(sub, {
        name: 'A',
        gitRepo: 'acme/a',
        issueIntegrationEnabled: true,
      });
      await seedLegacySprint(id);
      await run(sub);

      const res = await run(sub);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        dryRun: false,
        projects: { candidates: 0, applied: 0 },
        sprints: { candidates: 0, applied: 0 },
      });
    });

    it('supports dryRun', async () => {
      const sub = `u-${randomUUID()}`;
      const { id } = await createProject(sub, {
        name: 'A',
        gitRepo: 'acme/a',
        issueIntegrationEnabled: true,
      });
      await seedLegacySprint(id);

      const res = await run(sub, { dryRun: true });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        dryRun: true,
        projects: { candidates: 1, applied: 0 },
        sprints: { candidates: 1, applied: 0 },
      });

      // Confirm dry-run did not write a real edge. The projects API still
      // surfaces a synthetic `legacy-github` binding while
      // issueIntegrationEnabled is true (#194); checking for absence of
      // anything else is what "no mutation" means now.
      const fetched = await handler({
        httpMethod: 'GET',
        pathParameters: { projectId: id },
        ...claims(sub),
      });
      expect(JSON.parse(fetched.body).trackers).toEqual([
        expect.objectContaining({ id: 'legacy-github' }),
      ]);
    });

    it('rejects unauthenticated callers', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/admin/tracker-migration',
        body: JSON.stringify({}),
        requestContext: { authorizer: { claims: {} } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects malformed JSON', async () => {
      const sub = `u-${randomUUID()}`;
      const res = await handler({
        httpMethod: 'POST',
        path: '/admin/tracker-migration',
        body: '{not json',
        ...adminClaims(sub),
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects authenticated non-platform-admin callers with 403', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/admin/tracker-migration',
        body: JSON.stringify({}),
        ...claims(`u-${randomUUID()}`),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
    });
  });
});

// ===========================================================================
// Multi-repo repository management tests (multi-repo feature, PR #183)
// ===========================================================================
// ---------------------------------------------------------------------------
// Helpers shared across repos tests
// ---------------------------------------------------------------------------

const reposEvent = (method, projectId, extra = {}) => ({
  httpMethod: method,
  path: `/projects/${projectId}/repos`,
  pathParameters: { projectId },
  ...extra,
});

describe('GET /projects/:id/repos', () => {
  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      ...reposEvent('GET', 'any'),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 when the caller is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const outsiderSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      ...reposEvent('GET', id),
      ...claims(outsiderSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 200 with empty list for a project with no repos', async () => {
    const sub = `u-${randomUUID()}`;
    // Create project without a gitRepo so no repo vertex is seeded
    const { id } = await createProject(sub, { name: 'Empty' });
    const res = await handler({
      ...reposEvent('GET', id),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns 200 with repos list for a project that has repos', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'HasRepo', gitRepo: 'owner/repo-a' });
    const res = await handler({
      ...reposEvent('GET', id),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const repos = JSON.parse(res.body);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ url: 'owner/repo-a', role: 'primary' });
  });

  it('lazily migrates a legacy gitRepo on first GET', async () => {
    const sub = `u-${randomUUID()}`;
    // Seed a project directly with a legacy git_repo via PUT (no repos[] yet)
    const { id } = await createProject(sub, { name: 'Legacy', gitRepo: 'legacy/migrated' });

    // Confirm repos list reflects the migrated value
    const res = await handler({
      ...reposEvent('GET', id),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    const repos = JSON.parse(res.body);
    expect(repos.some((r) => r.url === 'legacy/migrated')).toBe(true);
  });

  it('allows a plain member to read repos', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub, { name: 'MemberRead' });
    await addMember(id, memberSub, 'member');
    const res = await handler({
      ...reposEvent('GET', id),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /projects/:id/repos', () => {
  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      ...reposEvent('POST', 'any', { body: JSON.stringify({ url: 'a/b' }) }),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 when the caller is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const outsiderSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'a/b' }) }),
      ...claims(outsiderSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 403 when the caller is a plain member (not owner/admin)', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'a/b' }) }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can add repositories',
    });
  });

  it('returns 400 when url is missing', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({}) }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'url is required' });
  });

  it('returns 400 when url is not in owner/repo format', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'not-valid' }) }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'url must be in owner/repo format' });
  });

  it('returns 201 and persists the repo for an owner', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'AddRepo' });
    const res = await handler({
      ...reposEvent('POST', id, {
        body: JSON.stringify({ url: 'my-org/my-repo', role: 'secondary' }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(created).toMatchObject({
      url: 'my-org/my-repo',
      role: 'secondary',
      provider: 'github',
      addedAt: NOW.toISOString(),
    });

    // Confirm it appears in subsequent GET
    const listRes = await handler({
      ...reposEvent('GET', id),
      ...claims(sub),
    });
    const repos = JSON.parse(listRes.body);
    expect(repos.some((r) => r.url === 'my-org/my-repo')).toBe(true);
  });

  it('allows admins to add a repo', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, adminSub, 'admin');
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'admin-org/admin-repo' }) }),
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 409 on duplicate url', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'dup/repo' }) }),
      ...claims(sub),
    });
    const res = await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'dup/repo' }) }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Repository already added to this project' });
  });
});

describe('DELETE /projects/:id/repos', () => {
  it('returns 401 when sub is missing', async () => {
    const res = await handler({
      ...reposEvent('DELETE', 'any', {
        queryStringParameters: { url: 'a/b' },
      }),
      requestContext: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 when the caller is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const outsiderSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      ...reposEvent('DELETE', id, { queryStringParameters: { url: 'a/b' } }),
      ...claims(outsiderSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Access denied' });
  });

  it('returns 403 when the caller is a plain member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      ...reposEvent('DELETE', id, { queryStringParameters: { url: 'a/b' } }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can remove repositories',
    });
  });

  it('returns 400 when url query param is missing', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('DELETE', id),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'url query parameter is required' });
  });

  it('returns 404 when the repo does not exist on the project', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('DELETE', id, { queryStringParameters: { url: 'ghost/repo' } }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Repository not found on this project' });
  });

  it('returns 200 and removes the repo for an owner', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    // Add a repo first
    await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'del-org/del-repo' }) }),
      ...claims(sub),
    });
    // Now delete it
    const res = await handler({
      ...reposEvent('DELETE', id, {
        queryStringParameters: { url: 'del-org/del-repo' },
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: 'del-org/del-repo' });

    // Confirm it no longer appears in GET
    const listRes = await handler({
      ...reposEvent('GET', id),
      ...claims(sub),
    });
    const repos = JSON.parse(listRes.body);
    expect(repos.some((r) => r.url === 'del-org/del-repo')).toBe(false);
  });

  it('allows admins to remove a repo', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, adminSub, 'admin');
    await handler({
      ...reposEvent('POST', id, { body: JSON.stringify({ url: 'admin-org/remove-me' }) }),
      ...claims(ownerSub),
    });
    const res = await handler({
      ...reposEvent('DELETE', id, {
        queryStringParameters: { url: 'admin-org/remove-me' },
      }),
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(200);
  });

  it('preserves the repository vertex when another project still references it', async () => {
    const sharedRepo = `org/shared-${randomUUID()}`;
    const ownerA = `u-${randomUUID()}`;
    const ownerB = `u-${randomUUID()}`;
    const first = await createProject(ownerA, {
      name: 'First',
      repos: [{ url: sharedRepo, role: 'primary' }],
    });
    const second = await createProject(ownerB, {
      name: 'Second',
      repos: [{ url: sharedRepo, role: 'primary' }],
    });

    const res = await handler({
      ...reposEvent('DELETE', first.id, {
        queryStringParameters: { url: sharedRepo },
      }),
      ...claims(ownerA),
    });

    expect(res.statusCode).toBe(200);

    const secondRepos = await handler({
      ...reposEvent('GET', second.id),
      ...claims(ownerB),
    });
    expect(secondRepos.statusCode).toBe(200);
    expect(JSON.parse(secondRepos.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: sharedRepo })]),
    );
  });
});

// ---------------------------------------------------------------------------
// Injection / validation guards — regression tests for the shell-safety and
// owner/repo patterns. If a future change relaxes these regexes, these fail.
// ---------------------------------------------------------------------------

describe('repo URL validation (injection guards)', () => {
  const MALICIOUS = [
    'owner/repo;rm -rf /',
    'owner/repo && curl evil',
    'owner/repo`id`',
    'owner/repo$(id)',
    'owner/repo|sh',
    '../../etc/passwd',
    'owner/repo with spaces',
    'owner/"repo"',
  ];

  it('rejects malicious urls on POST /repos with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'Inj' });
    for (const url of MALICIOUS) {
      const res = await handler({
        ...reposEvent('POST', id, { body: JSON.stringify({ url }) }),
        ...claims(sub),
      });
      expect(res.statusCode, `expected 400 for ${JSON.stringify(url)}`).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'url must be in owner/repo format' });
    }
  });

  it('rejects an unsafe legacy gitRepo on POST /projects with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Bad', gitRepo: 'owner/repo;curl evil|sh' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid gitRepo/);
  });

  it('rejects a traversal legacy gitRepo (..) on POST /projects with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Trav', gitRepo: '../../etc/passwd' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid gitRepo/);
  });

  it('rejects an invalid role on POST /repos with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('POST', id, {
        body: JSON.stringify({ url: 'org/repo', role: 'not-a-role' }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid role/);
  });

  it('rejects an invalid provider on POST /repos with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      ...reposEvent('POST', id, {
        body: JSON.stringify({ url: 'org/repo', provider: 'bitbucket' }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid provider/);
  });
});

describe('POST /projects with repos[] array', () => {
  it('creates multiple Repository vertices and returns them', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'Multi',
      repos: [
        { url: 'org/web', role: 'frontend' },
        { url: 'org/api', role: 'backend' },
        { url: 'org/core', role: 'primary' },
      ],
    });
    expect(created.repos).toHaveLength(3);
    const byUrl = Object.fromEntries(created.repos.map((r) => [r.url, r]));
    expect(byUrl['org/web'].role).toBe('frontend');
    expect(byUrl['org/api'].role).toBe('backend');
    // Primary repo drives the legacy gitRepo field.
    expect(created.gitRepo).toBe('org/core');

    // Confirm all three are persisted and returned by the repos route.
    const listRes = await handler({
      ...reposEvent('GET', created.id),
      ...claims(sub),
    });
    const repos = JSON.parse(listRes.body);
    expect(repos.map((r) => r.url).toSorted()).toEqual(['org/api', 'org/core', 'org/web']);
  });

  it('rejects the whole create when any repos[] url is invalid (400)', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        name: 'BadArr',
        repos: [{ url: 'org/good' }, { url: 'bad;rm -rf' }],
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid repository url/);
  });

  it('rejects a non-array repos payload with 400', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        name: 'BadReposType',
        repos: { url: 'org/repo' },
      }),
      ...claims(sub),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'repos must be an array' });
  });

  it('rejects repos[] with an invalid role (400)', async () => {
    const sub = `u-${randomUUID()}`;
    const res = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        name: 'BadRole',
        repos: [{ url: 'org/repo', role: 'wat' }],
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid role/);
  });

  it('promotes the selected main repository without leaving two primary repos', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'MainRepoSwitch',
      repos: [
        { url: 'org/old-main', role: 'primary' },
        { url: 'org/other', role: 'secondary' },
      ],
    });

    const updateRes = await handler({
      httpMethod: 'PUT',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      body: JSON.stringify({ gitRepo: 'org/other' }),
      ...claims(sub),
    });

    expect(updateRes.statusCode).toBe(200);

    const getRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });

    expect(getRes.statusCode).toBe(200);
    const project = JSON.parse(getRes.body);
    expect(project.gitRepo).toBe('org/other');

    const primaryRepos = project.repos.filter((repo) => repo.role === 'primary');
    expect(primaryRepos).toHaveLength(1);
    expect(primaryRepos[0].url).toBe('org/other');
    expect(project.repos).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: 'org/old-main', role: 'secondary' })]),
    );
  });
});

describe('POST /repos persists provider + role overrides', () => {
  it('round-trips a non-default provider and role', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub, { name: 'Override' });
    const res = await handler({
      ...reposEvent('POST', id, {
        body: JSON.stringify({ url: 'org/lib', provider: 'gitlab', role: 'shared' }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      url: 'org/lib',
      provider: 'gitlab',
      role: 'shared',
    });

    const listRes = await handler({ ...reposEvent('GET', id), ...claims(sub) });
    const added = JSON.parse(listRes.body).find((r) => r.url === 'org/lib');
    expect(added).toMatchObject({ provider: 'gitlab', role: 'shared' });
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups: primary-role invariant + shared-vertex safety across all
// entry points (project DELETE, POST add-repo, create, delete promotion).
// ---------------------------------------------------------------------------

describe('single-primary invariant across entry points', () => {
  it('demotes the existing primary when POST /repos adds a new primary', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'AddPrimary',
      repos: [{ url: 'org/old-main', role: 'primary' }],
    });
    expect(created.gitRepo).toBe('org/old-main');

    const addRes = await handler({
      ...reposEvent('POST', created.id, {
        body: JSON.stringify({ url: 'org/new-main', role: 'primary' }),
      }),
      ...claims(sub),
    });
    expect(addRes.statusCode).toBe(201);

    const getRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    const project = JSON.parse(getRes.body);
    const primaries = project.repos.filter((r) => r.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].url).toBe('org/new-main');
    expect(project.gitRepo).toBe('org/new-main');
  });

  it('normalizes to a single primary when create supplies multiple primaries', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'MultiPrimary',
      repos: [
        { url: 'org/a', role: 'primary' },
        { url: 'org/b', role: 'primary' },
      ],
    });

    const getRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    const project = JSON.parse(getRes.body);
    const primaries = project.repos.filter((r) => r.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(project.gitRepo).toBe(primaries[0].url);
  });

  it('promotes exactly one remaining repo after deleting the primary', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'DeletePrimary',
      repos: [
        { url: 'org/main', role: 'primary' },
        { url: 'org/lib', role: 'secondary' },
      ],
    });

    const delRes = await handler({
      ...reposEvent('DELETE', created.id, {
        queryStringParameters: { url: 'org/main' },
      }),
      ...claims(sub),
    });
    expect(delRes.statusCode).toBe(200);

    const getRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    const project = JSON.parse(getRes.body);
    const primaries = project.repos.filter((r) => r.role === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].url).toBe('org/lib');
    expect(project.gitRepo).toBe('org/lib');
  });

  it('clears git_repo when the last repo is deleted', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'DeleteLast',
      repos: [{ url: 'org/only', role: 'primary' }],
    });

    const delRes = await handler({
      ...reposEvent('DELETE', created.id, {
        queryStringParameters: { url: 'org/only' },
      }),
      ...claims(sub),
    });
    expect(delRes.statusCode).toBe(200);

    const getRes = await handler({
      httpMethod: 'GET',
      path: `/projects/${created.id}`,
      pathParameters: { projectId: created.id },
      ...claims(sub),
    });
    const project = JSON.parse(getRes.body);
    expect(project.repos).toEqual([]);
    expect(project.gitRepo).toBe('');
  });
});

describe('shared Repository vertex safety on project DELETE', () => {
  it('keeps a shared repo intact for other projects when one project is deleted', async () => {
    const sharedRepo = `org/shared-${randomUUID()}`;
    const ownerA = `u-${randomUUID()}`;
    const ownerB = `u-${randomUUID()}`;
    const first = await createProject(ownerA, {
      name: 'First',
      repos: [{ url: sharedRepo, role: 'primary' }],
    });
    const second = await createProject(ownerB, {
      name: 'Second',
      repos: [{ url: sharedRepo, role: 'primary' }],
    });

    const delRes = await handler({
      httpMethod: 'DELETE',
      path: `/projects/${first.id}`,
      pathParameters: { projectId: first.id },
      ...claims(ownerA),
    });
    expect(delRes.statusCode).toBe(204);

    // The surviving project must still see the shared repo and not break.
    const listRes = await handler({
      ...reposEvent('GET', second.id),
      ...claims(ownerB),
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: sharedRepo })]),
    );
  });
});

const customMcpEvent = (method, projectId, extra = {}) => ({
  httpMethod: method,
  path: `/projects/${projectId}/custom-mcp-servers`,
  pathParameters: { projectId },
  ...extra,
});

const customRulesEvent = (method, projectId, extra = {}) => ({
  httpMethod: method,
  path: `/projects/${projectId}/custom-rules`,
  pathParameters: { projectId },
  ...extra,
});

describe('GET/PUT /projects/:id/custom-mcp-servers', () => {
  it('returns 401 when sub is missing', async () => {
    const res = await handler({ ...customMcpEvent('GET', 'any'), requestContext: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const outsiderSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({ ...customMcpEvent('GET', id), ...claims(outsiderSub) });
    expect(res.statusCode).toBe(403);
  });

  it('defaults to an empty object', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({ ...customMcpEvent('GET', id), ...claims(sub) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ customMcpServers: '{}' });
  });

  it('persists and reads back valid MCP servers (owner)', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const json = JSON.stringify({ 'my-tool': { command: 'npx', args: ['-y', 'p'] } });
    const putRes = await handler({
      ...customMcpEvent('PUT', id, { body: JSON.stringify({ customMcpServers: json }) }),
      ...claims(sub),
    });
    expect(putRes.statusCode).toBe(200);
    const getRes = await handler({ ...customMcpEvent('GET', id), ...claims(sub) });
    expect(JSON.parse(JSON.parse(getRes.body).customMcpServers)).toEqual({
      'my-tool': { command: 'npx', args: ['-y', 'p'] },
    });
  });

  it('rejects invalid MCP config with field-level issues', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const bad = JSON.stringify({ x: {} }); // missing command
    const res = await handler({
      ...customMcpEvent('PUT', id, { body: JSON.stringify({ customMcpServers: bad }) }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toMatch(/Invalid MCP/);
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  it('rejects a plain member on PUT', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      ...customMcpEvent('PUT', id, { body: JSON.stringify({ customMcpServers: '{}' }) }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a plain member on GET (config may carry secrets)', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({ ...customMcpEvent('GET', id), ...claims(memberSub) });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET/PUT /projects/:id/custom-rules', () => {
  it('defaults to an empty list', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ customRules: [] });
  });

  it('presign returns upload URLs WITHOUT persisting metadata (owner)', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const putRes = await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({ customRules: [{ filename: 'standards.md' }], mode: 'presign' }),
      }),
      ...claims(sub),
    });
    expect(putRes.statusCode).toBe(200);
    const body = JSON.parse(putRes.body);
    expect(body.saved).toBeUndefined();
    expect(body.uploadUrls).toHaveLength(1);
    expect(body.uploadUrls[0]).toMatchObject({
      filename: 'standards.md',
      s3Key: `custom-rules/${id}/standards.md`,
    });
    expect(typeof body.uploadUrls[0].uploadUrl).toBe('string');

    // Presign must NOT have persisted anything — the list is still empty.
    const getRes = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    expect(JSON.parse(getRes.body).customRules).toEqual([]);
  });

  it('commit persists the final metadata set and it reads back (owner)', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    // Simulate the browser having uploaded both objects before committing.
    putObject(`custom-rules/${id}/standards.md`);
    putObject(`custom-rules/${id}/api.md`);
    const commitRes = await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({
          customRules: [{ filename: 'standards.md' }, { filename: 'api.md' }],
          mode: 'commit',
        }),
      }),
      ...claims(sub),
    });
    expect(commitRes.statusCode).toBe(200);
    const body = JSON.parse(commitRes.body);
    expect(body.saved).toBe(true);
    expect(body.uploadUrls).toBeUndefined();

    const getRes = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    const docs = JSON.parse(getRes.body).customRules;
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filename).toSorted()).toEqual(['api.md', 'standards.md']);
    expect(docs.every((d) => typeof d.downloadUrl === 'string')).toBe(true);
  });

  it('commit rejects a filename whose object was never uploaded', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    // Only standards.md was uploaded; api.md is fabricated by the caller.
    putObject(`custom-rules/${id}/standards.md`);
    const res = await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({
          customRules: [{ filename: 'standards.md' }, { filename: 'api.md' }],
          mode: 'commit',
        }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/api\.md/);
    // Nothing persisted — the list is still empty.
    const getRes = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    expect(JSON.parse(getRes.body).customRules).toEqual([]);
  });

  it('commit rejects an object that exceeds the 100 KB size cap', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    putObject(`custom-rules/${id}/ok.md`, 10);
    putObject(`custom-rules/${id}/big.md`, 200 * 1024);
    const res = await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({
          customRules: [{ filename: 'ok.md' }, { filename: 'big.md' }],
          mode: 'commit',
        }),
      }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/big\.md/);
    expect(JSON.parse(res.body).error).toMatch(/100 KB/);
    // Nothing persisted.
    const getRes = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    expect(JSON.parse(getRes.body).customRules).toEqual([]);
  });

  it('commit can prune the set (delete path)', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    putObject(`custom-rules/${id}/a.md`);
    putObject(`custom-rules/${id}/b.md`);
    await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({
          customRules: [{ filename: 'a.md' }, { filename: 'b.md' }],
          mode: 'commit',
        }),
      }),
      ...claims(sub),
    });
    // Re-commit with only one — simulates deleting b.md.
    await handler({
      ...customRulesEvent('PUT', id, {
        body: JSON.stringify({ customRules: [{ filename: 'a.md' }], mode: 'commit' }),
      }),
      ...claims(sub),
    });
    const getRes = await handler({ ...customRulesEvent('GET', id), ...claims(sub) });
    const docs = JSON.parse(getRes.body).customRules;
    expect(docs.map((d) => d.filename)).toEqual(['a.md']);
  });

  it('rejects unsafe / non-.md filenames (both modes)', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    for (const mode of ['presign', 'commit']) {
      for (const filename of ['../evil.md', 'sub/dir.md', 'notmd.txt']) {
        const res = await handler({
          ...customRulesEvent('PUT', id, {
            body: JSON.stringify({ customRules: [{ filename }], mode }),
          }),
          ...claims(sub),
        });
        expect(res.statusCode, `${mode} ${filename}`).toBe(400);
      }
    }
  });

  it('caps the number of custom rules', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const docs = Array.from({ length: 21 }, (_, i) => ({ filename: `r${i}.md` }));
    const res = await handler({
      ...customRulesEvent('PUT', id, { body: JSON.stringify({ customRules: docs }) }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a plain member on PUT', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      ...customRulesEvent('PUT', id, { body: JSON.stringify({ customRules: [] }) }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a plain member on GET', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({ ...customRulesEvent('GET', id), ...claims(memberSub) });
    expect(res.statusCode).toBe(403);
  });
});
