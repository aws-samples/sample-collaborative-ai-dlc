import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

const NOW = new Date('2026-05-28T00:00:00.000Z');
const PARTITION = `t-${randomUUID()}`;
const GIT_TABLE = 'test-git-connections';
const TRACKER_TABLE = 'test-tracker-connections';
const PARAM_NAME = '/aidlc/dev/git-token/user-1';
const TOKEN = 'gho_testtoken';

let handler;
let resetProviderCache;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', GIT_TABLE);
  vi.stubEnv('TRACKER_CONNECTIONS_TABLE', TRACKER_TABLE);
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://example.com');
  ({ handler } = await import('../index.js'));
  ({ __resetCache: resetProviderCache } = await import('../providers/github-issues.js'));

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

let fetchMock;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ddbMock.reset();
  ssmMock.reset();
  resetProviderCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Default: GitHub is connected and the SSM token resolves cleanly. Tests
  // that need an unconnected user override this on the ddbMock.
  ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({
    Item: { userId: 'user-1', parameterName: PARAM_NAME, createdAt: NOW.toISOString() },
  });
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessToken: TOKEN }) },
  });
  ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({ Items: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const claims = (sub = 'user-1') => ({
  requestContext: { authorizer: { claims: { sub, email: `${sub}@x` } } },
});

const seedProjectAndBinding = async ({
  gitRepo = 'acme/widgets',
  provider = 'github-issues',
  instance = 'public',
} = {}) => {
  const projectId = randomUUID();
  const bindingId = randomUUID();
  const userId = 'user-1';

  // User vertex
  const userExists = await g.V().has('User', 'id', userId).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', userId).property('email', `${userId}@x`).next();
  }
  // Project vertex
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', `P-${projectId.slice(0, 8)}`)
    .property('git_provider', 'github')
    .property('git_repo', gitRepo)
    .property('agent_cli', 'kiro')
    .property('issue_integration_enabled', 'true')
    .property('created_at', NOW.toISOString())
    .next();
  // Owner edge
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', 'owner')
    .to(gremlin.process.statics.V().has('User', 'id', userId))
    .next();
  // Binding
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('TrackerBinding')
    .property('id', bindingId)
    .property('provider', provider)
    .property('instance', instance)
    .property('external_project_key', gitRepo)
    .property('display_name', gitRepo)
    .property('created_at', NOW.toISOString())
    .property('created_by', userId)
    .as('b')
    .addE('HAS_TRACKER')
    .from_('p')
    .to('b')
    .next();
  return { projectId, bindingId };
};

const seedProjectWithRole = async (role, { gitRepo = 'acme/widgets' } = {}) => {
  const projectId = randomUUID();
  const userId = 'user-1';
  const userExists = await g.V().has('User', 'id', userId).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', userId).property('email', `${userId}@x`).next();
  }
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', 'P')
    .property('git_repo', gitRepo)
    .property('created_at', NOW.toISOString())
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', role)
    .to(gremlin.process.statics.V().has('User', 'id', userId))
    .next();
  return projectId;
};

const baseEvent = (overrides = {}) => ({
  httpMethod: 'GET',
  path: '/trackers',
  pathParameters: null,
  headers: { origin: 'https://example.com' },
  queryStringParameters: null,
  ...claims(),
  ...overrides,
});

const makeHeaders = (init = {}) => {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
};

const okResponse = (body, headers = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: makeHeaders(headers),
});
const errResponse = (status, body, headers = {}) => ({
  ok: false,
  status,
  json: async () => body,
  headers: makeHeaders(headers),
});

const issueFixture = (overrides = {}) => ({
  number: 42,
  title: 'Add login flow',
  body: 'We need login.',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/issues/42',
  labels: [{ name: 'enhancement', color: 'a2eeef' }],
  user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
  ...overrides,
});

const commentFixture = (overrides = {}) => ({
  id: 1001,
  user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
  body: 'I think we should also handle X.',
  created_at: '2026-05-03T00:00:00Z',
  updated_at: '2026-05-03T00:00:00Z',
  ...overrides,
});

