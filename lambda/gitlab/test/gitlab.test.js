import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  PutParameterCommand,
  DeleteParameterCommand,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';
import crypto from 'crypto';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

const CONNECTIONS_TABLE = 'test-git-connections';
const PROVIDER_CONNECTIONS_TABLE = 'test-git-provider-connections';
const OAUTH_SECRET_NAME = 'test/gitlab-oauth';
const REDIRECT_URI = 'https://app.example.com/gitlab/callback';
const SSM_PREFIX = 'test/git/tokens';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const USER_ID = 'user-123';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (httpMethod, path, overrides = {}) => ({
  httpMethod,
  path,
  headers: overrides.headers || { origin: 'https://app.example.com' },
  requestContext: {
    authorizer: overrides.authorizer ?? { claims: { sub: USER_ID } },
  },
  queryStringParameters: overrides.queryStringParameters || null,
  body: overrides.body || null,
});

const mockOAuthSecret = (clientId = CLIENT_ID, clientSecret = CLIENT_SECRET) => {
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
};

const mockGitConnection = (
  item = { userId: USER_ID, provider: 'gitlab', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
) => {
  ddbMock.on(GetCommand).resolves({ Item: item });
};

const mockResolveGitToken = (token = 'glpat-test-token', refreshToken = 'refresh-123') => {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessToken: token, refreshToken }) },
  });
};

const mockFetch = (responses = []) => {
  const mock = vi.fn();
  let callIndex = 0;
  mock.mockImplementation(() => {
    const res = responses[callIndex] || responses[0];
    callIndex++;
    return Promise.resolve({
      status: res.status || 200,
      ok: (res.status || 200) >= 200 && (res.status || 200) < 300,
      json: () => Promise.resolve(res.body),
    });
  });
  globalThis.fetch = mock;
  return mock;
};

