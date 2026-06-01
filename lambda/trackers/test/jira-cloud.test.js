import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import {
  provider as jiraProvider,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  listAccessibleResources,
  persistConnection,
  ProviderError,
} from '../providers/jira-cloud.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);

const TRACKER_TABLE = 'test-tracker-connections';
const PARAM_NAME = '/aidlc/dev/jira-token/user-1';
const SECRET_NAME = 'jira-oauth';
const CLIENT_ID = 'jira-cid';
const CLIENT_SECRET = 'jira-cs';
const ACCESS_TOKEN = 'jira-at';
const REFRESH_TOKEN = 'jira-rt';
const SITE_HOST = 'acme.atlassian.net';
const CLOUD_ID = 'cloud-uuid-1';

const ctx = () => ({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ssm: new SSMClient({}),
  secrets: new SecretsManagerClient({}),
  userId: 'user-1',
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

const adfDoc = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const issueFixture = (overrides = {}) => ({
  id: '10001',
  key: overrides.key || 'PROJ-42',
  self: 'https://acme.atlassian.net/rest/api/3/issue/PROJ-42',
  fields: {
    summary: 'Add login flow',
    description: adfDoc('We need login.'),
    status: { statusCategory: { key: 'new' } },
    labels: ['enhancement'],
    reporter: {
      displayName: 'Alice',
      accountId: 'a-1',
      avatarUrls: { '48x48': 'https://example.com/a.png' },
    },
    created: '2026-05-01T00:00:00.000+0000',
    updated: '2026-05-02T00:00:00.000+0000',
    ...overrides.fields,
  },
  ...overrides,
});

const seedConnectionRow = (overrides = {}) => ({
  Item: {
    userId: 'user-1',
    providerInstance: 'jira-cloud#cloud',
    parameterName: PARAM_NAME,
    cloudId: CLOUD_ID,
    baseUrl: `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
    siteHost: SITE_HOST,
    siteName: 'Acme',
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  },
});

const seedTokenParam = (overrides = {}) => ({
  Parameter: {
    Value: JSON.stringify({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + 60 * 60 * 1000,
      ...overrides,
    }),
  },
});

describe('jira-cloud — OAuth helpers', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buildAuthorizeUrl includes scopes, redirect, state, prompt', () => {
    const url = buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://app/cb',
      state: 'abc',
    });
    expect(url).toContain('https://auth.atlassian.com/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('audience=api.atlassian.com');
    expect(url).toContain('scope=read%3Ajira-work+read%3Ajira-user+offline_access');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp%2Fcb');
    expect(url).toContain('state=abc');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('response_type=code');
  });

  it('exchangeCode posts authorization_code and returns normalized tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ access_token: 'a', refresh_token: 'r', expires_in: 1800 }),
    );
    const tokens = await exchangeCode({
      clientId: 'cid',
      clientSecret: 'cs',
      redirectUri: 'https://app/cb',
      code: 'xyz',
    });
    expect(tokens).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 1800 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.atlassian.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ grant_type: 'authorization_code', code: 'xyz' });
  });

  it('exchangeCode raises ProviderError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      errResponse(400, { error: 'invalid_grant', error_description: 'bad code' }),
    );
    await expect(
      exchangeCode({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'r', code: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refreshAccessToken posts refresh_token grant and rotates the refresh token', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 1800 }),
    );
    const tokens = await refreshAccessToken({
      clientId: 'cid',
      clientSecret: 'cs',
      refreshToken: 'r1',
    });
    expect(tokens).toEqual({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 1800 });
  });

  it('refreshAccessToken raises a reconnect: true error on failure', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(401, { error: 'invalid_grant' }));
    await expect(
      refreshAccessToken({ clientId: 'cid', clientSecret: 'cs', refreshToken: 'r1' }),
    ).rejects.toMatchObject({ status: 401, extra: { reconnect: true } });
  });

  it('listAccessibleResources maps each site to {cloudId, name, host}', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        { id: 'c-1', name: 'Acme', url: 'https://acme.atlassian.net' },
        { id: 'c-2', name: 'Other', url: 'https://other.atlassian.net' },
      ]),
    );
    const sites = await listAccessibleResources(ACCESS_TOKEN);
    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject({ cloudId: 'c-1', name: 'Acme', host: 'acme.atlassian.net' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe('jira-cloud — persistConnection', () => {
  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    vi.stubEnv('TRACKER_CONNECTIONS_TABLE', TRACKER_TABLE);
    vi.stubEnv('JIRA_TOKEN_SSM_PREFIX', 'aidlc/dev/jira-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes both the SSM SecureString and the tracker-connections row', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand, { TableName: TRACKER_TABLE }).resolves({});
    await persistConnection({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      ssm: new SSMClient({}),
      userId: 'user-1',
      resource: { cloudId: CLOUD_ID, name: 'Acme', host: SITE_HOST },
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
    });
    const ssmCall = ssmMock.commandCalls(PutParameterCommand)[0];
    expect(ssmCall.args[0].input.Name).toBe('/aidlc/dev/jira-token/user-1');
    expect(ssmCall.args[0].input.Type).toBe('SecureString');
    const ddbCall = ddbMock.commandCalls(PutCommand)[0];
    expect(ddbCall.args[0].input.Item).toMatchObject({
      userId: 'user-1',
      providerInstance: 'jira-cloud#cloud',
      cloudId: CLOUD_ID,
      siteHost: SITE_HOST,
      baseUrl: `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
    });
  });
});

