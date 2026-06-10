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

const updateSprint = async (sprintId, body) => {
  const res = await handler({
    httpMethod: 'PUT',
    pathParameters: { sprintId },
    body: JSON.stringify(body),
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
    expect(created.currentStage).toBeNull();
    expect(created.phaseStatus).toBe('active');
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
    expect(fetched.currentStage).toBeNull();
    expect(fetched.phaseStatus).toBe('active');
  });
});

describe('PUT /sprints/:id', () => {
  it('allows the UI to own phase transitions and visible workflow state', async () => {
    const projectId = await seedProject({ gitRepo: 'octo/repo' });
    const created = await createSprint(projectId, { name: 'S' });

    const updated = await updateSprint(created.id, {
      phase: 'CONSTRUCTION',
      currentStage: 'code-generation',
      phaseStatus: 'active',
      branch: 'feature/sprint-1',
      baseBranch: 'main',
      currentAgentStatus: 'failed',
    });

    expect(updated).toMatchObject({
      phase: 'CONSTRUCTION',
      currentStage: 'code-generation',
      phaseStatus: 'active',
      branch: 'feature/sprint-1',
      baseBranch: 'main',
    });
    expect(updated.currentAgentStatus).toBeNull();
  });
});
