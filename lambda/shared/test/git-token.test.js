import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { resolveGitToken, ensureFreshGitToken } from '../git-token.js';

const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const PARAM = '/proj/dev/git-token/user-1';
const ITEM = { userId: 'user-1', provider: 'gitlab', parameterName: PARAM };

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const storeToken = (value) =>
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify(value) } });

describe('resolveGitToken', () => {
  beforeEach(() => {
    ssmMock.reset();
  });

  it('returns the stored access token', async () => {
    storeToken({ accessToken: 'tok' });
    expect(await resolveGitToken(ssm, ITEM)).toBe('tok');
  });

  it('throws on a malformed parameter name', async () => {
    await expect(resolveGitToken(ssm, { parameterName: 'bad' })).rejects.toThrow(
      /Invalid SSM parameter name/,
    );
  });
});

describe('ensureFreshGitToken', () => {
  beforeEach(() => {
    ssmMock.reset();
    secretsMock.reset();
    ddbMock.reset();
    vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', 'test/gitlab-oauth');
    vi.stubEnv('GIT_CONNECTIONS_TABLE', 'test-git-connections');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'test-git-provider-connections');
    delete globalThis.fetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('is a passthrough for GitHub (tokens never expire)', async () => {
    storeToken({ accessToken: 'gh-tok' });
    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'github' });
    expect(out).toBe('gh-tok');
    expect(globalThis.fetch).toBeUndefined(); // no refresh call
  });

  it('returns the GitLab token unchanged when it is well within expiry', async () => {
    storeToken({
      accessToken: 'gl-tok',
      refreshToken: 'r1',
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h out
    });
    globalThis.fetch = vi.fn();
    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' });
    expect(out).toBe('gl-tok');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refreshes a GitLab token that is near expiry and persists the rotation', async () => {
    vi.stubEnv('GITLAB_REDIRECT_URI', 'https://app.example.com/gitlab/callback');
    storeToken({
      accessToken: 'old',
      refreshToken: 'r1',
      expiresAt: Date.now() + 60 * 1000, // 1min — inside the safety margin
    });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({
        access_token: 'fresh',
        refresh_token: 'r2',
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'api read_user',
      }),
    }));

    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' });

    expect(out).toBe('fresh');
    // GitLab requires redirect_uri on the refresh_token grant — assert it is sent.
    const refreshBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(refreshBody.grant_type).toBe('refresh_token');
    expect(refreshBody.redirect_uri).toBe('https://app.example.com/gitlab/callback');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://gitlab.com/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
    // Rotated token persisted to SSM with a new expiresAt.
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    const persisted = JSON.parse(put.Value);
    expect(persisted.accessToken).toBe('fresh');
    expect(persisted.refreshToken).toBe('r2');
    expect(persisted.expiresAt).toBeGreaterThan(Date.now());
    // Connection metadata persisted to the authoritative composite-key table
    // (userId + providerInstance), NOT the legacy single-key table.
    const ddbPut = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(ddbPut.TableName).toBe('test-git-provider-connections');
    expect(ddbPut.Item.userId).toBe('user-1');
    expect(ddbPut.Item.providerInstance).toBe('gitlab#public');
    expect(ddbPut.Item.scope).toBe('api read_user');
  });

  it('refreshes when no expiresAt is recorded (legacy row)', async () => {
    storeToken({ accessToken: 'old', refreshToken: 'r1' });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ access_token: 'fresh', refresh_token: 'r2', token_type: 'bearer' }),
    }));

    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' });
    expect(out).toBe('fresh');
  });

  it('does not refresh a GitLab row that has no refresh token', async () => {
    storeToken({ accessToken: 'gl-only-access' });
    globalThis.fetch = vi.fn();
    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' });
    expect(out).toBe('gl-only-access');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws when the refresh call returns an OAuth error', async () => {
    storeToken({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ error: 'invalid_grant', error_description: 'refresh token revoked' }),
    }));

    await expect(
      ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' }),
    ).rejects.toThrow(/refresh token revoked/);
  });
});

