import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

const TABLE = 'test-git-connections';
const PARAM_NAME = '/aidlc/dev/git-token/user-1';
const TOKEN = 'gho_testtoken';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const baseEvent = (overrides = {}) => ({
  httpMethod: 'GET',
  path: '/github/repos/acme/widgets/issues',
  headers: { origin: 'https://example.com' },
  queryStringParameters: null,
  requestContext: { authorizer: { claims: { sub: 'user-1' } } },
  ...overrides,
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

describe('github-issues handler', () => {
  let fetchMock;

  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    vi.stubEnv('GIT_CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://example.com');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', parameterName: PARAM_NAME } });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessToken: TOKEN }) },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('lists open issues by default with paged response shape', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([issueFixture()]));

    const handler = await loadHandler();
    const res = await handler(baseEvent());

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
    expect(body.items[0]).toMatchObject({ number: 42, title: 'Add login flow', state: 'open' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/issues?per_page=30&page=1&state=open');
  });

  it('forwards page and perPage and clamps perPage to 100', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    const handler = await loadHandler();
    await handler(baseEvent({ queryStringParameters: { page: '3', perPage: '500' } }));

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=3');
  });

  it('parses Link header for hasNext/hasPrev', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([issueFixture()], {
      link: '<https://api.github.com/repos/a/b/issues?page=3>; rel="next", <https://api.github.com/repos/a/b/issues?page=1>; rel="prev"',
    }));
    const handler = await loadHandler();
    const res = await handler(baseEvent({ queryStringParameters: { page: '2' } }));

    const body = JSON.parse(res.body);
    expect(body.hasNext).toBe(true);
    expect(body.hasPrev).toBe(true);
    expect(body.page).toBe(2);
  });

  it('filters out pull requests from the issues list', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([
      issueFixture({ number: 1, title: 'Real issue' }),
      issueFixture({ number: 2, title: 'A PR', pull_request: { url: 'x' } }),
    ]));

    const handler = await loadHandler();
    const res = await handler(baseEvent());

    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].number).toBe(1);
  });

  it('honours the state query parameter', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    const handler = await loadHandler();
    await handler(baseEvent({ queryStringParameters: { state: 'closed' } }));

    expect(fetchMock.mock.calls[0][0]).toContain('state=closed');
  });

  it('routes to /search/issues with is:issue and returns totalCount', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(
      { items: [issueFixture({ number: 9 })], total_count: 1234 },
    ));
    const handler = await loadHandler();
    const res = await handler(baseEvent({
      queryStringParameters: { q: 'login flow', state: 'open' },
    }));

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
    const handler = await loadHandler();
    await handler(baseEvent());

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

    const handler = await loadHandler();
    const first = await handler(baseEvent());
    const second = await handler(baseEvent());

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).items).toHaveLength(1);
    expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('W/"abc123"');
  });

  it('maps 403 with x-ratelimit-remaining: 0 to 429 with retryAfter', async () => {
    const futureReset = Math.floor(Date.now() / 1000) + 90;
    fetchMock.mockResolvedValueOnce(errResponse(403, { message: 'rate limited' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(futureReset),
    }));

    const handler = await loadHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('rate limit');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(90);
  });

  it('returns 401 when no userId claim is present', async () => {
    const handler = await loadHandler();
    const res = await handler(baseEvent({ requestContext: { authorizer: { claims: {} } } }));
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when GitHub is not connected', async () => {
    ddbMock.on(GetCommand).resolves({});
    const handler = await loadHandler();
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the SSM parameter name is malformed', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', parameterName: '../../etc/passwd' } });
    const handler = await loadHandler();
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty paged result when GitHub responds 404 to the listing', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(404, { message: 'Not Found' }));
    const handler = await loadHandler();
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toEqual([]);
    expect(body.hasNext).toBe(false);
  });

  it('returns mapped issue from the detail endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(issueFixture()));
    const handler = await loadHandler();
    const res = await handler(baseEvent({ path: '/github/repos/acme/widgets/issues/42' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ number: 42, htmlUrl: 'https://github.com/acme/widgets/issues/42' });
  });

  it('returns 404 when the detail endpoint is requested for a PR', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(issueFixture({ pull_request: { url: 'x' } })));
    const handler = await loadHandler();
    const res = await handler(baseEvent({ path: '/github/repos/acme/widgets/issues/42' }));
    expect(res.statusCode).toBe(404);
  });

  it('OPTIONS returns 200 with CORS headers', async () => {
    const handler = await loadHandler();
    const res = await handler(baseEvent({ httpMethod: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('returns 404 for unknown paths', async () => {
    const handler = await loadHandler();
    const res = await handler(baseEvent({ path: '/github/something/else' }));
    expect(res.statusCode).toBe(404);
  });

  describe('comments endpoint', () => {
    const commentFixture = (overrides = {}) => ({
      id: 1001,
      user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
      body: 'I think we should also handle X.',
      created_at: '2026-05-03T00:00:00Z',
      updated_at: '2026-05-03T00:00:00Z',
      ...overrides,
    });

    const commentsEvent = (overrides = {}) =>
      baseEvent({ path: '/github/repos/acme/widgets/issues/42/comments', ...overrides });

    it('returns mapped comments and uses per_page=100', async () => {
      fetchMock.mockResolvedValueOnce(okResponse([
        commentFixture({ id: 1 }),
        commentFixture({ id: 2, body: 'Another point.' }),
      ]));

      const handler = await loadHandler();
      const res = await handler(commentsEvent());

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({
        id: 1,
        user: { login: 'octocat' },
        body: 'I think we should also handle X.',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=100',
      );
    });

    it('returns [] when GitHub responds 404', async () => {
      fetchMock.mockResolvedValueOnce(errResponse(404, { message: 'Not Found' }));
      const handler = await loadHandler();
      const res = await handler(commentsEvent());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it('maps rate-limited response to 429', async () => {
      fetchMock.mockResolvedValueOnce(errResponse(403, { message: 'rate limited' }, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
      }));
      const handler = await loadHandler();
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

      const handler = await loadHandler();
      const first = await handler(commentsEvent());
      const second = await handler(commentsEvent());

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toHaveLength(1);
      expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('W/"c1"');
    });
  });
});
