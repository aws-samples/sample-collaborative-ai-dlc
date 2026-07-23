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

  it('refreshes a near-expiry Bitbucket token (form-encoded, no redirect_uri) and persists it', async () => {
    vi.stubEnv('BITBUCKET_OAUTH_SECRET_NAME', 'test/bitbucket-oauth');
    const bbItem = { userId: 'user-1', provider: 'bitbucket', parameterName: PARAM };
    storeToken({
      accessToken: 'old-bb',
      refreshToken: 'bb-r1',
      expiresAt: Date.now() + 60 * 1000, // inside the safety margin
    });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'bbid', client_secret: 'bbsecret' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh-bb',
        // Bitbucket commonly omits a rotated refresh_token — response has none.
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'account repository pullrequest',
      }),
    }));

    const out = await ensureFreshGitToken({
      ssm,
      secrets,
      ddb,
      item: bbItem,
      gitProvider: 'bitbucket',
    });

    expect(out).toBe('fresh-bb');
    // Correct endpoint + form-urlencoded body, and NO redirect_uri (Bitbucket
    // rejects unknown params on the refresh grant).
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://bitbucket.org/site/oauth2/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = globalThis.fetch.mock.calls[0][1].body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('bb-r1');
    expect(body.get('redirect_uri')).toBeNull();
    // Persisted with Intelligent-Tiering (JWTs exceed the 4096 std cap) and the
    // OLD refresh token retained since the response carried none.
    const put = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put.Tier).toBe('Intelligent-Tiering');
    const persisted = JSON.parse(put.Value);
    expect(persisted.accessToken).toBe('fresh-bb');
    expect(persisted.refreshToken).toBe('bb-r1');
    const ddbPut = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(ddbPut.Item.providerInstance).toBe('bitbucket#public');
  });

  it('does not refresh a Bitbucket token that is well within expiry', async () => {
    const bbItem = { userId: 'user-1', provider: 'bitbucket', parameterName: PARAM };
    storeToken({
      accessToken: 'bb-tok',
      refreshToken: 'bb-r1',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    globalThis.fetch = vi.fn();
    const out = await ensureFreshGitToken({
      ssm,
      secrets,
      ddb,
      item: bbItem,
      gitProvider: 'bitbucket',
    });
    expect(out).toBe('bb-tok');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes of the same connection into one GitLab call', async () => {
    storeToken({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ access_token: 'fresh', refresh_token: 'r2', token_type: 'bearer' }),
    }));

    const [a, b] = await Promise.all([
      ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' }),
      ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' }),
    ]);

    expect(a).toBe('fresh');
    expect(b).toBe('fresh');
    // One-time-use refresh token: a second GitLab call would have failed with
    // invalid_grant. Single-flight must issue exactly one.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('recovers from a lost cross-container refresh race via the rotated stored pair', async () => {
    // First read returns the stale pair; after the (losing) refresh fails with
    // invalid_grant, the re-read returns the pair the winning container saved.
    let reads = 0;
    ssmMock.on(GetParameterCommand).callsFake(() => {
      reads += 1;
      const value =
        reads === 1
          ? { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 }
          : { accessToken: 'winner', refreshToken: 'r2', expiresAt: Date.now() + 7200000 };
      return { Parameter: { Value: JSON.stringify(value) } };
    });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    globalThis.fetch = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }));

    const out = await ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' });
    expect(out).toBe('winner');
  });

  it('still throws invalid_grant when the stored pair did not rotate (genuine revocation)', async () => {
    storeToken({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    globalThis.fetch = vi.fn(async () => ({
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }));

    await expect(
      ensureFreshGitToken({ ssm, secrets, ddb, item: ITEM, gitProvider: 'gitlab' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REFRESH_FAILED' });
  });

  it('staleToken forces a refresh of a not-yet-expired token', async () => {
    storeToken({ accessToken: 'rejected', refreshToken: 'r1', expiresAt: Date.now() + 3600000 });
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
    ssmMock.on(PutParameterCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ access_token: 'fresh', refresh_token: 'r2', token_type: 'bearer' }),
    }));

    const out = await ensureFreshGitToken({
      ssm,
      secrets,
      ddb,
      item: ITEM,
      gitProvider: 'gitlab',
      staleToken: 'rejected',
    });
    expect(out).toBe('fresh');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('staleToken returns the stored token without refreshing when it already rotated', async () => {
    storeToken({ accessToken: 'already-new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 });
    globalThis.fetch = vi.fn();
    const out = await ensureFreshGitToken({
      ssm,
      secrets,
      ddb,
      item: ITEM,
      gitProvider: 'gitlab',
      staleToken: 'rejected',
    });
    expect(out).toBe('already-new');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('getInstallationToken', () => {
  let getInstallationToken;
  const app = { appId: '12345', installationId: '67890' };
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
    await expect(getInstallationToken({ secrets, ...app })).rejects.toThrow(
      /repositories array is required/,
    );
  });

  it('throws when repositories array is empty (fail-closed)', async () => {
    await expect(getInstallationToken({ secrets, ...app, repositories: [] })).rejects.toThrow(
      /repositories array is required/,
    );
  });

  it('does not fall back to global installation environment variables', async () => {
    vi.stubEnv('GITHUB_APP_ID', '12345');
    vi.stubEnv('GITHUB_INSTALLATION_ID', '67890');
    await expect(getInstallationToken({ secrets, repositories: ['org/repo'] })).rejects.toThrow(
      /appId and installationId are required/,
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
      getInstallationToken({ secrets, ...app, repositories: ['other-org/repo'] }),
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

    const token = await getInstallationToken({
      secrets,
      ...app,
      repositories: ['my-org/my-repo'],
    });
    expect(token).toBe('ghs_abc');
    // Verify the mint call used short repo names
    const mintCall = globalThis.fetch.mock.calls.find((c) => c[0].includes('/access_tokens'));
    const mintBody = JSON.parse(mintCall[1].body);
    expect(mintBody.repositories).toEqual(['my-repo']);
    // Default permissions applied
    expect(mintBody.permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
    });
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
      ...app,
      repositories: ['org/repo'],
      permissions: { contents: 'read' },
    });
    const mintCall = globalThis.fetch.mock.calls.find((c) => c[0].includes('/access_tokens'));
    const mintBody = JSON.parse(mintCall[1].body);
    expect(mintBody.permissions).toEqual({ contents: 'read' });
  });
});

describe('validateGitHubAppInstallation', () => {
  let validateGitHubAppInstallation;
  const app = { appId: '12345', installationId: '67890' };
  const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const stubInstallation = (permissions) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ account: { login: 'my-org' }, permissions }),
    }));
  };

  beforeEach(async () => {
    secretsMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', 'test/app-key');
    vi.resetModules();
    ({ validateGitHubAppInstallation } = await import('../git-token.js'));
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ privateKey: testPrivateKeyPem }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('throws when a required permission is missing', async () => {
    stubInstallation({ pull_requests: 'write', issues: 'write', metadata: 'read' });
    await expect(
      validateGitHubAppInstallation(secrets, app.appId, app.installationId),
    ).rejects.toThrow(/missing required permissions: contents:write/);
  });

  it('accepts an installation without workflows:write and reports the shortfall', async () => {
    stubInstallation({
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    });
    const validated = await validateGitHubAppInstallation(secrets, app.appId, app.installationId);
    expect(validated.accountLogin).toBe('my-org');
    expect(validated.missingOptionalPermissions).toEqual(['workflows:write']);
  });

  it('reports no optional shortfall when workflows:write is granted', async () => {
    stubInstallation({
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
      issues: 'write',
      metadata: 'read',
    });
    const validated = await validateGitHubAppInstallation(secrets, app.appId, app.installationId);
    expect(validated.missingOptionalPermissions).toEqual([]);
  });
});
