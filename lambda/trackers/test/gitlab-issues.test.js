import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import { getProvider, KNOWN_PROVIDERS } from '../providers/index.js';
import { provider as gitlabIssuesProvider } from '../providers/gitlab-issues.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);

const TABLE = 'test-git-connections';
const PARAM_NAME = '/aidlc/dev/git-token/user-1';
const TOKEN = 'glpat-testtoken';

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

const issueFixture = (overrides = {}) => ({
  iid: 42,
  title: 'Add login flow',
  description: 'We need login.',
  state: 'opened',
  web_url: 'https://gitlab.com/acme/widgets/-/issues/42',
  labels: ['enhancement'],
  author: { username: 'octocat', avatar_url: 'https://example.com/a.png' },
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
  ...overrides,
});

const ctx = () => ({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ssm: new SSMClient({}),
  secrets: new SecretsManagerClient({}),
  userId: 'user-1',
});

describe('gitlab-issues provider — registry', () => {
  it('is registered and resolvable', () => {
    expect(KNOWN_PROVIDERS).toContain('gitlab-issues');
    const p = getProvider('gitlab-issues', 'public');
    expect(p).toBe(gitlabIssuesProvider);
    expect(p.id).toBe('gitlab-issues');
  });

  it('exposes the uniform provider shape', () => {
    const p = getProvider('gitlab-issues', 'public');
    expect(typeof p.listIssues).toBe('function');
    expect(typeof p.getIssue).toBe('function');
    expect(typeof p.getIssueDiscussion).toBe('function');
    expect(typeof p.listExternalProjects).toBe('function');
  });
});

describe('gitlab-issues provider — direct calls', () => {
  let fetchMock;

  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    secretsMock.reset();
    vi.stubEnv('GIT_CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', 'test/gitlab-oauth');
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', provider: 'gitlab', parameterName: PARAM_NAME },
    });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({ accessToken: TOKEN, refreshToken: 'r1' }) },
    });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('listIssues maps GitLab issues to the unified DTO', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([issueFixture()], { 'x-total': '1', 'x-total-pages': '1' }),
    );
    const out = await gitlabIssuesProvider.listIssues(ctx(), 'acme/widgets', { state: 'open' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      resourceId: '42',
      resourceUrl: 'https://gitlab.com/acme/widgets/-/issues/42',
      resourceType: 'issue',
      title: 'Add login flow',
      state: 'open',
      author: { handle: 'octocat' },
    });
    expect(out.items[0].labels).toEqual([{ name: 'enhancement', color: null }]);
    expect(out.totalCount).toBe(1);
    expect(out.hasNext).toBe(false);
  });

  it('listIssues returns an empty page on 404', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
      headers: makeHeaders(),
    });
    const out = await gitlabIssuesProvider.listIssues(ctx(), 'acme/widgets', {});
    expect(out.items).toEqual([]);
    expect(out.hasNext).toBe(false);
  });

  it('getIssue maps a single issue and a closed state', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(issueFixture({ iid: 7, state: 'closed' })));
    const out = await gitlabIssuesProvider.getIssue(ctx(), 'acme/widgets', '7');
    expect(out).toMatchObject({ resourceId: '7', state: 'closed' });
  });

  it('getIssueDiscussion drops system notes and maps the rest', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        { id: 1, body: 'real comment', system: false, author: { username: 'a' }, created_at: 't1' },
        { id: 2, body: 'changed label', system: true, author: { username: 'b' }, created_at: 't2' },
      ]),
    );
    const out = await gitlabIssuesProvider.getIssueDiscussion(ctx(), 'acme/widgets', '42');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: '1', body: 'real comment', author: { handle: 'a' } });
  });

  it('refreshes the token on 401 and retries the request', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csecret' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
        headers: makeHeaders(),
      })
      .mockResolvedValueOnce(okResponse({ access_token: 'newtok', refresh_token: 'r2' })) // token endpoint
      .mockResolvedValueOnce(
        okResponse([issueFixture()], { 'x-total': '1', 'x-total-pages': '1' }),
      );

    const out = await gitlabIssuesProvider.listIssues(ctx(), 'acme/widgets', {});
    expect(out.items).toHaveLength(1);
    // 1st: issues (401), 2nd: token refresh, 3rd: issues retry
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://gitlab.com/oauth/token');
  });

  it('throws NOT_CONNECTED when no git connection row exists', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(gitlabIssuesProvider.listIssues(ctx(), 'acme/widgets', {})).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });

  it('throws NOT_CONNECTED when the connection row is for a different provider', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', provider: 'github', parameterName: PARAM_NAME },
    });
    await expect(gitlabIssuesProvider.getIssue(ctx(), 'acme/widgets', '1')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
  });
});