const createSignedState = (payload, secret) => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${hmac}`;
};

describe('gitlab handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    ssmMock.reset();
    vi.stubEnv('GIT_CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', PROVIDER_CONNECTIONS_TABLE);
    vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', OAUTH_SECRET_NAME);
    vi.stubEnv('GITLAB_REDIRECT_URI', REDIRECT_URI);
    vi.stubEnv('GIT_TOKEN_SSM_PREFIX', SSM_PREFIX);
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  describe('getOAuthCredentials', () => {
    it('throws OAuthNotConfiguredError on ResourceNotFoundException', async () => {
      const err = new Error('Not found');
      err.name = 'ResourceNotFoundException';
      secretsMock.on(GetSecretValueCommand).rejects(err);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when SecretString is missing', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when SecretString is not valid JSON', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'not-json{' });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when client_id is missing', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ client_secret: 'secret' }),
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });
  });

  describe('OPTIONS', () => {
    it('returns 200 with empty body', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('OPTIONS', '/gitlab/anything'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });
  });

  describe('GET /auth', () => {
    it('returns GitLab OAuth URL with signed state', async () => {
      mockOAuthSecret();

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/auth'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.url).toContain('https://gitlab.com/oauth/authorize');
      expect(body.url).toContain(`client_id=${CLIENT_ID}`);
      expect(body.url).toContain('state=');
      expect(body.url).toContain('response_type=code');
      expect(body.url).toContain(encodeURIComponent('api read_user'));
    });
  });

  describe('GET /callback', () => {
    it('returns 400 when code is missing', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { state: 'something' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing code parameter');
    });

    it('returns 400 when state is missing', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'abc' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing state parameter');
    });

    it('rejects tampered state signature', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([{ body: {} }]);

      const state = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      const [data] = state.split('.');
      const tampered = `${data}.${'a'.repeat(64)}`;

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'abc', state: tampered },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid or tampered state parameter');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects state older than 10 minutes', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([{ body: {} }]);

      const expiredState = createSignedState(
        { userId: USER_ID, ts: Date.now() - 11 * 60 * 1000 },
        CLIENT_SECRET,
      );

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'abc', state: expiredState },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('OAuth state expired, please try again');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exchanges code for token and stores in SSM + DynamoDB', async () => {
      mockOAuthSecret();
      ssmMock.on(PutParameterCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([
        {
          body: {
            access_token: 'glpat-new',
            refresh_token: 'refresh-new',
            token_type: 'bearer',
            scope: 'api read_user',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'valid-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });

      expect(ssmMock).toHaveReceivedCommandWith(PutParameterCommand, {
        Name: `/${SSM_PREFIX}/${USER_ID}/gitlab`,
        Value: JSON.stringify({
          accessToken: 'glpat-new',
          refreshToken: 'refresh-new',
          tokenType: 'bearer',
        }),
        Type: 'SecureString',
        Overwrite: true,
      });

      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: PROVIDER_CONNECTIONS_TABLE,
        Item: expect.objectContaining({
          userId: USER_ID,
          provider: 'gitlab',
          parameterName: `/${SSM_PREFIX}/${USER_ID}/gitlab`,
          scope: 'api read_user',
        }),
      });
    });

    it('persists expiresAt when the token response includes expires_in', async () => {
      mockOAuthSecret();
      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      ssmMock.on(PutParameterCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      mockFetch([
        {
          body: {
            access_token: 'glpat-new',
            refresh_token: 'refresh-new',
            token_type: 'bearer',
            scope: 'api read_user',
            expires_in: 7200,
          },
        },
      ]);

      const before = Date.now();
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'valid-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(200);
      const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
      const persisted = JSON.parse(put.Value);
      expect(persisted).toMatchObject({
        accessToken: 'glpat-new',
        refreshToken: 'refresh-new',
        tokenType: 'bearer',
      });
      // expiresAt ~= now + 7200s, allowing for test execution time.
      expect(persisted.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000 - 5000);
      expect(persisted.expiresAt).toBeLessThanOrEqual(Date.now() + 7200 * 1000 + 5000);
    });

    it('surfaces GitLab error_description on token exchange failure', async () => {
      mockOAuthSecret();
      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([
        {
          body: {
            error: 'invalid_grant',
            error_description: 'The authorization code has expired.',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/callback', {
          queryStringParameters: { code: 'bad-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('The authorization code has expired.');
    });
  });

  describe('GET /status', () => {
    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/status', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Unauthorized');
    });

    it('returns connected: true when DynamoDB item exists', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, provider: 'gitlab', scope: 'api read_user' },
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/status'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ connected: true, provider: 'gitlab', mode: 'oauth' });
    });

    it('requires reauthorization when the stored token lacks api scope', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, provider: 'gitlab', scope: 'read_user' },
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/status'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        connected: false,
        provider: 'gitlab',
        mode: 'oauth',
        reauthorizationRequired: true,
        missingScopes: ['api'],
      });
    });

    it('returns connected: false when no DynamoDB item', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/status'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ connected: false, provider: undefined, mode: 'oauth' });
    });

    it('returns connected: false when the only connection belongs to GitHub', async () => {
      // The user's only git connection is a legacy GitHub row (keyed by userId
      // alone). It must NOT make GitLab look connected — the store's new-table
      // read (keyed userId+gitlab) misses, and the legacy fallback rejects the
      // github row for a gitlab request.
      ddbMock
        .on(GetCommand, { TableName: PROVIDER_CONNECTIONS_TABLE })
        .resolves({ Item: undefined });
      ddbMock.on(GetCommand, { TableName: CONNECTIONS_TABLE }).resolves({
        Item: { userId: USER_ID, provider: 'github', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/status'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        connected: false,
        provider: undefined,
        mode: 'oauth',
      });
    });

    it('does not use a GitHub connection for GitLab repo listing', async () => {
      ddbMock
        .on(GetCommand, { TableName: PROVIDER_CONNECTIONS_TABLE })
        .resolves({ Item: undefined });
      ddbMock.on(GetCommand, { TableName: CONNECTIONS_TABLE }).resolves({
        Item: { userId: USER_ID, provider: 'github', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/repos'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitLab not connected');
    });

    it('does not delete a GitHub connection on GitLab disconnect', async () => {
      ddbMock
        .on(GetCommand, { TableName: PROVIDER_CONNECTIONS_TABLE })
        .resolves({ Item: undefined });
      ddbMock.on(GetCommand, { TableName: CONNECTIONS_TABLE }).resolves({
        Item: { userId: USER_ID, provider: 'github', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });
      ssmMock.on(DeleteParameterCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/gitlab/disconnect'));

      expect(res.statusCode).toBe(200);
      expect(ssmMock).toHaveReceivedCommandTimes(DeleteParameterCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
    });
  });

  describe('GET /repos', () => {
    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/repos', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when GitLab not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/repos'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitLab not connected');
    });

    it('returns mapped project list', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [
            {
              id: 101,
              name: 'project1',
              path_with_namespace: 'group/project1',
              visibility: 'private',
              default_branch: 'main',
            },
            {
              id: 102,
              name: 'project2',
              path_with_namespace: 'group/project2',
              visibility: 'public',
              default_branch: 'develop',
            },
          ],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/repos'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([
        {
          id: 101,
          name: 'project1',
          fullName: 'group/project1',
          private: true,
          defaultBranch: 'main',
        },
        {
          id: 102,
          name: 'project2',
          fullName: 'group/project2',
          private: false,
          defaultBranch: 'develop',
        },
      ]);
    });

    it('returns 400 when GitLab API returns an error object instead of array', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: '401 Unauthorized' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/repos'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('401 Unauthorized');
    });
  });

  describe('GET /projects/branches?project=', () => {
    it('returns branch names', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [{ name: 'main' }, { name: 'develop' }, { name: 'feature/x' }],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/branches', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ branches: ['main', 'develop', 'feature/x'] });
    });

    it('returns empty list when GitLab returns 404', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ status: 404, body: { message: 'Not Found' } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/branches', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ branches: [] });
    });

    it('returns 400 when GitLab not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/branches', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitLab not connected');
    });

    it('includes the project default branch when available', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        { body: [{ name: 'main' }, { name: 'develop' }] },
        { body: { default_branch: 'develop' } },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/branches', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        branches: ['main', 'develop'],
        defaultBranch: 'develop',
      });
    });

    it('passes the URL-encoded namespaced project path through to the GitLab API', async () => {
      mockGitConnection();
      mockResolveGitToken();
      const fetchMock = mockFetch([{ body: [{ name: 'main' }] }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/branches', {
          queryStringParameters: { project: encodeURIComponent('group/subgroup/widgets') },
        }),
      );

      expect(res.statusCode).toBe(200);
      // The Lambda must URL-encode the namespaced path into the GitLab API path.
      expect(fetchMock.mock.calls[0][0]).toContain(
        `/projects/${encodeURIComponent('group/subgroup/widgets')}/repository/branches`,
      );
    });
  });

  describe('GET /projects/tree?project=', () => {
    it('returns tree filtered to blobs only', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [
            { path: 'src/index.js', type: 'blob', id: 'abc' },
            { path: 'src', type: 'tree', id: 'def' },
            { path: 'README.md', type: 'blob', id: 'ghi' },
          ],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/tree', {
          queryStringParameters: { project: encodeURIComponent('group/widgets'), branch: 'main' },
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tree).toEqual([
        { path: 'src/index.js', sha: 'abc', size: 0 },
        { path: 'README.md', sha: 'ghi', size: 0 },
      ]);
    });

    it('returns 400 when GitLab returns error message', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: '404 Tree Not Found' } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/tree', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('404 Tree Not Found');
    });
  });

  describe('GET /projects/contents?project=', () => {
    it('returns base64-decoded file content', async () => {
      mockGitConnection();
      mockResolveGitToken();
      const fileContent = 'console.log("hello");';
      mockFetch([
        {
          body: {
            file_path: 'src/index.js',
            blob_id: 'abc123',
            size: fileContent.length,
            content: Buffer.from(fileContent).toString('base64'),
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/contents', {
          queryStringParameters: {
            project: encodeURIComponent('group/widgets'),
            path: 'src/index.js',
            branch: 'main',
          },
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        path: 'src/index.js',
        sha: 'abc123',
        size: fileContent.length,
        content: fileContent,
      });
    });

    it('returns 400 when path parameter is missing', async () => {
      mockGitConnection();
      mockResolveGitToken();

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/contents', {
          queryStringParameters: { project: encodeURIComponent('group/widgets'), branch: 'main' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing path parameter');
    });
  });

  describe('GET /projects/merge_requests/:iid/notes?project=', () => {
    it('merges notes and discussion comments sorted by createdAt', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [
            {
              id: 1,
              body: 'general comment',
              system: false,
              author: { username: 'alice', avatar_url: 'http://a' },
              created_at: '2024-01-02T00:00:00Z',
              updated_at: '2024-01-02T00:00:00Z',
            },
          ],
        },
        {
          body: [
            {
              notes: [
                {
                  id: 2,
                  body: 'inline comment',
                  author: { username: 'bob', avatar_url: 'http://b' },
                  position: { new_path: 'f.js', new_line: 10 },
                  created_at: '2024-01-01T00:00:00Z',
                  updated_at: '2024-01-01T00:00:00Z',
                },
              ],
            },
          ],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/merge_requests/42/notes', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.comments).toHaveLength(2);
      expect(body.comments[0].type).toBe('review');
      expect(body.comments[0].id).toBe(2);
      expect(body.comments[0].path).toBe('f.js');
      expect(body.comments[0].line).toBe(10);
      expect(body.comments[1].type).toBe('issue');
      expect(body.comments[1].id).toBe(1);
    });

    it('returns 400 when GitLab not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/gitlab/projects/merge_requests/42/notes', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitLab not connected');
    });
  });

  describe('POST /projects/merge_requests/:iid/notes?project=', () => {
    it('creates a general MR note when path and line are not provided', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: {
            id: 99,
            body: 'looks good',
            author: { username: 'alice', avatar_url: 'http://a' },
            created_at: '2024-01-01T00:00:00Z',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/gitlab/projects/merge_requests/42/notes', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
          body: JSON.stringify({ body: 'looks good' }),
        }),
      );

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(99);
      expect(body.body).toBe('looks good');
    });

    it('returns 400 when comment body is missing', async () => {
      mockGitConnection();
      mockResolveGitToken();

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/gitlab/projects/merge_requests/42/notes', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
          body: JSON.stringify({}),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Comment body is required');
    });

    it('returns 400 when GitLab not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/gitlab/projects/merge_requests/42/notes', {
          queryStringParameters: { project: encodeURIComponent('group/widgets') },
          body: JSON.stringify({ body: 'hi' }),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitLab not connected');
    });
  });

  describe('DELETE /disconnect', () => {
    it('deletes SSM parameter and DynamoDB row', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, provider: 'gitlab', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });
      ssmMock.on(DeleteParameterCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/gitlab/disconnect'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(ssmMock).toHaveReceivedCommandWith(DeleteParameterCommand, {
        Name: `/${SSM_PREFIX}/${USER_ID}`,
      });
      expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
        TableName: CONNECTIONS_TABLE,
        Key: { userId: USER_ID },
      });
    });

    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('DELETE', '/gitlab/disconnect', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/gitlab/unknown'));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Not found');
    });
  });

  describe('CORS headers', () => {
    it('includes correct CORS headers on responses', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('OPTIONS', '/gitlab/test'));

      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
      expect(res.headers['Access-Control-Allow-Methods']).toBe('GET,POST,DELETE,OPTIONS');
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    });
  });
});