describe('getInstallationToken', () => {
  let getInstallationToken;
  // Throwaway keypair generated per test run — never a literal PEM in the
  // repo, so secret scanners stay green.
  const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  beforeEach(async () => {
    ssmMock.reset();
    secretsMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', 'test/app-key');
    vi.stubEnv('GITHUB_APP_ID', '12345');
    vi.stubEnv('GITHUB_INSTALLATION_ID', '67890');
    // Re-import to get a fresh module with clean caches.
    vi.resetModules();
    ({ getInstallationToken } = await import('../git-token.js'));
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ privateKey: testPrivateKeyPem }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('throws when repositories array is missing (fail-closed)', async () => {
    await expect(getInstallationToken({ secrets })).rejects.toThrow(
      /repositories array is required/,
    );
  });

  it('throws when repositories array is empty (fail-closed)', async () => {
    await expect(getInstallationToken({ secrets, repositories: [] })).rejects.toThrow(
      /repositories array is required/,
    );
  });

  it('throws when repo owner does not match installation account', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          json: async () => ({
            token: 'ghs_xxx',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      // GET /app/installations/:id → account.login = 'my-org'
      return { ok: true, json: async () => ({ account: { login: 'my-org' } }) };
    });

    await expect(
      getInstallationToken({ secrets, repositories: ['other-org/repo'] }),
    ).rejects.toThrow(/owner does not match installation account/);
  });

  it('mints a token when owner matches (case-insensitive)', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          json: async () => ({
            token: 'ghs_abc',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      return { ok: true, json: async () => ({ account: { login: 'My-Org' } }) };
    });

    const token = await getInstallationToken({ secrets, repositories: ['my-org/my-repo'] });
    expect(token).toBe('ghs_abc');
    // Verify the mint call used short repo names
    const mintCall = globalThis.fetch.mock.calls.find((c) => c[0].includes('/access_tokens'));
    const mintBody = JSON.parse(mintCall[1].body);
    expect(mintBody.repositories).toEqual(['my-repo']);
    // Default permissions applied
    expect(mintBody.permissions).toEqual(
      expect.objectContaining({ contents: 'write', pull_requests: 'write' }),
    );
  });

  it('applies caller-specified permissions when provided', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          json: async () => ({
            token: 'ghs_xyz',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      return { ok: true, json: async () => ({ account: { login: 'org' } }) };
    });

    await getInstallationToken({
      secrets,
      repositories: ['org/repo'],
      permissions: { contents: 'read' },
    });
    const mintCall = globalThis.fetch.mock.calls.find((c) => c[0].includes('/access_tokens'));
    const mintBody = JSON.parse(mintCall[1].body);
    expect(mintBody.permissions).toEqual({ contents: 'read' });
  });
});

// ── mode-aware resolution (platform GitHub auth mode, shared/github-auth-config)