describe('jira-cloud — provider methods', () => {
  let fetchMock;

  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    secretsMock.reset();
    vi.stubEnv('TRACKER_CONNECTIONS_TABLE', TRACKER_TABLE);
    vi.stubEnv('JIRA_TOKEN_SSM_PREFIX', 'aidlc/dev/jira-token');
    vi.stubEnv('JIRA_OAUTH_SECRET_NAME', SECRET_NAME);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    ddbMock.on(GetCommand, { TableName: TRACKER_TABLE }).resolves(seedConnectionRow());
    ssmMock.on(GetParameterCommand).resolves(seedTokenParam());
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand, { TableName: TRACKER_TABLE }).resolves({});
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('listIssues', () => {
    it('hits the new /search/jql endpoint, builds open-state JQL by default, and returns mapped issues', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [issueFixture()], isLast: true }));
      const page = await jiraProvider.listIssues(ctx(), 'PROJ', {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        resourceId: 'PROJ-42',
        resourceUrl: `https://${SITE_HOST}/browse/PROJ-42`,
        resourceType: 'issue',
        title: 'Add login flow',
        state: 'open',
        labels: [{ name: 'enhancement' }],
      });
      expect(page.items[0].body).toBe('We need login.');
      // URLSearchParams form-encodes spaces as `+`; convert before
      // decoding so JQL clauses read like the user wrote them.
      const url = decodeURIComponent(fetchMock.mock.calls[0][0].replace(/\+/g, ' '));
      expect(url).toContain('/rest/api/3/search/jql');
      expect(url).toContain('project = "PROJ"');
      expect(url).toContain('statusCategory != Done');
      expect(url).not.toContain('text ~');
      expect(url).not.toContain('startAt=');
      expect(page.hasNext).toBe(false);
      expect(page.totalCount).toBeNull();
    });

    it('builds closed-state JQL with statusCategory = Done', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { state: 'closed' });
      // URLSearchParams form-encodes spaces as `+`; convert before
      // decoding so JQL clauses read like the user wrote them.
      const url = decodeURIComponent(fetchMock.mock.calls[0][0].replace(/\+/g, ' '));
      expect(url).toContain('statusCategory = Done');
    });

    it('appends `text ~ "..."` when q is provided', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'login flow' });
      // URLSearchParams form-encodes spaces as `+`; convert before
      // decoding so JQL clauses read like the user wrote them.
      const url = decodeURIComponent(fetchMock.mock.calls[0][0].replace(/\+/g, ' '));
      expect(url).toContain('text ~ "login flow"');
    });

    it('escapes JQL string literals to prevent injection', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'foo" OR bar' });
      // URLSearchParams form-encodes spaces as `+`; convert before
      // decoding so JQL clauses read like the user wrote them.
      const url = decodeURIComponent(fetchMock.mock.calls[0][0].replace(/\+/g, ' '));
      expect(url).toContain('text ~ "foo\\" OR bar"');
    });

    it('forwards an opaque pageToken cursor when provided', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], nextPageToken: 'cursor-2' }));
      const result = await jiraProvider.listIssues(ctx(), 'PROJ', { pageToken: 'cursor-1' });
      // URLSearchParams form-encodes spaces as `+`; convert before
      // decoding so JQL clauses read like the user wrote them.
      const url = decodeURIComponent(fetchMock.mock.calls[0][0].replace(/\+/g, ' '));
      expect(url).toContain('nextPageToken=cursor-1');
      expect(result.nextPageToken).toBe('cursor-2');
      expect(result.hasNext).toBe(true);
    });

    it('clamps perPage to 100', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { perPage: '500' });
      const url = fetchMock.mock.calls[0][0];
      expect(url).toContain('maxResults=100');
    });

    it('rejects empty externalProjectKey with 400', async () => {
      await expect(jiraProvider.listIssues(ctx(), '', {})).rejects.toMatchObject({ status: 400 });
    });

    it('refreshes the access token on 401 and retries', async () => {
      fetchMock
        .mockResolvedValueOnce(errResponse(401, { errorMessages: ['expired'] }))
        .mockResolvedValueOnce(
          okResponse({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 1800 }),
        )
        .mockResolvedValueOnce(okResponse({ issues: [issueFixture()], isLast: true }));

      const page = await jiraProvider.listIssues(ctx(), 'PROJ', {});
      expect(page.items).toHaveLength(1);
      // 1st call had old token, 3rd retry had new one.
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-at');
    });

    it('raises a reconnect-tagged 401 when refresh itself fails', async () => {
      fetchMock
        .mockResolvedValueOnce(errResponse(401, { errorMessages: ['expired'] }))
        .mockResolvedValueOnce(errResponse(401, { error: 'invalid_grant' }));
      await expect(jiraProvider.listIssues(ctx(), 'PROJ', {})).rejects.toMatchObject({
        status: 401,
        extra: { reconnect: true },
      });
    });

    it('raises a reconnect-tagged 401 when retry after a successful refresh still 401s', async () => {
      // Refresh succeeded but the new access token is still rejected — covers
      // jira-cloud.js:312-314 (the post-refresh re-401 branch). Different from
      // refresh-fails: no invalid_grant on the refresh call.
      fetchMock
        .mockResolvedValueOnce(errResponse(401, { errorMessages: ['expired'] }))
        .mockResolvedValueOnce(
          okResponse({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 1800 }),
        )
        .mockResolvedValueOnce(errResponse(401, { errorMessages: ['still expired'] }));
      await expect(jiraProvider.listIssues(ctx(), 'PROJ', {})).rejects.toMatchObject({
        status: 401,
        extra: { reconnect: true },
      });
      // Retry actually used the refreshed token — proves the refresh ran.
      expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-at');
    });

    it('sets state="closed" when status category is Done', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          issues: [
            issueFixture({
              fields: {
                summary: 'X',
                status: { statusCategory: { key: 'done' } },
                labels: [],
                reporter: { displayName: 'A', avatarUrls: {} },
                created: '',
                updated: '',
              },
            }),
          ],
          isLast: true,
        }),
      );
      const page = await jiraProvider.listIssues(ctx(), 'PROJ', {});
      expect(page.items[0].state).toBe('closed');
    });

    it('throws NOT_CONNECTED when no tracker-connections row exists', async () => {
      ddbMock.on(GetCommand, { TableName: TRACKER_TABLE }).resolves({});
      await expect(jiraProvider.listIssues(ctx(), 'PROJ', {})).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws NOT_CONNECTED when parameterName is missing or malformed', async () => {
      // Parity with the GitHub provider's existing parity check. Defends
      // against a tampered DDB row from injecting an arbitrary SSM path.
      ddbMock
        .on(GetCommand, { TableName: TRACKER_TABLE })
        .resolves(seedConnectionRow({ parameterName: '/etc/passwd' }));
      await expect(jiraProvider.listIssues(ctx(), 'PROJ', {})).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('proactively refreshes when stored expiresAt is in the past', async () => {
      ssmMock.on(GetParameterCommand).resolves(seedTokenParam({ expiresAt: Date.now() - 1000 }));
      fetchMock
        .mockResolvedValueOnce(
          okResponse({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', {});
      expect(fetchMock.mock.calls[0][0]).toBe('https://auth.atlassian.com/oauth/token');
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-at');
    });
  });

  describe('getIssue', () => {
    it('returns the mapped issue', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(issueFixture()));
      const issue = await jiraProvider.getIssue(ctx(), 'PROJ', 'PROJ-42');
      expect(issue).toMatchObject({ resourceId: 'PROJ-42', title: 'Add login flow' });
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/3/issue/PROJ-42');
    });

    it('returns 404 ProviderError when Jira responds 404', async () => {
      fetchMock.mockResolvedValueOnce(errResponse(404, { errorMessages: ['Not found'] }));
      await expect(jiraProvider.getIssue(ctx(), 'PROJ', 'PROJ-99')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('getIssueDiscussion', () => {
    it('maps comments and converts ADF body to markdown', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          comments: [
            {
              id: '1001',
              author: {
                displayName: 'Bob',
                accountId: 'b-1',
                avatarUrls: { '48x48': 'https://example.com/b.png' },
              },
              body: adfDoc('Sounds good.'),
              created: '2026-05-03T00:00:00.000+0000',
              updated: '2026-05-03T00:00:00.000+0000',
            },
          ],
        }),
      );
      const comments = await jiraProvider.getIssueDiscussion(ctx(), 'PROJ', 'PROJ-42');
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: '1001',
        author: { handle: 'Bob' },
        body: 'Sounds good.',
      });
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/3/issue/PROJ-42/comment');
    });

    it('returns [] on 404', async () => {
      fetchMock.mockResolvedValueOnce(errResponse(404, { errorMessages: ['Not found'] }));
      const comments = await jiraProvider.getIssueDiscussion(ctx(), 'PROJ', 'PROJ-99');
      expect(comments).toEqual([]);
    });
  });

  describe('listExternalProjects', () => {
    it('maps Jira project search to {key, name, displayKey}', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          values: [
            { key: 'PROJ', name: 'Project' },
            { key: 'OTHER', name: 'Other Project' },
          ],
        }),
      );
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toEqual([
        { key: 'PROJ', name: 'Project', displayKey: 'PROJ' },
        { key: 'OTHER', name: 'Other Project', displayKey: 'OTHER' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/3/project/search');
    });
  });

  describe('ProviderError export', () => {
    it('shares the same class as the registry', () => {
      expect(typeof ProviderError).toBe('function');
      const err = new ProviderError(400, 'x');
      expect(err.status).toBe(400);
    });
  });
});
