import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const membership = vi.hoisted(() => ({ fetchMembershipRole: vi.fn() }));
vi.mock('../../shared/trackers.js', async (importOriginal) => {
  const actual = await importOriginal();
  membership.fetchMembershipRole.mockImplementation(actual.fetchMembershipRole);
  return { ...actual, fetchMembershipRole: membership.fetchMembershipRole };
});

const PARTITION = `t-${randomUUID()}`;
const TABLE = 'process-test';

const ddbMock = mockClient(DynamoDBDocumentClient);
const rows = new Map();

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('GREMLIN_PROTOCOL', 'ws');
  vi.stubEnv('V2_PROCESS_TABLE', TABLE);
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
  await g.V().drop().next();
  rows.clear();
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake(({ Key }) => ({ Item: rows.get(`${Key.pk}|${Key.sk}`) }));
});

const seedMember = async (projectId, sub) => {
  const project = await g.addV('Project').property('id', projectId).next();
  const user = await g.addV('User').property('id', sub).next();
  await g
    .V(project.value.id)
    .addE('HAS_MEMBER')
    .to(gremlin.process.statics.V(user.value.id))
    .property('role', 'member')
    .next();
};

const seedIntent = (intentId, meta) => {
  rows.set(`EXEC#${intentId}|META`, { intentId, ...meta });
};

const methodologyRelease = {
  releaseId: 'aidlc:release-sha',
  sourceSha: 'release-sha',
  importerRevision: 2,
  closureDigest: 'closure-digest',
  catalogKey: 'catalog.json',
  manifestKey: 'manifest.json',
};
const methodologyPins = {
  AGENT: { 'aidlc-architect-agent': { tenantId: 'default', version: 7 } },
};

describe('intent-pin-lookup handler', () => {
  it('returns the minimal projection to a project member', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, {
      projectId,
      workflowId: 'aidlc-v2',
      workflowVersion: 4,
      methodologyRelease,
      methodologyPins,
      // Fields the caller must never receive.
      prompt: 'secret prompt',
      credentialBinding: { source: 'platform' },
    });

    const res = await handler({ sub, projectId, intentId });

    expect(res).toEqual({
      statusCode: 200,
      workflowIntent: {
        id: intentId,
        projectId,
        workflowId: 'aidlc-v2',
        workflowVersion: 4,
        methodologyRelease,
        methodologyPins,
      },
    });
  });

  it('reports an unpinned intent with explicit nulls', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, { projectId, workflowId: 'aidlc-v2', workflowVersion: 4 });

    const res = await handler({ sub, projectId, intentId });

    expect(res.statusCode).toBe(200);
    expect(res.workflowIntent.methodologyRelease).toBeNull();
    expect(res.workflowIntent.methodologyPins).toBeNull();
  });

  it('404s a caller who is not a member of the project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, { projectId, workflowId: 'aidlc-v2', workflowVersion: 4 });

    expect(await handler({ sub: `outsider-${randomUUID()}`, projectId, intentId })).toEqual({
      statusCode: 404,
    });
  });

  it('404s an intent that belongs to another project', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, { projectId: randomUUID(), workflowId: 'aidlc-v2', workflowVersion: 4 });

    expect(await handler({ sub, projectId, intentId })).toEqual({ statusCode: 404 });
  });

  it('404s an intent that does not exist', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    await seedMember(projectId, sub);

    expect(await handler({ sub, projectId, intentId: randomUUID() })).toEqual({ statusCode: 404 });
  });

  // The function has no API Gateway route. An HTTP-shaped event, or forwarded
  // Cognito claims in place of an explicit subject, means something is trying to
  // reach it as if it were the intents API.
  it.each([
    ['a missing subject', { projectId: 'p1', intentId: 'i1' }],
    ['a blank subject', { sub: '  ', projectId: 'p1', intentId: 'i1' }],
    ['a missing project', { sub: 'u1', intentId: 'i1' }],
    ['a missing intent', { sub: 'u1', projectId: 'p1' }],
    ['a non-string intent', { sub: 'u1', projectId: 'p1', intentId: 7 }],
    ['an HTTP method', { sub: 'u1', projectId: 'p1', intentId: 'i1', httpMethod: 'GET' }],
    [
      'forwarded authorizer claims',
      {
        sub: 'u1',
        projectId: 'p1',
        intentId: 'i1',
        requestContext: { authorizer: { claims: { sub: 'u1' } } },
      },
    ],
    ['an empty event', {}],
  ])('400s %s without reading anything', async (_label, event) => {
    membership.fetchMembershipRole.mockClear();

    expect(await handler(event)).toEqual({ statusCode: 400 });
    expect(ddbMock.calls()).toHaveLength(0);
    expect(membership.fetchMembershipRole).not.toHaveBeenCalled();
  });

  it('checks membership in Neptune for a well-formed request', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, { projectId, workflowId: 'aidlc-v2', workflowVersion: 4 });
    membership.fetchMembershipRole.mockClear();

    expect((await handler({ sub, projectId, intentId })).statusCode).toBe(200);
    expect(membership.fetchMembershipRole).toHaveBeenCalledWith(expect.anything(), projectId, sub);
  });

  it('reports a graph failure as a 5xx rather than a 404', async () => {
    const sub = `u-${randomUUID()}`;
    const projectId = randomUUID();
    const intentId = randomUUID();
    await seedMember(projectId, sub);
    seedIntent(intentId, { projectId, workflowId: 'aidlc-v2', workflowVersion: 4 });
    const endpoint = process.env.NEPTUNE_ENDPOINT;
    const port = process.env.GREMLIN_PORT;
    vi.stubEnv('NEPTUNE_ENDPOINT', '127.0.0.1');
    vi.stubEnv('GREMLIN_PORT', '1');
    try {
      const res = await handler({ sub, projectId, intentId });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      vi.stubEnv('NEPTUNE_ENDPOINT', endpoint);
      vi.stubEnv('GREMLIN_PORT', port);
    }
  });
});
