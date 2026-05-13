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

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const errResponse = (status, body) => ({ ok: false, status, json: async () => body });

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

  it('lists open issues by default', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([issueFixture()]));

    const handler = await loadHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ number: 42, title: 'Add login flow', state: 'open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/widgets/issues?per_page=100&state=open');
  });

  it('filters out pull requests from the issues list', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([
      issueFixture({ number: 1, title: 'Real issue' }),
      issueFixture({ number: 2, title: 'A PR', pull_request: { url: 'x' } }),
    ]));

    const handler = await loadHandler();
    const res = await handler(baseEvent());

    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].number).toBe(1);
  });

  it('honours the state query parameter', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    const handler = await loadHandler();
    await handler(baseEvent({ queryStringParameters: { state: 'closed' } }));

    expect(fetchMock.mock.calls[0][0]).toContain('state=closed');
  });

  it('routes to /search/issues when q is present', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ items: [issueFixture({ number: 9 })] }));
    const handler = await loadHandler();
    const res = await handler(baseEvent({
      queryStringParameters: { q: 'login flow', state: 'open' },
    }));

    expect(res.statusCode).toBe(200);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('https://api.github.com/search/issues?q=');
    expect(url).toContain('repo:acme/widgets');
    expect(url).toContain('state:open');
    expect(url).toContain(encodeURIComponent('login flow'));
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  it('sends Authorization: Bearer <token> header', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]));
    const handler = await loadHandler();
    await handler(baseEvent());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
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

  it('returns empty array when GitHub responds 404 to the listing', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(404, { message: 'Not Found' }));
    const handler = await loadHandler();
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
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
});
