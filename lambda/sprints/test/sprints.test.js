import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

// The fanout helper is mocked at module level — its internals are covered by
// its consumers' own suites; here we only assert the sprints lambda EMITS the
// server-origin phase-change hint (discussions plan §4b, D10).
vi.mock('../../shared/ws-fanout.js', () => ({ broadcastToSprintChannel: vi.fn() }));
const { broadcastToSprintChannel } = await import('../../shared/ws-fanout.js');

const NOW = new Date('2026-05-28T00:00:00.000Z');
const PARTITION = `t-${randomUUID()}`;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler } = await import('../index.js'));

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

beforeEach(() => {
  vi.mocked(broadcastToSprintChannel).mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const seedProject = async ({ gitRepo = 'acme/widgets' } = {}) => {
  const id = randomUUID();
  await g
    .addV('Project')
    .property('id', id)
    .property('name', `P-${id.slice(0, 8)}`)
    .property('git_provider', 'github')
    .property('git_repo', gitRepo)
    .property('agent_cli', 'kiro')
    .property('issue_integration_enabled', 'true')
    .property('created_at', NOW.toISOString())
    .next();
  return id;
};

// Seeds a Sprint vertex on the legacy shape (issue_number/issue_url only,
// no tracker_*) — simulates pre-#194 data that hasn't been migrated yet.
const seedLegacySprint = async (projectId, { issueNumber = '99', issueUrl = '' } = {}) => {
  const id = randomUUID();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('Sprint')
    .property('id', id)
    .property('name', `legacy-${id.slice(0, 8)}`)
    .property('description', '')
    .property('phase', 'INCEPTION')
    .property('sprint_id', id)
    .property('created_at', NOW.toISOString())
    .property('issue_number', issueNumber)
    .property('issue_url', issueUrl)
    .as('s')
    .addE('HAS_SPRINT')
    .from_('p')
    .to('s')
    .next();
  return id;
};

const createSprint = async (projectId, body) => {
  const res = await handler({
    httpMethod: 'POST',
    pathParameters: { projectId },
    body: JSON.stringify(body),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
};

const getSprint = async (sprintId) => {
  const res = await handler({
    httpMethod: 'GET',
    pathParameters: { sprintId },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
};

describe('POST /sprints', () => {
  it('derives a github-issues tracker from issueNumber/issueUrl (legacy frontend path)', async () => {
    const projectId = await seedProject({ gitRepo: 'octo/repo' });
    const created = await createSprint(projectId, {
      name: 'S',
      issueNumber: 7,
      issueUrl: 'https://github.com/octo/repo/issues/7',
    });

    expect(created.issueNumber).toBe('7');
    expect(created.issueUrl).toBe('https://github.com/octo/repo/issues/7');
    expect(created.tracker).toEqual({
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'octo/repo',
      resourceType: 'issue',
      resourceId: '7',
      resourceUrl: 'https://github.com/octo/repo/issues/7',
    });
  });

  it('passes through an explicit Jira-shaped tracker payload', async () => {
    const projectId = await seedProject({ gitRepo: 'octo/repo' });
    const created = await createSprint(projectId, {
      name: 'Jira sprint',
      tracker: {
        provider: 'jira-cloud',
        instance: 'cloud',
        externalProjectKey: 'PROJ',
        resourceType: 'issue',
        resourceId: 'PROJ-123',
        resourceUrl: 'https://acme.atlassian.net/browse/PROJ-123',
      },
    });

    expect(created.tracker).toMatchObject({
      provider: 'jira-cloud',
      externalProjectKey: 'PROJ',
      resourceId: 'PROJ-123',
    });
    // Legacy fields stay null because the tracker isn't a github-issue.
    expect(created.issueNumber).toBeNull();
    expect(created.issueUrl).toBeNull();
  });

  it('returns tracker=null when no issue or tracker is supplied', async () => {
    const projectId = await seedProject();
    const created = await createSprint(projectId, { name: 'plain' });
    expect(created.tracker).toBeNull();
    expect(created.issueNumber).toBeNull();
  });
});

describe('GET /sprints/:id (backward compatibility)', () => {
  it('still surfaces issueNumber/issueUrl for unmigrated legacy sprints', async () => {
    const projectId = await seedProject({ gitRepo: 'foo/bar' });
    const sprintId = await seedLegacySprint(projectId, {
      issueNumber: '42',
      issueUrl: 'https://github.com/foo/bar/issues/42',
    });

    const fetched = await getSprint(sprintId);
    // Legacy data path: tracker is null because the migration hasn't run,
    // but issueNumber/issueUrl render exactly as before #194.
    expect(fetched.tracker).toBeNull();
    expect(fetched.issueNumber).toBe('42');
    expect(fetched.issueUrl).toBe('https://github.com/foo/bar/issues/42');
  });

  it('round-trips a fresh github-issues sprint and exposes both shapes', async () => {
    const projectId = await seedProject({ gitRepo: 'octo/repo' });
    const created = await createSprint(projectId, {
      name: 'S',
      issueNumber: 7,
      issueUrl: 'https://github.com/octo/repo/issues/7',
    });

    const fetched = await getSprint(created.id);
    expect(fetched.tracker).toEqual(created.tracker);
    expect(fetched.issueNumber).toBe('7');
    expect(fetched.issueUrl).toBe('https://github.com/octo/repo/issues/7');
  });
});

describe('DELETE /sprints/:id — discussion cascade (discussions plan §5)', () => {
  it('drops the sprint together with its discussions AND their messages', async () => {
    const projectId = await seedProject();
    const sprintId = await seedLegacySprint(projectId);

    // Sprint -HAS_DISCUSSION-> Discussion -HAS_MESSAGE-> DiscussionMessage,
    // plus a CONTAINS artifact to confirm the existing cascade still works.
    await g
      .V()
      .has('Sprint', 'id', sprintId)
      .as('s')
      .addV('Discussion')
      .property('id', 'disc-cascade')
      .property('sprint_id', sprintId)
      .as('d')
      .addE('HAS_DISCUSSION')
      .from_('s')
      .to('d')
      .select('d')
      .addE('DISCUSSES')
      .from_('d')
      .to('s')
      .select('d')
      .addV('DiscussionMessage')
      .property('id', 'dm-cascade-msg00001')
      .property('discussion_id', 'disc-cascade')
      .as('m')
      .addE('HAS_MESSAGE')
      .from_('d')
      .to('m')
      .next();
    await g
      .V()
      .has('Sprint', 'id', sprintId)
      .as('s')
      .addV('Task')
      .property('id', 'task-cascade')
      .as('t')
      .addE('CONTAINS')
      .from_('s')
      .to('t')
      .next();

    const res = await handler({ httpMethod: 'DELETE', pathParameters: { sprintId } });
    expect(res.statusCode).toBe(204);

    // Scope to this test's vertices (by the `id` property — the codebase
    // never uses native T.id) — the file partition accumulates vertices from
    // other tests.
    const remaining = await g
      .V()
      .has(
        'id',
        gremlin.process.P.within(sprintId, 'disc-cascade', 'dm-cascade-msg00001', 'task-cascade'),
      )
      .values('id')
      .toList();
    expect(remaining).toEqual([]);
  });
});

describe('server-origin sprint.phaseChanged fanout (discussions plan §4b, D10)', () => {
  it('emits the payload-blind reload hint on a phase update', async () => {
    const projectId = await seedProject();
    const sprintId = await seedLegacySprint(projectId);

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId },
      body: JSON.stringify({ phase: 'CONSTRUCTION' }),
    });
    expect(res.statusCode).toBe(200);

    // The hint deliberately carries NO phase — handlers re-fetch and act on
    // server state only (§4b payload-blind invariant).
    expect(broadcastToSprintChannel).toHaveBeenCalledExactlyOnceWith(sprintId, {
      action: 'sprint.phaseChanged',
      sprintId,
    });
  });

  it('does NOT emit on non-phase updates', async () => {
    const projectId = await seedProject();
    const sprintId = await seedLegacySprint(projectId);

    const res = await handler({
      httpMethod: 'PUT',
      pathParameters: { sprintId },
      body: JSON.stringify({ description: 'updated description' }),
    });
    expect(res.statusCode).toBe(200);
    expect(broadcastToSprintChannel).not.toHaveBeenCalled();
  });
});
