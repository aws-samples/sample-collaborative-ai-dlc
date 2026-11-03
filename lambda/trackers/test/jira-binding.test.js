import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareJiraDelegation, writeJiraBinding } from '../jira-binding.js';
import { verifyProject } from '../providers/jira-cloud.js';
import { ProviderError } from '../providers/errors.js';
import { mapBinding, trackerBindingProjectionStep } from '../../shared/trackers.js';

vi.mock('../providers/jira-cloud.js', () => ({
  verifyProject: vi.fn(),
  getConnectionRow: vi.fn(),
}));

const NOW = new Date('2026-11-02T12:00:00Z');
const data = {
  provider: 'jira-cloud',
  instance: 'cloud',
  externalProjectKey: 'ENG',
  displayName: 'Engineering',
  confirmDelegation: true,
};
const delegation = {
  connectionUserId: 'admin-a',
  cloudId: 'site-1',
  externalProjectId: '10000',
};
const connection = { userId: 'admin-a', ddb: {}, ssm: {}, secrets: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(verifyProject).mockResolvedValue(delegation);
});

afterEach(() => vi.useRealTimers());

describe('prepareJiraDelegation', () => {
  it.each([undefined, false, 'true'])(
    'requires explicit consent (%s)',
    async (confirmDelegation) => {
      await expect(
        prepareJiraDelegation({ ...connection, data: { ...data, confirmDelegation } }),
      ).rejects.toMatchObject({
        status: 400,
        extra: { code: 'DELEGATION_REQUIRED' },
      });
      expect(verifyProject).not.toHaveBeenCalled();
    },
  );

  it('takes the identity from the verified connection, not the request', async () => {
    await expect(
      prepareJiraDelegation({
        ...connection,
        data: { ...data, connectionUserId: 'someone-else', cloudId: 'untrusted-site' },
      }),
    ).resolves.toEqual(delegation);
    expect(verifyProject).toHaveBeenCalledWith(connection, 'ENG', undefined);
  });

  it.each([
    { provider: 'jira-cloud', externalProjectId: '10000', externalProjectKey: 'OLD' },
    { provider: 'jira-cloud', externalProjectKey: 'OLD' },
  ])('verifies the pinned project or legacy key on reconnect: %j', async (existing) => {
    await expect(prepareJiraDelegation({ ...connection, data, existing })).resolves.toEqual(
      delegation,
    );
    expect(verifyProject).toHaveBeenCalledWith(
      connection,
      'ENG',
      existing.externalProjectId || 'OLD',
    );
  });

  it('rejects changing an existing binding to Jira from another provider', async () => {
    await expect(
      prepareJiraDelegation({
        ...connection,
        data,
        existing: { provider: 'github-issues' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(verifyProject).not.toHaveBeenCalled();
  });

  it('rejects a verified connection on a different site', async () => {
    await expect(
      prepareJiraDelegation({
        ...connection,
        data,
        existing: { provider: 'jira-cloud', cloudId: 'original-site' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('preserves provider failures for the caller to handle', async () => {
    const failure = new ProviderError(403, 'Jira project is not accessible');
    vi.mocked(verifyProject).mockRejectedValueOnce(failure);
    await expect(prepareJiraDelegation({ ...connection, data })).rejects.toBe(failure);
  });
});

describe('writeJiraBinding', () => {
  let conn;
  let g;
  beforeAll(() => {
    const partition = `jira-binding-${randomUUID()}`;
    conn = new gremlin.driver.DriverRemoteConnection(
      `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
    );
    g = gremlin.process.AnonymousTraversalSource.traversal()
      .withRemote(conn)
      .withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: partition,
          readPartitions: [partition],
        }),
      );
  });
  afterAll(async () => conn?.close());

  const create = async () => {
    const projectId = randomUUID();
    await g.addV('Project').property('id', projectId).next();
    const binding = await writeJiraBinding(g, {
      projectId,
      data,
      userId: 'admin-a',
      delegation,
    });
    return { projectId, binding };
  };
  const readBindings = async (projectId) =>
    (
      await g
        .V()
        .has('Project', 'id', projectId)
        .out('HAS_TRACKER')
        .flatMap(trackerBindingProjectionStep())
        .toList()
    ).map(mapBinding);

  it('creates one active binding with verified identity and creation history', async () => {
    const { projectId, binding } = await create();
    expect(binding).toEqual({
      id: expect.any(String),
      provider: 'jira-cloud',
      instance: 'cloud',
      externalProjectKey: 'ENG',
      displayName: 'Engineering',
      createdAt: NOW.toISOString(),
      createdBy: 'admin-a',
      ...delegation,
      status: 'active',
      invalidReason: null,
    });
    expect(await readBindings(projectId)).toEqual([{ ...binding, delegatedAt: NOW.toISOString() }]);
  });

  it('reconnects in place, replacing delegation while preserving creation history', async () => {
    const { projectId, binding: existing } = await create();
    await g
      .V()
      .has('TrackerBinding', 'id', existing.id)
      .property(gremlin.process.cardinality.single, 'status', 'invalid')
      .property(gremlin.process.cardinality.single, 'invalid_reason', 'delegator_removed')
      .toList();
    vi.setSystemTime(new Date(NOW.getTime() + 60000));
    const binding = await writeJiraBinding(g, {
      projectId,
      existing,
      data: { ...data, externalProjectKey: 'RENAMED' },
      userId: 'admin-b',
      delegation: { ...delegation, connectionUserId: 'admin-b' },
    });
    expect(binding).toMatchObject({
      id: existing.id,
      createdAt: existing.createdAt,
      createdBy: 'admin-a',
      connectionUserId: 'admin-b',
      externalProjectKey: 'RENAMED',
      status: 'active',
      invalidReason: null,
    });
    expect(await readBindings(projectId)).toEqual([
      { ...binding, delegatedAt: new Date().toISOString() },
    ]);
    expect(
      await g.V().has('TrackerBinding', 'id', existing.id).values('connection_user_id').toList(),
    ).toEqual(['admin-b']);
  });
});
