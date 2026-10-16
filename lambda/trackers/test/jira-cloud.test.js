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
    oauthClientId: CLIENT_ID,
    parameterName: PARAM_NAME,
    cloudId: CLOUD_ID,
    baseUrl: `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
    siteHost: SITE_HOST,
    siteName: 'Acme',
    scope: 'read:jira-work read:jira-user write:jira-work offline_access',
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
    expect(url).toContain(
      'scope=read%3Ajira-work+read%3Ajira-user+write%3Ajira-work+offline_access',
    );
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

  it.each([
    [503, 'temporarily_unavailable'],
    [429, 'rate_limited'],
    [401, 'invalid_client'],
  ])('does not request authorization for a %s refresh failure (%s)', async (status, error) => {
    fetchMock.mockResolvedValueOnce(errResponse(status, { error }));
    await expect(
      refreshAccessToken({ clientId: 'cid', clientSecret: 'cs', refreshToken: 'r1' }),
    ).rejects.toMatchObject({ status, extra: { reconnect: false } });
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
      clientId: CLIENT_ID,
      resource: {
        cloudId: CLOUD_ID,
        name: 'Acme',
        host: SITE_HOST,
        scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
      },
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
    });
    const ssmCall = ssmMock.commandCalls(PutParameterCommand)[0];
    expect(ssmCall.args[0].input.Name).toBe('/aidlc/dev/jira-token/user-1');
    expect(ssmCall.args[0].input.Type).toBe('SecureString');
    const ddbCall = ddbMock.commandCalls(PutCommand)[0];
    expect(ddbCall.args[0].input.Item).toMatchObject({
      userId: 'user-1',
      providerInstance: 'jira-cloud#cloud',
      oauthClientId: CLIENT_ID,
      cloudId: CLOUD_ID,
      siteHost: SITE_HOST,
      baseUrl: `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
      scope: 'read:jira-work write:jira-work offline_access',
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

  describe('OAuth client ownership', () => {
    it.each([undefined, 'previous-client'])(
      'requires authorization before using a connection issued to %s',
      async (oauthClientId) => {
        ddbMock
          .on(GetCommand, { TableName: TRACKER_TABLE })
          .resolves(seedConnectionRow({ oauthClientId }));
        await expect(jiraProvider.listExternalProjects(ctx())).rejects.toMatchObject({
          status: 401,
          extra: { reconnect: true },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ssmMock).not.toHaveReceivedCommand(GetParameterCommand);
        expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
      },
    );

    describe.each([
      [
        'listIssues',
        ['PROJ', {}],
        { issues: [issueFixture()], isLast: true },
        { items: [{ resourceId: 'PROJ-42' }] },
      ],
      ['getIssue', ['PROJ', 'PROJ-42'], issueFixture(), { resourceId: 'PROJ-42' }],
      [
        'getIssueDiscussion',
        ['PROJ', 'PROJ-42'],
        { comments: [{ id: '1001', body: adfDoc('Existing comment') }] },
        [{ id: '1001' }],
      ],
      [
        'addIssueComment',
        ['PROJ', 'PROJ-42', 'Delivery complete'],
        { id: '1002', body: adfDoc('Delivery complete') },
        { id: '1002' },
      ],
    ])('existing connection: %s', (method, args, response, expected) => {
      it.each(['valid', 'expired', 'rejected'])(
        'keeps a legacy connection working when the access token is %s',
        async (tokenState) => {
          ddbMock
            .on(GetCommand, { TableName: TRACKER_TABLE })
            .resolves(seedConnectionRow({ oauthClientId: undefined }));
          if (tokenState === 'expired') {
            ssmMock
              .on(GetParameterCommand)
              .resolves(seedTokenParam({ expiresAt: Date.now() - 1000 }));
          }
          if (tokenState === 'rejected') {
            fetchMock.mockResolvedValueOnce(errResponse(401, {}));
          }
          if (tokenState !== 'valid') {
            fetchMock.mockResolvedValueOnce(
              okResponse({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }),
            );
          }
          fetchMock.mockResolvedValueOnce(okResponse(response));

          await expect(jiraProvider[method](ctx(), ...args)).resolves.toMatchObject(expected);
          expect(fetchMock.mock.lastCall[1].headers.Authorization).toBe(
            `Bearer ${tokenState === 'valid' ? ACCESS_TOKEN : 'fresh-at'}`,
          );
          const refreshCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/oauth/token'));
          expect(refreshCalls).toHaveLength(tokenState === 'valid' ? 0 : 1);
          // Refresh must not invent ownership metadata for a legacy grant.
          for (const call of ddbMock.commandCalls(PutCommand)) {
            expect(call.args[0].input.Item.oauthClientId).toBeUndefined();
          }
        },
      );

      it('rejects a known client mismatch before accessing the old tokens', async () => {
        ddbMock
          .on(GetCommand, { TableName: TRACKER_TABLE })
          .resolves(seedConnectionRow({ oauthClientId: 'previous-client' }));
        await expect(jiraProvider[method](ctx(), ...args)).rejects.toMatchObject({
          status: 401,
          extra: { reconnect: true },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ssmMock).not.toHaveReceivedCommand(GetParameterCommand);
      });
    });

    it('authorizes a legacy connection once, then uses it for project listings', async () => {
      ddbMock
        .on(GetCommand, { TableName: TRACKER_TABLE })
        .resolves(seedConnectionRow({ oauthClientId: undefined }));
      await expect(jiraProvider.listExternalProjects(ctx())).rejects.toMatchObject({
        extra: { reconnect: true },
      });
      await persistConnection({
        ...ctx(),
        clientId: CLIENT_ID,
        resource: { cloudId: CLOUD_ID, host: SITE_HOST, name: 'Acme' },
        tokens: { accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 },
      });
      const row = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
      const parameter = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Value;
      ddbMock.on(GetCommand, { TableName: TRACKER_TABLE }).resolves({ Item: row });
      ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: parameter } });
      fetchMock.mockResolvedValue(okResponse({ values: [{ key: 'NEW', name: 'New project' }] }));

      await expect(jiraProvider.listExternalProjects(ctx())).resolves.toEqual([
        { key: 'NEW', displayKey: 'NEW', name: 'New project' },
      ]);
      await jiraProvider.listExternalProjects(ctx());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer new-at');
      expect(fetchMock.mock.calls.every(([url]) => !url.includes('/oauth/token'))).toBe(true);
    });

    it('silently refreshes using a rotated secret when the client ID is unchanged', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ client_id: CLIENT_ID, client_secret: 'rotated-secret' }),
      });
      ssmMock.on(GetParameterCommand).resolves(seedTokenParam({ expiresAt: Date.now() - 1000 }));
      fetchMock
        .mockResolvedValueOnce(
          okResponse({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(okResponse({ values: [] }));

      await expect(jiraProvider.listExternalProjects(ctx())).resolves.toEqual([]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        client_id: CLIENT_ID,
        client_secret: 'rotated-secret',
        refresh_token: REFRESH_TOKEN,
      });
      expect(
        JSON.parse(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Value),
      ).toMatchObject({
        refreshToken: 'new-rt',
      });
      expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item.oauthClientId).toBe(CLIENT_ID);
    });

    it('does not turn a reactive refresh outage into a reauthorization request', async () => {
      fetchMock
        .mockResolvedValueOnce(errResponse(401, {}))
        .mockResolvedValueOnce(errResponse(503, { error: 'temporarily_unavailable' }));
      await expect(jiraProvider.listExternalProjects(ctx())).rejects.toMatchObject({
        status: 503,
        extra: { reconnect: false },
      });
      expect(ssmMock).not.toHaveReceivedCommand(PutParameterCommand);
    });

    it('does not refresh with a different client if the configuration changes mid-request', async () => {
      secretsMock
        .on(GetSecretValueCommand)
        .resolvesOnce({
          SecretString: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
        })
        .resolves({
          SecretString: JSON.stringify({ client_id: 'new-client', client_secret: CLIENT_SECRET }),
        });
      fetchMock.mockResolvedValueOnce(errResponse(401, {}));
      await expect(jiraProvider.listExternalProjects(ctx())).rejects.toMatchObject({
        status: 401,
        extra: { reconnect: true },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ssmMock).not.toHaveReceivedCommand(PutParameterCommand);
    });
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

    const jqlOf = (call) => new URL(call[0]).searchParams.get('jql');

    it('orders by most recently updated', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', {});
      expect(jqlOf(fetchMock.mock.calls[0])).toBe(
        'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
      );
    });

    it('lists every state with state=all', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { state: 'all' });
      expect(jqlOf(fetchMock.mock.calls[0])).not.toContain('statusCategory');
    });

    it('adds a prefix match on summary so part-typed words match', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'auth (sso' });
      expect(jqlOf(fetchMock.mock.calls[0])).toContain(
        '(text ~ "auth (sso" OR summary ~ "auth sso*")',
      );
    });

    it('puts an exact key match first and skips it from the search results', async () => {
      const exact = issueFixture({ key: 'PROJ-7' });
      exact.fields.project = { key: 'PROJ' };
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            issues: [issueFixture({ key: 'PROJ-9' }), issueFixture({ key: 'PROJ-7' })],
            isLast: true,
          }),
        )
        .mockResolvedValueOnce(okResponse(exact));
      const page = await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'proj-7' });
      expect(page.items.map((i) => i.resourceId)).toEqual(['PROJ-7', 'PROJ-9']);
      expect(fetchMock.mock.calls[1][0]).toContain('/rest/api/3/issue/PROJ-7?');
    });

    it('ignores a key match from another project', async () => {
      const other = issueFixture({ key: 'OTHER-7' });
      other.fields.project = { key: 'OTHER' };
      fetchMock
        .mockResolvedValueOnce(okResponse({ issues: [], isLast: true }))
        .mockResolvedValueOnce(okResponse(other));
      const page = await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'OTHER-7' });
      expect(page.items).toEqual([]);
    });

    it('ignores a key that does not exist', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse({ issues: [], isLast: true }))
        .mockResolvedValueOnce(errResponse(404, { errorMessages: ['Issue does not exist'] }));
      const page = await jiraProvider.listIssues(ctx(), 'PROJ', { q: 'PROJ-99999' });
      expect(page.items).toEqual([]);
    });

    it('filters by issue type, using the names the project actually has', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({ issueTypes: [{ name: 'Epic' }, { name: 'Story' }, { name: 'Bug' }] }),
        )
        .mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'TYPES1', { type: 'epic,STORY,Idea' });
      expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/3/project/TYPES1');
      expect(jqlOf(fetchMock.mock.calls[1])).toContain('issuetype in ("Epic", "Story")');
    });

    it('returns an empty page when the project has none of the requested types', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ issueTypes: [{ name: 'Task' }] }));
      const page = await jiraProvider.listIssues(ctx(), 'TYPES2', { type: 'Idea' });
      expect(page).toMatchObject({ items: [], hasNext: false });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('caches project issue types across pages', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse({ issueTypes: [{ name: 'Idea' }] }))
        .mockResolvedValueOnce(okResponse({ issues: [], nextPageToken: 'c2' }))
        .mockResolvedValueOnce(okResponse({ issues: [], isLast: true }));
      await jiraProvider.listIssues(ctx(), 'TYPES3', { type: 'Idea' });
      await jiraProvider.listIssues(ctx(), 'TYPES3', { type: 'Idea', pageToken: 'c2' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(jqlOf(fetchMock.mock.calls[2])).toContain('issuetype in ("Idea")');
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
    it('resolves each media filename by identity rather than attachment order', async () => {
      const description = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Read ' },
              { type: 'mediaInline', attrs: { id: 'media-brief', type: 'file' } },
              { type: 'text', text: ' first.' },
            ],
          },
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'media-results' } }] },
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'media-search' } }] },
        ],
      };
      const cancel = vi.fn().mockResolvedValue(undefined);
      fetchMock.mockResolvedValueOnce(
        okResponse(
          issueFixture({
            fields: {
              description,
              attachment: [
                { id: '101', filename: 'search.png' },
                { id: '102', filename: 'brief.pdf' },
                { id: '103', filename: 'results.png' },
              ],
            },
          }),
        ),
      );
      for (const mediaId of ['media-search', 'media-brief', 'media-results']) {
        fetchMock.mockResolvedValueOnce({
          ...errResponse(
            303,
            {},
            { location: `https://api.media.atlassian.com/file/${mediaId}/binary?token=temporary` },
          ),
          body: { cancel },
        });
      }
      const issue = await jiraProvider.getIssue(ctx(), 'PROJ', 'PROJ-42');
      expect(issue.body).toBe('Read brief.pdf first.\n\nresults.png\n\nsearch.png');
      expect(cancel).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const [url, options] of fetchMock.mock.calls.slice(1)) {
        expect(url).toMatch(
          /^https:\/\/api\.atlassian\.com\/ex\/jira\/cloud-uuid-1\/rest\/api\/3\/attachment\/content\/10[123]\?redirect=true$/,
        );
        expect(options).toMatchObject({ redirect: 'manual', headers: { Range: 'bytes=0-0' } });
      }
    });

    it.each([
      [303, 'https://api.media.atlassian.com/file/prefix-media-brief/binary'],
      [303, 'https://api.media.atlassian.com/file/other/binary?name=media-brief'],
      [303, undefined],
      [200, undefined],
      [403, undefined],
    ])(
      'keeps an unresolved placeholder for a %s response without an exact ID match',
      async (status, location) => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        fetchMock
          .mockResolvedValueOnce(
            okResponse(
              issueFixture({
                fields: {
                  description: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Keep this description.' }],
                      },
                      {
                        type: 'mediaSingle',
                        content: [{ type: 'media', attrs: { id: 'media-brief' } }],
                      },
                    ],
                  },
                  attachment: [{ id: '101', filename: 'unverified.pdf' }],
                },
              }),
            ),
          )
          .mockResolvedValueOnce({
            ...errResponse(status, {}, location ? { location } : {}),
            body: { cancel },
          });
        const issue = await jiraProvider.getIssue(ctx(), 'PROJ', 'PROJ-42');
        expect(issue.body).toBe('Keep this description.\n\n> _Unsupported Jira block: media_');
        expect(cancel).toHaveBeenCalledOnce();
      },
    );

    it('does not assign an ambiguous filename to a media ID', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse(
            issueFixture({
              fields: {
                description: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'mediaInline', attrs: { id: 'shared-media' } }],
                    },
                  ],
                },
                attachment: [
                  { id: '101', filename: 'one.pdf' },
                  { id: '102', filename: 'two.pdf' },
                ],
              },
            }),
          ),
        )
        .mockResolvedValue(
          errResponse(
            303,
            {},
            { location: 'https://api.media.atlassian.com/file/shared-media/binary' },
          ),
        );
      expect((await jiraProvider.getIssue(ctx(), 'PROJ', 'PROJ-42')).body).toBe(
        '> _Unsupported Jira block: mediaInline_',
      );
    });

    it('imports native Jira files with the OAuth attachment API', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            fields: {
              project: { key: 'PROJ' },
              attachment: [
                { id: '100', filename: 'spec.docx', mimeType: 'application/octet-stream', size: 9 },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response('doc-bytes', { headers: { 'content-type': 'application/octet-stream' } }),
        )
        .mockResolvedValueOnce(new Response('', { headers: { 'x-amz-version-id': 'v1' } }));
      const result = await jiraProvider.issueAttachments(ctx(), 'PROJ', 'PROJ-42', {
        attachmentId: '100',
        maxBytes: 100,
        uploadUrl: 'https://artifacts.s3.amazonaws.com/signed',
      });
      expect(result).toMatchObject({ status: 'downloaded', filename: 'spec.docx', size: 9 });
      expect(fetchMock.mock.calls[1][0]).toContain(
        '/rest/api/3/attachment/content/100?redirect=false',
      );
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(fetchMock.mock.calls[2][1].headers).not.toHaveProperty('Authorization');
    });

    it('rejects attachments from a Jira issue outside the bound project', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ fields: { project: { key: 'OTHER' }, attachment: [] } }),
      );
      await expect(jiraProvider.issueAttachments(ctx(), 'PROJ', 'OTHER-1')).rejects.toMatchObject({
        status: 403,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

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
    it('resolves filenames inside comments without replacing their surrounding text', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            comments: [
              {
                id: '1001',
                body: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Use ' },
                        { type: 'mediaInline', attrs: { id: 'comment-media' } },
                        { type: 'text', text: ' as the reference.' },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          okResponse({ fields: { attachment: [{ id: '101', filename: 'reference.pdf' }] } }),
        )
        .mockResolvedValueOnce(
          errResponse(
            303,
            {},
            { location: 'https://api.media.atlassian.com/file/comment-media/binary' },
          ),
        );
      const comments = await jiraProvider.getIssueDiscussion(ctx(), 'PROJ', 'PROJ-42');
      expect(comments[0].body).toBe('Use reference.pdf as the reference.');
      expect(fetchMock.mock.calls[1][0]).toContain('/issue/PROJ-42?fields=attachment');
    });

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

  describe('addIssueComment', () => {
    it('posts an ADF comment and maps the response', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          id: '1002',
          author: { displayName: 'AI-DLC' },
          body: adfDoc('AI-DLC completed the workflow for this task.'),
          created: '2026-08-10T00:00:00.000+0000',
          updated: '2026-08-10T00:00:00.000+0000',
        }),
      );

      const comment = await jiraProvider.addIssueComment(
        ctx(),
        'PROJ',
        'PROJ-42',
        [
          'AI-DLC completed the workflow for this task.',
          '',
          '- Intent: [Login](https://aidlc.example/space/p1/intent/i1)',
          '- Branch: [`feat/login`](https://github.com/acme/app/tree/feat/login)',
          '- Pull requests:',
          '  - `acme/app`: https://github.com/acme/app/pull/7',
        ].join('\n'),
      );

      expect(comment).toMatchObject({ id: '1002', author: { handle: 'AI-DLC' } });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('POST');
      const payload = JSON.parse(init.body);
      expect(payload.body).toMatchObject({ type: 'doc', version: 1 });
      expect(payload.body.content[1]).toEqual({ type: 'paragraph' });
      const bulletList = payload.body.content.find((node) => node.type === 'bulletList');
      expect(bulletList.content).toHaveLength(3);
      expect(bulletList.content[0]).toMatchObject({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: expect.arrayContaining([
              expect.objectContaining({
                text: 'Login',
                marks: [
                  {
                    type: 'link',
                    attrs: { href: 'https://aidlc.example/space/p1/intent/i1' },
                  },
                ],
              }),
            ]),
          },
        ],
      });
      expect(bulletList.content[1].content[0].content).toContainEqual({
        type: 'text',
        text: 'feat/login',
        marks: [
          {
            type: 'link',
            attrs: { href: 'https://github.com/acme/app/tree/feat/login' },
          },
        ],
      });
      const nested = bulletList.content[2].content.find((node) => node.type === 'bulletList');
      expect(nested.content[0].content[0].content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'acme/app', marks: [{ type: 'code' }] }),
          expect.objectContaining({
            text: 'https://github.com/acme/app/pull/7',
            marks: [
              {
                type: 'link',
                attrs: { href: 'https://github.com/acme/app/pull/7' },
              },
            ],
          }),
        ]),
      );
    });

    it('keeps multi-repository branches and pull requests under separate list items', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          id: '1003',
          author: { displayName: 'AI-DLC' },
          body: adfDoc('AI-DLC completed the workflow for this task.'),
          created: '2026-08-10T00:00:00.000+0000',
          updated: '2026-08-10T00:00:00.000+0000',
        }),
      );

      await jiraProvider.addIssueComment(
        ctx(),
        'PROJ',
        'PROJ-42',
        [
          'AI-DLC completed the workflow for this task.',
          '',
          '- Branches:',
          '  - `acme/api`: [`aidlc/login`](https://github.com/acme/api/tree/aidlc/login)',
          '  - `acme/web`: [`aidlc/login`](https://github.com/acme/web/tree/aidlc/login)',
          '- Pull requests:',
          '  - `acme/api`: https://github.com/acme/api/pull/7',
          '  - `acme/web`: https://github.com/acme/web/pull/8',
        ].join('\n'),
      );

      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bulletList = payload.body.content.find((node) => node.type === 'bulletList');
      const branches = bulletList.content[0];
      const pullRequests = bulletList.content[1];
      expect(branches.content[0].content[0].text).toBe('Branches:');
      expect(branches.content[1].content).toHaveLength(2);
      expect(pullRequests.content[0].content[0].text).toBe('Pull requests:');
      expect(pullRequests.content[1].content).toHaveLength(2);
      expect(pullRequests.content[1].content[0].content[0].content).toContainEqual(
        expect.objectContaining({ text: 'https://github.com/acme/api/pull/7' }),
      );
    });

    it('requires reconnect before writing with a legacy read-only grant', async () => {
      ddbMock
        .on(GetCommand, { TableName: TRACKER_TABLE })
        .resolves(seedConnectionRow({ scope: 'read:jira-work read:jira-user offline_access' }));

      await expect(
        jiraProvider.addIssueComment(ctx(), 'PROJ', 'PROJ-42', 'Delivery complete'),
      ).rejects.toMatchObject({
        status: 403,
        code: 'MISSING_SCOPES',
        extra: { reconnect: true },
      });
      expect(fetchMock).not.toHaveBeenCalled();
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

    const projectPage = (from, count, extra = {}) =>
      okResponse({
        values: Array.from({ length: count }, (_, i) => ({
          key: `P${from + i}`,
          name: `Project ${from + i}`,
          projectTypeKey: (from + i) % 2 ? 'product_discovery' : 'software',
        })),
        ...extra,
      });
    const startAtOf = (call) => Number(new URL(call[0]).searchParams.get('startAt'));

    it('makes one call when the first page is the last', async () => {
      fetchMock.mockResolvedValueOnce(projectPage(0, 3, { total: 3, isLast: true }));
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toHaveLength(3);
      expect(projects[1]).toEqual({
        key: 'P1',
        name: 'Project 1',
        displayKey: 'P1',
        projectTypeKey: 'product_discovery',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(startAtOf(fetchMock.mock.calls[0])).toBe(0);
    });

    it('fetches every page, stepping by the size Jira actually returned', async () => {
      // Jira caps this page at 50 even though 100 were asked for.
      fetchMock.mockImplementation(async (url) => {
        const startAt = Number(new URL(url).searchParams.get('startAt'));
        const count = Math.min(50, 230 - startAt);
        return projectPage(startAt, count, { total: 230, isLast: startAt + count >= 230 });
      });
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toHaveLength(230);
      expect(projects.at(-1).key).toBe('P229');
      expect(fetchMock.mock.calls.map(startAtOf)).toEqual([0, 50, 100, 150, 200]);
    });

    it('stops at the cap when Jira omits total', async () => {
      fetchMock.mockImplementation(async (url) => {
        const startAt = Number(new URL(url).searchParams.get('startAt'));
        return projectPage(startAt, 100, { isLast: false });
      });
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(projects).toHaveLength(2000);
    });

    it('follows each response when Jira lowers the page size after page 1', async () => {
      fetchMock.mockImplementation(async (url) => {
        const startAt = Number(new URL(url).searchParams.get('startAt'));
        const limit = startAt === 0 ? 100 : 50;
        const count = Math.min(limit, 230 - startAt);
        return projectPage(startAt, count, {
          startAt,
          maxResults: limit,
          total: 230,
          isLast: startAt + count >= 230,
        });
      });
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(new Set(projects.map((p) => p.key)).size).toBe(230);
      expect(projects.map((p) => p.key)).toContain('P150');
      expect(fetchMock.mock.calls.map(startAtOf)).toEqual([0, 100, 150, 200]);
    });

    it('continues past a short page that has a continuation but no isLast', async () => {
      fetchMock.mockImplementation(async (url) => {
        const startAt = Number(new URL(url).searchParams.get('startAt'));
        const count = Math.min(50, 230 - startAt);
        return projectPage(startAt, count, {
          startAt,
          maxResults: 50,
          total: 230,
          ...(startAt + count < 230 && {
            nextPage: `https://jira/next?startAt=${startAt + count}`,
          }),
        });
      });
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toHaveLength(230);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('stops when a later page reports completion without a total', async () => {
      fetchMock
        .mockResolvedValueOnce(projectPage(0, 100, { isLast: false }))
        .mockResolvedValueOnce(projectPage(100, 40, { isLast: true }));
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toHaveLength(140);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('caps results at 2,000 when the page size does not divide it', async () => {
      fetchMock.mockImplementation(async (url) => {
        const startAt = Number(new URL(url).searchParams.get('startAt'));
        return projectPage(startAt, 60, { startAt, maxResults: 60, isLast: false });
      });
      const projects = await jiraProvider.listExternalProjects(ctx());
      expect(projects).toHaveLength(2000);
      expect(projects.at(-1).key).toBe('P1999');
      expect(fetchMock).toHaveBeenCalledTimes(34);
    });

    it('surfaces a Jira error body', async () => {
      fetchMock.mockResolvedValueOnce(errResponse(403, { errorMessages: ['No access'] }));
      await expect(jiraProvider.listExternalProjects(ctx())).rejects.toMatchObject({
        status: 403,
        message: 'No access',
      });
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