describe('resolveGitHubTokenForMode / getInstallationTokenFromConfig / getInstallationReadToken', () => {
  let gitToken;
  const { privateKey: pem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const MODE_PARAM = '/proj/dev/github-auth-mode';
  const CONFIG_PARAM = '/proj/dev/github-app-config';

  const stubAppConfig = (mode = 'app', appId = '12345', installationId = '67890') => {
    ssmMock.on(GetParameterCommand, { Name: MODE_PARAM }).resolves({ Parameter: { Value: mode } });
    ssmMock
      .on(GetParameterCommand, { Name: CONFIG_PARAM })
      .resolves({ Parameter: { Value: JSON.stringify({ appId, installationId }) } });
  };

  const stubGitHubApi = (login = 'org') => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          json: async () => ({
            token: 'ghs_mode',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      return { ok: true, json: async () => ({ account: { login } }) };
    });
  };

  beforeEach(async () => {
    ssmMock.reset();
    secretsMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', 'test/app-key');
    vi.stubEnv('GITHUB_AUTH_MODE_PARAM', MODE_PARAM);
    vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
    vi.resetModules();
    gitToken = await import('../git-token.js');
    // Explicitly drop module-level caches — the CJS interop can hand the same
    // module instance back across resetModules, and both modules cache reads.
    gitToken.clearAppAuthCaches();
    const authConfig = await import('../github-auth-config.js');
    authConfig.clearGitHubAuthConfigCache();
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ privateKey: pem }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('app mode mints a repo-scoped installation token from the SSM config', async () => {
    stubAppConfig('app');
    stubGitHubApi('org');
    const out = await gitToken.resolveGitHubTokenForMode(
      { ssm, secrets, ddb },
      { userId: 'user-1', repositories: ['org/repo'] },
    );
    expect(out).toEqual({ mode: 'app', token: 'ghs_mode' });
  });

  it('getInstallationTokenFromConfig throws when the App config is incomplete', async () => {
    stubAppConfig('app', null, null);
    await expect(
      gitToken.getInstallationTokenFromConfig({ ssm, secrets, repositories: ['org/repo'] }),
    ).rejects.toThrow(/GitHub App is not configured/);
  });

  it('oauth mode resolves the per-user connection token', async () => {
    vi.stubEnv('GIT_CONNECTIONS_TABLE', 'test-git-connections');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'test-git-provider-connections');
    ssmMock
      .on(GetParameterCommand, { Name: MODE_PARAM })
      .resolves({ Parameter: { Value: 'oauth' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/proj/dev/git-token/user-1' })
      .resolves({ Parameter: { Value: JSON.stringify({ accessToken: 'gho_user' }) } });
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', provider: 'github', parameterName: '/proj/dev/git-token/user-1' },
    });

    const out = await gitToken.resolveGitHubTokenForMode(
      { ssm, secrets, ddb },
      { userId: 'user-1', repositories: ['org/repo'] },
    );
    expect(out).toEqual({ mode: 'oauth', token: 'gho_user' });
  });

  it('oauth mode returns a null token when the user has no connection', async () => {
    vi.stubEnv('GIT_CONNECTIONS_TABLE', 'test-git-connections');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'test-git-provider-connections');
    ssmMock
      .on(GetParameterCommand, { Name: MODE_PARAM })
      .resolves({ Parameter: { Value: 'oauth' } });
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    ddbMock.on(GetCommand).resolves({});

    const out = await gitToken.resolveGitHubTokenForMode(
      { ssm, secrets, ddb },
      { userId: 'user-1' },
    );
    expect(out).toEqual({ mode: 'oauth', token: null });
  });

  it('getInstallationReadToken mints an unscoped metadata:read token', async () => {
    stubAppConfig('app');
    stubGitHubApi('org');
    const token = await gitToken.getInstallationReadToken({ ssm, secrets });
    expect(token).toBe('ghs_mode');
    const mintCall = globalThis.fetch.mock.calls.find((c) => c[0].includes('/access_tokens'));
    const mintBody = JSON.parse(mintCall[1].body);
    // No repositories field (discovery must see all installation repos) and
    // permissions pinned to metadata:read.
    expect(mintBody.repositories).toBeUndefined();
    expect(mintBody.permissions).toEqual({ metadata: 'read' });
  });

  it('clearAppAuthCaches forces a re-mint', async () => {
    stubAppConfig('app');
    stubGitHubApi('org');
    await gitToken.getInstallationReadToken({ ssm, secrets });
    await gitToken.getInstallationReadToken({ ssm, secrets });
    const mintsBefore = globalThis.fetch.mock.calls.filter((c) =>
      c[0].includes('/access_tokens'),
    ).length;
    expect(mintsBefore).toBe(1); // cached
    gitToken.clearAppAuthCaches();
    await gitToken.getInstallationReadToken({ ssm, secrets });
    const mintsAfter = globalThis.fetch.mock.calls.filter((c) =>
      c[0].includes('/access_tokens'),
    ).length;
    expect(mintsAfter).toBe(2);
  });
});
