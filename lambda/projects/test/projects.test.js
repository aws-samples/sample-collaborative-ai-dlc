import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

// File-level partition: every test in this file shares it.
const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  // If a developer has AWS_PROFILE set locally, the SDK preempts the env-var
  // creds planted by globalSetup and tries to resolve the profile via SSO/IMDS,
  // adding ~1s per getConnection call. Unset for the test process.
  vi.stubEnv('AWS_PROFILE', undefined);
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
});

afterEach(() => {
  vi.useRealTimers();
});

const claims = (sub, email = `${sub}@x`) => ({
  requestContext: { authorizer: { claims: { sub, email } } },
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
      kind: 'v1',
      createdAt: NOW.toISOString(),
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
      kind: 'v1',
      createdAt: NOW.toISOString(),
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

  it('persists v2 kind + workflow/scope/park settings', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, {
      name: 'V2',
      kind: 'v2',
      workflowId: 'aidlc-v2',
      scope: 'feature',
      parkReleaseSeconds: 120,
    });
    expect(created.kind).toBe('v2');
    expect(created.workflowId).toBe('aidlc-v2');
    expect(created.defaultScope).toBe('feature');
    expect(created.parkReleaseSeconds).toBe(120);
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
    expect(body.defaultScope).toBe('feature');
    expect(body.parkReleaseSeconds).toBe(120);
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

  it('defaults kind to v1 when omitted and omits v2 settings', async () => {
    const sub = `u-${randomUUID()}`;
    const created = await createProject(sub, { name: 'Classic' });
    expect(created.kind).toBe('v1');
    expect(created.workflowId).toBeUndefined();
    expect(created.parkReleaseSeconds).toBeUndefined();
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
    const list = JSON.parse(res.body).sort((x, y) => x.name.localeCompare(y.name));
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

describe('PUT /projects/:id/mcp-servers authorization', () => {
  it('allows owners to update MCP servers', async () => {
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers: '[]' }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows admins to update MCP servers', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, adminSub, 'admin');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers: '[]' }),
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 when a plain member tries to update MCP servers', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers: '[]' }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can update MCP servers',
    });
  });

  it('returns 403 when a non-member tries to update MCP servers', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/mcp-servers`,
      body: JSON.stringify({ mcpServers: '[]' }),
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /projects/:id/steering-docs authorization', () => {
  it('allows owners to update steering docs', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const sub = `u-${randomUUID()}`;
    const { id } = await createProject(sub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [] }),
      ...claims(sub),
    });
    expect(res.statusCode).toBe(200);
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('allows admins to update steering docs', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'test-bucket');
    const ownerSub = `u-${randomUUID()}`;
    const adminSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, adminSub, 'admin');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [] }),
      ...claims(adminSub),
    });
    expect(res.statusCode).toBe(200);
    vi.stubEnv('ARTIFACTS_BUCKET', undefined);
  });

  it('returns 403 when a plain member tries to update steering docs', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const memberSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    await addMember(id, memberSub, 'member');
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [] }),
      ...claims(memberSub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Only project owners and admins can update steering docs',
    });
  });

  it('returns 403 when a non-member tries to update steering docs', async () => {
    const ownerSub = `u-${randomUUID()}`;
    const otherSub = `u-${randomUUID()}`;
    const { id } = await createProject(ownerSub);
    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { projectId: id },
      path: `/projects/${id}/steering-docs`,
      body: JSON.stringify({ steeringDocs: [] }),
      ...claims(otherSub),
    });
    expect(res.statusCode).toBe(403);
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
        ...claims(sub),
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
  });

  describe('POST /admin/tracker-migration', () => {
    const run = (sub, body = {}) =>
      handler({
        httpMethod: 'POST',
        path: '/admin/tracker-migration',
        body: JSON.stringify(body),
        ...claims(sub),
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
        ...claims(sub),
      });
      expect(res.statusCode).toBe(400);
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
    expect(repos.map((r) => r.url).sort()).toEqual(['org/api', 'org/core', 'org/web']);
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
