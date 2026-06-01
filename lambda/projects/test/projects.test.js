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
      issueIntegrationEnabled: false,
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
      issueIntegrationEnabled: false,
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
        gitRepo: 'g2',
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
      gitRepo: 'g2',
      gitProvider: 'gitlab',
      agentCli: 'claude',
    });
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

    // Confirm dry-run did not write.
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

      // No mutation — the project still has no tracker binding.
      const fetched = await handler({
        httpMethod: 'GET',
        pathParameters: { projectId: id },
        ...claims(sub),
      });
      expect(JSON.parse(fetched.body).trackers).toEqual([]);
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

      // Confirm dry-run did not write.
      const fetched = await handler({
        httpMethod: 'GET',
        pathParameters: { projectId: id },
        ...claims(sub),
      });
      expect(JSON.parse(fetched.body).trackers).toEqual([]);
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