describe('OPTIONS', () => {
  it('short-circuits with 200 + CORS headers', async () => {
    const res = await handler(baseEvent({ httpMethod: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });
});

describe('Authentication', () => {
  it('returns 401 when no userId claim is present', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/${bindingId}/issues`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Authorization', () => {
  it('returns 403 when caller is not a project member', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/${bindingId}/issues`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      ...claims('intruder'),
    });
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /trackers (unified listing)', () => {
  it('returns the user’s github-issues row from git-connections', async () => {
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([
      expect.objectContaining({ provider: 'github-issues', instance: 'public' }),
    ]);
  });

  it('returns empty list when nothing is connected', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({ Items: [] });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('merges rows from tracker-connections (Phase 3 forward compat)', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({
      Items: [
        {
          userId: 'user-1',
          providerInstance: 'jira-cloud#cloud',
          createdAt: NOW.toISOString(),
          scope: 'read:jira-work',
        },
      ],
    });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([expect.objectContaining({ provider: 'jira-cloud', instance: 'cloud' })]);
  });
});

describe('DELETE /trackers/{provider}/{instance}', () => {
  it('disconnects github-issues by deleting the SSM param + git-connections row', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/github-issues/public',
      pathParameters: { provider: 'github-issues', instance: 'public' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(ssmMock).toHaveReceivedCommand(DeleteParameterCommand);
    expect(ddbMock).toHaveReceivedCommand(DeleteCommand);
  });

  it('returns 400 for unknown provider/instance pair', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Auth/callback stubs', () => {
  it('returns 501 redirect for /trackers/auth/github-issues (real path: /github/auth)', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/github-issues',
      pathParameters: { provider: 'github-issues' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns 404 for unknown provider in auth path', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/bogus',
      pathParameters: { provider: 'bogus' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /projects/{id}/trackers', () => {
  it('lists bindings for the project', async () => {
    const { projectId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'acme/widgets',
    });
  });
});

describe('POST /projects/{id}/trackers', () => {
  it('creates a github-issues binding for an owner with GitHub connected', async () => {
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
        displayName: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      provider: 'github-issues',
      externalProjectKey: 'octo/repo',
      createdBy: 'user-1',
    });
  });

  it('rejects non-owner/admin members with 403', async () => {
    const projectId = await seedProjectWithRole('member');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unknown provider with 400', async () => {
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'jira-cloud',
        instance: 'cloud',
        externalProjectKey: 'PROJ',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when GitHub is not connected', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('GitHub not connected');
  });
});

describe('DELETE /projects/{id}/trackers/{bindingId}', () => {
  it('drops the binding for an owner', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'DELETE',
      path: `/projects/${projectId}/trackers/${bindingId}`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(204);
    // GET should now show no bindings
    const after = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(JSON.parse(after.body)).toEqual([]);
  });
});

describe('GET /projects/{id}/trackers/{bid}/issues (github-issues provider)', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const issuesEvent = (overrides = {}) => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues`,
    pathParameters: { projectId, bindingId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
    ...overrides,
  });

  it('lists open issues by default with paged response shape', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([issueFixture()]));
    const res = await handler(issuesEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      page: 1,
      perPage: 30,
      hasNext: false,
      hasPrev: false,
      totalCount: null,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      resourceId: '42',
      title: 'Add login flow',
      state: 'open',
      resourceType: 'issue',
      author: { handle: 'octocat' },
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/acme/widgets/issues?per_page=30&page=1&state=open',
    );
  });

  it('forwards page and perPage and clamps perPage to 100', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await handler(issuesEvent({ queryStringParameters: { page: '3', perPage: '500' } }));

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=3');
  });

  it('parses Link header for hasNext/hasPrev', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([issueFixture()], {
        link: '<https://api.github.com/repos/a/b/issues?page=3>; rel="next", <https://api.github.com/repos/a/b/issues?page=1>; rel="prev"',
      }),
    );
    const res = await handler(issuesEvent({ queryStringParameters: { page: '2' } }));

    const body = JSON.parse(res.body);
    expect(body.hasNext).toBe(true);
    expect(body.hasPrev).toBe(true);
    expect(body.page).toBe(2);
  });

  it('filters out pull requests from the issues list', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        issueFixture({ number: 1, title: 'Real issue' }),
        issueFixture({ number: 2, title: 'A PR', pull_request: { url: 'x' } }),
      ]),
    );

    const res = await handler(issuesEvent());

    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].resourceId).toBe('1');
  });

  it('honours the state query parameter', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await handler(issuesEvent({ queryStringParameters: { state: 'closed' } }));
    expect(fetchMock.mock.calls[0][0]).toContain('state=closed');
  });

  it('routes to /search/issues with is:issue and returns totalCount', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ items: [issueFixture({ number: 9 })], total_count: 1234 }),
    );
    const res = await handler(
      issuesEvent({ queryStringParameters: { q: 'login flow', state: 'open' } }),
    );

    expect(res.statusCode).toBe(200);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('https://api.github.com/search/issues?q=');
    expect(url).toContain('repo:acme/widgets');
    expect(url).toContain('state:open');
    expect(url).toContain('is:issue');
    expect(url).toContain(encodeURIComponent('login flow'));
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.totalCount).toBe(1234);
  });

  it('sends Authorization: Bearer <token> header', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await handler(issuesEvent());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
  });

  it('caches by ETag and serves cached body on 304', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([issueFixture()], { etag: 'W/"abc123"' }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 304,
      json: async () => ({}),
      headers: makeHeaders({}),
    });

    const first = await handler(issuesEvent());
    const second = await handler(issuesEvent());

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).items).toHaveLength(1);
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('W/"abc123"');
  });

  it('maps 403 with x-ratelimit-remaining: 0 to 429 with retryAfter', async () => {
    const futureReset = Math.floor(Date.now() / 1000) + 90;
    fetchMock.mockResolvedValueOnce(
      errResponse(
        403,
        { message: 'rate limited' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(futureReset),
        },
      ),
    );

    const res = await handler(issuesEvent());

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('rate limit');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(90);
  });

  it('returns 400 when GitHub is not connected', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    const res = await handler(issuesEvent());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the SSM parameter name is malformed', async () => {
    ddbMock
      .on(GetCommand, { TableName: GIT_TABLE })
      .resolves({ Item: { userId: 'user-1', parameterName: '../../etc/passwd' } });
    const res = await handler(issuesEvent());
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty paged result when GitHub responds 404 to the listing', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(404, { message: 'Not Found' }));
    const res = await handler(issuesEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toEqual([]);
    expect(body.hasNext).toBe(false);
  });
});

describe('GET /projects/{id}/trackers/{bid}/issues/{rid}', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const detailEvent = (resourceId = '42') => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}`,
    pathParameters: { projectId, bindingId, resourceId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
  });

  it('returns mapped issue from the detail endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(issueFixture()));
    const res = await handler(detailEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      resourceId: '42',
      resourceUrl: 'https://github.com/acme/widgets/issues/42',
      resourceType: 'issue',
    });
  });

  it('returns 404 when the detail endpoint is requested for a PR', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(issueFixture({ pull_request: { url: 'x' } })));
    const res = await handler(detailEvent());
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /projects/{id}/trackers/{bid}/issues/{rid}/comments', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const commentsEvent = (resourceId = '42') => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}/comments`,
    pathParameters: { projectId, bindingId, resourceId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
  });

  it('returns mapped comments and uses per_page=100', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([commentFixture({ id: 1 }), commentFixture({ id: 2, body: 'Another point.' })]),
    );

    const res = await handler(commentsEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      id: '1',
      author: { handle: 'octocat' },
      body: 'I think we should also handle X.',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=100',
    );
  });

  it('returns [] when GitHub responds 404', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(404, { message: 'Not Found' }));
    const res = await handler(commentsEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('maps rate-limited response to 429', async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(
        403,
        { message: 'rate limited' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
        },
      ),
    );
    const res = await handler(commentsEvent());
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).retryAfter).toBeGreaterThan(0);
  });

  it('uses ETag and serves cached body on 304', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([commentFixture()], { etag: 'W/"c1"' }));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 304,
      json: async () => ({}),
      headers: makeHeaders({}),
    });

    const first = await handler(commentsEvent());
    const second = await handler(commentsEvent());

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toHaveLength(1);
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('W/"c1"');
  });
});

describe('Unknown paths', () => {
  it('returns 404 when no route matches', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/something/else',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });
});
