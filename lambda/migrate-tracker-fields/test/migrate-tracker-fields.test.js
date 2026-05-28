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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // The handler walks every Project + Sprint in the partition, so each test
  // needs a clean slate. PartitionStrategy scopes the drop to this file's
  // partition only — no cross-file leakage.
  await g.V().drop().next();
});

afterEach(() => {
  vi.useRealTimers();
});

const seedLegacyProject = async ({
  gitRepo = 'acme/widgets',
  issueIntegrationEnabled = true,
} = {}) => {
  const id = randomUUID();
  await g
    .addV('Project')
    .property('id', id)
    .property('name', `P-${id.slice(0, 8)}`)
    .property('git_provider', 'github')
    .property('git_repo', gitRepo)
    .property('agent_cli', 'kiro')
    .property('issue_integration_enabled', issueIntegrationEnabled ? 'true' : 'false')
    .property('created_at', NOW.toISOString())
    .next();
  return id;
};

const seedLegacySprint = async (projectId, { issueNumber = '17', issueUrl = '' } = {}) => {
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

const sprintProperty = async (sprintId, key) => {
  const r = await g.V().has('Sprint', 'id', sprintId).valueMap().next();
  return r.value.get(key)?.[0];
};

const projectTrackerCount = async (projectId) => {
  const r = await g.V().has('Project', 'id', projectId).out('HAS_TRACKER').count().next();
  return Number(r.value);
};

describe('handler', () => {
  it('migrates legacy projects + sprints and is idempotent', async () => {
    // Two legacy projects, each with two sprints linked to issues, plus a
    // sprint with no issue (must not be touched).
    const p1 = await seedLegacyProject({ gitRepo: 'acme/one' });
    const p2 = await seedLegacyProject({ gitRepo: 'acme/two' });
    const s1 = await seedLegacySprint(p1, {
      issueNumber: '10',
      issueUrl: 'https://github.com/acme/one/issues/10',
    });
    const s2 = await seedLegacySprint(p1, {
      issueNumber: '11',
      issueUrl: 'https://github.com/acme/one/issues/11',
    });
    const s3 = await seedLegacySprint(p2, {
      issueNumber: '20',
      issueUrl: 'https://github.com/acme/two/issues/20',
    });
    // Sprint without an issue link — not a candidate.
    await seedLegacySprint(p2, { issueNumber: '', issueUrl: '' });

    const first = await handler({});
    expect(first).toEqual({
      dryRun: false,
      projects: { candidates: 2, applied: 2 },
      sprints: { candidates: 3, applied: 3 },
    });

    // Each project now has one HAS_TRACKER edge.
    expect(await projectTrackerCount(p1)).toBe(1);
    expect(await projectTrackerCount(p2)).toBe(1);

    // Each migrated sprint has the polymorphic fields populated.
    expect(await sprintProperty(s1, 'tracker_provider')).toBe('github-issues');
    expect(await sprintProperty(s1, 'tracker_resource_id')).toBe('10');
    expect(await sprintProperty(s1, 'tracker_external_project_key')).toBe('acme/one');
    expect(await sprintProperty(s2, 'tracker_resource_id')).toBe('11');
    expect(await sprintProperty(s3, 'tracker_external_project_key')).toBe('acme/two');

    // Re-running is a no-op.
    const second = await handler({});
    expect(second).toEqual({
      dryRun: false,
      projects: { candidates: 0, applied: 0 },
      sprints: { candidates: 0, applied: 0 },
    });
  });

  it('dryRun reports candidates without writing', async () => {
    const p = await seedLegacyProject({ gitRepo: 'acme/dry' });
    await seedLegacySprint(p, { issueNumber: '5' });

    const result = await handler({ dryRun: true });
    expect(result).toEqual({
      dryRun: true,
      projects: { candidates: 1, applied: 0 },
      sprints: { candidates: 1, applied: 0 },
    });

    // Confirm nothing changed.
    expect(await projectTrackerCount(p)).toBe(0);
  });

  it('skips projects that already have a HAS_TRACKER edge', async () => {
    // Project that's already on the new shape — should not be re-migrated.
    const p = await seedLegacyProject({ gitRepo: 'acme/already' });
    await g
      .V()
      .has('Project', 'id', p)
      .as('p')
      .addV('TrackerBinding')
      .property('id', randomUUID())
      .property('provider', 'github-issues')
      .property('instance', 'public')
      .property('external_project_key', 'acme/already')
      .property('display_name', 'acme/already')
      .as('b')
      .addE('HAS_TRACKER')
      .from_('p')
      .to('b')
      .next();

    const result = await handler({});
    expect(result.projects.candidates).toBe(0);
    expect(await projectTrackerCount(p)).toBe(1);
  });
});
