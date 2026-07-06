import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';

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
// The sprint write handlers are gone (v1 is read-only), so all seeding goes
// straight through gremlin.
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

// Seeds a Sprint with the polymorphic tracker_* properties (post-#194 shape,
// what the v1 POST handler used to write for a github-issues sprint).
const seedTrackerSprint = async (projectId, tracker) => {
  const id = randomUUID();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('Sprint')
    .property('id', id)
    .property('name', `tracked-${id.slice(0, 8)}`)
    .property('description', '')
    .property('phase', 'INCEPTION')
    .property('sprint_id', id)
    .property('created_at', NOW.toISOString())
    .property('current_execution_arn', '')
    .property('current_execution_id', '')
    .property('current_agent_status', '')
    .property('issue_number', tracker.provider === 'github-issues' ? tracker.resourceId : '')
    .property('issue_url', tracker.provider === 'github-issues' ? tracker.resourceUrl : '')
    .property('tracker_provider', tracker.provider)
    .property('tracker_instance', tracker.instance || '')
    .property('tracker_external_project_key', tracker.externalProjectKey || '')
    .property('tracker_resource_type', tracker.resourceType || 'issue')
    .property('tracker_resource_id', tracker.resourceId || '')
    .property('tracker_resource_url', tracker.resourceUrl || '')
    .as('s')
    .addE('HAS_SPRINT')
    .from_('p')
    .to('s')
    .next();
  return id;
};

const getSprint = async (sprintId) => {
  const res = await handler({
    httpMethod: 'GET',
    pathParameters: { sprintId },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
};

describe('GET /projects/:projectId/sprints (list)', () => {
  it('lists all sprints of the project', async () => {
    const projectId = await seedProject();
    const a = await seedLegacySprint(projectId);
    const b = await seedLegacySprint(projectId);

    const res = await handler({ httpMethod: 'GET', pathParameters: { projectId } });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body);
    expect(list.map((s) => s.id).toSorted()).toEqual([a, b].toSorted());
  });

  it('does not return sprints of other projects', async () => {
    const projectId = await seedProject();
    const otherProjectId = await seedProject();
    await seedLegacySprint(otherProjectId);

    const res = await handler({ httpMethod: 'GET', pathParameters: { projectId } });
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('GET /sprints/:id (single)', () => {
  it('returns 404 for an unknown sprint', async () => {
    const res = await handler({
      httpMethod: 'GET',
      pathParameters: { sprintId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });

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

  it('maps the tracker_* properties of a github-issues sprint into both shapes', async () => {
    const projectId = await seedProject({ gitRepo: 'octo/repo' });
    const sprintId = await seedTrackerSprint(projectId, {
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'octo/repo',
      resourceType: 'issue',
      resourceId: '7',
      resourceUrl: 'https://github.com/octo/repo/issues/7',
    });

    const fetched = await getSprint(sprintId);
    expect(fetched.tracker).toEqual({
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'octo/repo',
      resourceType: 'issue',
      resourceId: '7',
      resourceUrl: 'https://github.com/octo/repo/issues/7',
    });
    expect(fetched.issueNumber).toBe('7');
    expect(fetched.issueUrl).toBe('https://github.com/octo/repo/issues/7');
  });

  it('keeps legacy fields null for a Jira-shaped tracker', async () => {
    const projectId = await seedProject();
    const sprintId = await seedTrackerSprint(projectId, {
      provider: 'jira-cloud',
      instance: 'cloud',
      externalProjectKey: 'PROJ',
      resourceType: 'issue',
      resourceId: 'PROJ-123',
      resourceUrl: 'https://acme.atlassian.net/browse/PROJ-123',
    });

    const fetched = await getSprint(sprintId);
    expect(fetched.tracker).toMatchObject({
      provider: 'jira-cloud',
      externalProjectKey: 'PROJ',
      resourceId: 'PROJ-123',
    });
    // Legacy fields stay null because the tracker isn't a github-issue.
    expect(fetched.issueNumber).toBeNull();
    expect(fetched.issueUrl).toBeNull();
  });
});

describe('method routing (v1 is read-only)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('returns 405 for %s', async (httpMethod) => {
    const projectId = await seedProject();
    const sprintId = await seedLegacySprint(projectId);
    const res = await handler({
      httpMethod,
      pathParameters: { projectId, sprintId },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'Method not allowed' });
  });
});
