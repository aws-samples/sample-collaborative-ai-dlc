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
const OAUTH_SECRET_NAME = 'test/github-oauth';
const REDIRECT_URI = 'https://app.example.com/github/callback';
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
  item = { userId: USER_ID, provider: 'github', parameterName: `/${SSM_PREFIX}/${USER_ID}` },
) => {
  ddbMock.on(GetCommand).resolves({ Item: item });
};

const mockResolveGitToken = (token = 'ghp_test-token') => {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessToken: token }) },
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

describe('github handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    ssmMock.reset();
    vi.stubEnv('GIT_CONNECTIONS_TABLE', CONNECTIONS_TABLE);
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', PROVIDER_CONNECTIONS_TABLE);
    vi.stubEnv('GITHUB_OAUTH_SECRET_NAME', OAUTH_SECRET_NAME);
    vi.stubEnv('GITHUB_REDIRECT_URI', REDIRECT_URI);
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
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when SecretString is missing', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when SecretString is not valid JSON', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'not-json{' });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when client_id is missing', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ client_secret: 'secret' }),
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('throws OAuthNotConfiguredError when client_secret is empty', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: JSON.stringify({ client_id: 'id', client_secret: '' }),
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
    });

    it('propagates non-ResourceNotFoundException errors', async () => {
      const err = new Error('Access denied');
      err.name = 'AccessDeniedException';
      secretsMock.on(GetSecretValueCommand).rejects(err);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('HMAC state helpers', () => {
    it('createSignedState / verifySignedState round-trip', async () => {
      mockOAuthSecret();
      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.url).toContain('state=');
    });

    it('verifySignedState returns null for tampered signature', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([
        { body: { access_token: 'tok', token_type: 'bearer', scope: 'repo' } },
      ]);

      const state = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      const [data] = state.split('.');
      const tampered = `${data}.${'a'.repeat(64)}`;

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'abc', state: tampered },
        }),
      );

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid or tampered state parameter');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('verifySignedState returns null when state does not have exactly two parts', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([{ body: {} }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'abc', state: 'no-dot-separator' },
        }),
      );

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid or tampered state parameter');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('verifySignedState rejects signature with wrong length (timingSafeEqual buffer mismatch)', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([{ body: {} }]);

      const state = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      const [data] = state.split('.');
      const wrongLength = `${data}.${'ab'}`;

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'abc', state: wrongLength },
        }),
      );

      expect(res.statusCode).toBe(500);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects state payload missing userId field', async () => {
      mockOAuthSecret();
      const fetchMock = mockFetch([{ body: {} }]);

      const state = createSignedState({ ts: Date.now() }, CLIENT_SECRET);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'abc', state },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid or tampered state parameter');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('OPTIONS', () => {
    it('returns 200 with empty body', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('OPTIONS', '/github/anything'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });
  });

  describe('GET /auth', () => {
    it('returns GitHub OAuth URL with signed state', async () => {
      mockOAuthSecret();

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/auth'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.url).toContain('https://github.com/login/oauth/authorize');
      expect(body.url).toContain(`client_id=${CLIENT_ID}`);
      expect(body.url).toContain('state=');
      expect(body.url).toContain(encodeURIComponent(REDIRECT_URI));
      expect(body.url).toContain(encodeURIComponent('repo read:user'));
    });
  });

  describe('GET /callback', () => {
    it('returns 400 when code is missing', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { state: 'something' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing code parameter');
    });

    it('returns 400 when state is missing', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'abc' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing state parameter');
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
        makeEvent('GET', '/github/callback', {
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
          body: { access_token: 'ghp_new', token_type: 'bearer', scope: 'repo' },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'valid-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });

      expect(ssmMock).toHaveReceivedCommandWith(PutParameterCommand, {
        Name: `/${SSM_PREFIX}/${USER_ID}/github`,
        Value: JSON.stringify({ accessToken: 'ghp_new', tokenType: 'bearer' }),
        Type: 'SecureString',
        Overwrite: true,
      });

      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: PROVIDER_CONNECTIONS_TABLE,
        Item: expect.objectContaining({
          userId: USER_ID,
          provider: 'github',
          parameterName: `/${SSM_PREFIX}/${USER_ID}/github`,
          scope: 'repo',
        }),
      });
    });

    it('enriches the connection row with the commit-attribution identity from GET /user', async () => {
      mockOAuthSecret();
      ssmMock.on(PutParameterCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([
        { body: { access_token: 'ghp_new', token_type: 'bearer', scope: 'repo' } },
        // GET /user — private email → noreply fallback.
        { body: { login: 'janedev', id: 123, name: 'Jane Dev', email: null } },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'valid-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: PROVIDER_CONNECTIONS_TABLE,
        Item: expect.objectContaining({
          userId: USER_ID,
          githubLogin: 'janedev',
          authorName: 'Jane Dev',
          authorEmail: '123+janedev@users.noreply.github.com',
        }),
      });
    });

    it('a failed GET /user never breaks the connect flow — the row is stored without author fields', async () => {
      mockOAuthSecret();
      ssmMock.on(PutParameterCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([
        { body: { access_token: 'ghp_new', token_type: 'bearer', scope: 'repo' } },
        { status: 500, body: { message: 'boom' } },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'valid-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
      expect(put.Item.authorEmail).toBeUndefined();
      expect(put.Item.githubLogin).toBeUndefined();
    });

    it('returns 400 when queryStringParameters is null', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: null,
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing code parameter');
    });

    it('falls back to error field when error_description is absent', async () => {
      mockOAuthSecret();
      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([{ body: { error: 'bad_verification_code' } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'bad-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('bad_verification_code');
    });

    it('surfaces GitHub error_description on token exchange failure', async () => {
      mockOAuthSecret();
      const validState = createSignedState({ userId: USER_ID, ts: Date.now() }, CLIENT_SECRET);
      mockFetch([
        {
          body: {
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/callback', {
          queryStringParameters: { code: 'bad-code', state: validState },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('The code passed is incorrect or expired.');
    });
  });

  describe('GET /status', () => {
    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/status', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Unauthorized');
    });

    it('returns connected: true when DynamoDB item exists', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, provider: 'github' },
      });

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/status'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ connected: true, provider: 'github', mode: 'oauth' });
    });

    it('returns connected: false when no DynamoDB item', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/status'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ connected: false, provider: undefined, mode: 'oauth' });
    });
  });

  describe('GET /repos', () => {
    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/repos', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when GitHub not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    });

    it('returns mapped repository list', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [
            {
              id: 1,
              name: 'repo1',
              full_name: 'org/repo1',
              private: false,
              default_branch: 'main',
            },
            {
              id: 2,
              name: 'repo2',
              full_name: 'org/repo2',
              private: true,
              default_branch: 'develop',
            },
          ],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([
        { id: 1, name: 'repo1', fullName: 'org/repo1', private: false, defaultBranch: 'main' },
        { id: 2, name: 'repo2', fullName: 'org/repo2', private: true, defaultBranch: 'develop' },
      ]);
    });

    it('returns 400 when GitHub API returns an error object instead of array', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: 'Bad credentials' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Bad credentials');
    });
  });

  describe('GET /repos/:owner/:repo/branches', () => {
    it('returns branch names', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [{ name: 'main' }, { name: 'develop' }, { name: 'feature/x' }],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/branches'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ branches: ['main', 'develop', 'feature/x'] });
    });

    it('returns empty list when GitHub returns 404', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ status: 404, body: { message: 'Not Found' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/branches'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ branches: [] });
    });

    it('returns 400 when GitHub not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/branches'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    });

    it('includes the repo default branch when available', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        { body: [{ name: 'main' }, { name: 'develop' }] },
        { body: { default_branch: 'develop' } },
      ]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/branches'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        branches: ['main', 'develop'],
        defaultBranch: 'develop',
      });
    });

    it('returns 400 when GitHub returns non-array response', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ status: 200, body: { message: 'Repository access blocked' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/branches'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Repository access blocked');
    });
  });

  describe('GET /repos/:owner/:repo/tree', () => {
    it('returns tree filtered to blobs only', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: {
            tree: [
              { path: 'src/index.js', type: 'blob', sha: 'abc', size: 100 },
              { path: 'src', type: 'tree', sha: 'def', size: 0 },
              { path: 'README.md', type: 'blob', sha: 'ghi', size: 50 },
            ],
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/repos/org/repo/tree', {
          queryStringParameters: { branch: 'main' },
        }),
      );

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tree).toEqual([
        { path: 'src/index.js', sha: 'abc', size: 100 },
        { path: 'README.md', sha: 'ghi', size: 50 },
      ]);
    });

    it('defaults branch to main when not specified', async () => {
      mockGitConnection();
      mockResolveGitToken();
      const fetchMock = mockFetch([{ body: { tree: [] } }]);

      const handler = await loadHandler();
      await handler(makeEvent('GET', '/github/repos/org/repo/tree'));

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/git/trees/main?recursive=1'),
        expect.any(Object),
      );
    });

    it('returns 400 when GitHub returns error message', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: 'Git Repository is empty.' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/tree'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Git Repository is empty.');
    });
  });

  describe('GET /repos/:owner/:repo/contents', () => {
    it('returns base64-decoded file content', async () => {
      mockGitConnection();
      mockResolveGitToken();
      const fileContent = 'console.log("hello");';
      mockFetch([
        {
          body: {
            path: 'src/index.js',
            sha: 'abc123',
            size: fileContent.length,
            content: Buffer.from(fileContent).toString('base64'),
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/repos/org/repo/contents', {
          queryStringParameters: { path: 'src/index.js', branch: 'main' },
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

    it('defaults branch to main when not specified', async () => {
      mockGitConnection();
      mockResolveGitToken();
      const fileContent = 'x';
      const fetchMock = mockFetch([
        {
          body: {
            path: 'f.js',
            sha: 'a',
            size: 1,
            content: Buffer.from(fileContent).toString('base64'),
          },
        },
      ]);

      const handler = await loadHandler();
      await handler(
        makeEvent('GET', '/github/repos/org/repo/contents', {
          queryStringParameters: { path: 'f.js' },
        }),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('?ref=main'),
        expect.any(Object),
      );
    });

    it('returns 400 when path parameter is missing', async () => {
      mockGitConnection();
      mockResolveGitToken();

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/repos/org/repo/contents', {
          queryStringParameters: { branch: 'main' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Missing path parameter');
    });

    it('returns 400 when GitHub returns error message', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: 'Not Found' } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('GET', '/github/repos/org/repo/contents', {
          queryStringParameters: { path: 'nonexistent.js' },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Not Found');
    });
  });

  describe('GET /repos/:owner/:repo/pulls/:n/comments', () => {
    it('merges review and issue comments sorted by createdAt', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: [
            {
              id: 1,
              body: 'review comment',
              user: { login: 'alice', avatar_url: 'http://a' },
              path: 'f.js',
              line: 10,
              created_at: '2024-01-02T00:00:00Z',
              updated_at: '2024-01-02T00:00:00Z',
            },
          ],
        },
        {
          body: [
            {
              id: 2,
              body: 'issue comment',
              user: { login: 'bob', avatar_url: 'http://b' },
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
            },
          ],
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/pulls/42/comments'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.comments).toHaveLength(2);
      expect(body.comments[0].type).toBe('issue');
      expect(body.comments[0].id).toBe(2);
      expect(body.comments[1].type).toBe('review');
      expect(body.comments[1].id).toBe(1);
      expect(body.comments[1].path).toBe('f.js');
      expect(body.comments[1].line).toBe(10);
    });

    it('returns 400 when GitHub not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/pulls/42/comments'));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    });

    it('handles non-array responses from GitHub gracefully', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: 'Not Found' } }, { body: { message: 'Not Found' } }]);

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos/org/repo/pulls/42/comments'));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.comments).toEqual([]);
    });
  });

  describe('POST /repos/:owner/:repo/pulls/:n/comments', () => {
    it('creates an issue comment when path and line are not provided', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        {
          body: {
            id: 99,
            body: 'looks good',
            user: { login: 'alice', avatar_url: 'http://a' },
            created_at: '2024-01-01T00:00:00Z',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({ body: 'looks good' }),
        }),
      );

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(99);
      expect(body.body).toBe('looks good');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/issues/42/comments'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('creates a review comment when path and line are provided', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([
        { body: { head: { sha: 'commit-sha-123' } } },
        {
          body: {
            id: 100,
            body: 'fix this',
            user: { login: 'alice', avatar_url: 'http://a' },
            created_at: '2024-01-01T00:00:00Z',
          },
        },
      ]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({ body: 'fix this', path: 'src/index.js', line: 5 }),
        }),
      );

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(100);

      const fetchCalls = globalThis.fetch.mock.calls;
      expect(fetchCalls[0][0]).toContain('/pulls/42');
      expect(fetchCalls[0][1].method).toBeUndefined();
      expect(fetchCalls[1][0]).toContain('/pulls/42/comments');
      expect(fetchCalls[1][1].method).toBe('POST');
    });

    it('returns 400 when comment body is missing', async () => {
      mockGitConnection();
      mockResolveGitToken();

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({}),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Comment body is required');
    });

    it('returns 400 when PR has no head SHA', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { head: {} } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({ body: 'fix', path: 'f.js', line: 1 }),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Could not determine commit SHA');
    });

    it('returns 400 when GitHub not connected', async () => {
      ddbMock.on(GetCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({ body: 'hi' }),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('GitHub not connected');
    });

    it('returns 400 when GitHub API returns error message on comment creation', async () => {
      mockGitConnection();
      mockResolveGitToken();
      mockFetch([{ body: { message: 'Validation Failed' } }]);

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: JSON.stringify({ body: 'hi' }),
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Validation Failed');
    });

    it('handles null event body gracefully', async () => {
      mockGitConnection();
      mockResolveGitToken();

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('POST', '/github/repos/org/repo/pulls/42/comments', {
          body: null,
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Comment body is required');
    });
  });

  describe('DELETE /disconnect', () => {
    it('deletes SSM parameter and DynamoDB row', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });
      ssmMock.on(DeleteParameterCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/github/disconnect'));

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

    it('swallows SSM deletion errors and still deletes DynamoDB row', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { userId: USER_ID, parameterName: `/${SSM_PREFIX}/${USER_ID}` },
      });
      ssmMock.on(DeleteParameterCommand).rejects(new Error('Parameter not found'));
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/github/disconnect'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });
      expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
        TableName: CONNECTIONS_TABLE,
        Key: { userId: USER_ID },
      });
    });

    it('skips SSM deletion when no parameterName on item', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { userId: USER_ID } });
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/github/disconnect'));

      expect(res.statusCode).toBe(200);
      expect(ssmMock).toHaveReceivedCommandTimes(DeleteParameterCommand, 0);
      expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
        TableName: CONNECTIONS_TABLE,
        Key: { userId: USER_ID },
      });
    });

    it('returns 401 without userId', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('DELETE', '/github/disconnect', {
          authorizer: { claims: {} },
        }),
      );

      expect(res.statusCode).toBe(401);
    });

    it('is a successful no-op when no connection row exists for this provider', async () => {
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('DELETE', '/github/disconnect'));

      expect(res.statusCode).toBe(200);
      expect(ssmMock).toHaveReceivedCommandTimes(DeleteParameterCommand, 0);
      // git-connections is keyed by userId alone; with no GitHub row present we
      // must NOT delete (it could be another provider's row).
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteCommand, 0);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/unknown'));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Not found');
    });
  });

  describe('error handling', () => {
    it('propagates errors with statusCode', async () => {
      mockGitConnection();
      ssmMock.on(GetParameterCommand).rejects(
        Object.assign(new Error('Token expired'), {
          statusCode: 403,
          errorCode: 'TOKEN_EXPIRED',
        }),
      );

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos'));

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Token expired');
      expect(body.code).toBe('TOKEN_EXPIRED');
    });

    it('returns 500 for unexpected errors without statusCode', async () => {
      mockGitConnection();
      ssmMock.on(GetParameterCommand).rejects(new Error('Something broke'));

      const handler = await loadHandler();
      const res = await handler(makeEvent('GET', '/github/repos'));

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Internal server error');
    });
  });

  describe('CORS headers', () => {
    it('includes correct CORS headers on responses', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('OPTIONS', '/github/test'));

      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
      expect(res.headers['Access-Control-Allow-Methods']).toBe('GET,POST,DELETE,OPTIONS');
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    });

    it('uses first allowed origin when request origin does not match', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('OPTIONS', '/github/test', {
          headers: { origin: 'https://evil.com' },
        }),
      );

      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    });
  });

  describe('logging', () => {
    it('redacts sensitive fields from logged event', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const handler = await loadHandler();
      await handler({
        ...makeEvent('OPTIONS', '/github/test'),
        gitToken: 'secret-token',
        code: 'secret-code',
        state: 'secret-state',
        accessToken: 'secret-access',
        body: '{"password": "secret"}',
      });

      const loggedArg = consoleSpy.mock.calls[0][1];
      const logged = JSON.parse(loggedArg);
      expect(logged.gitToken).toBeUndefined();
      expect(logged.code).toBeUndefined();
      expect(logged.state).toBeUndefined();
      expect(logged.accessToken).toBeUndefined();
      expect(logged.body).toBe('[REDACTED]');

      consoleSpy.mockRestore();
    });
  });
});
