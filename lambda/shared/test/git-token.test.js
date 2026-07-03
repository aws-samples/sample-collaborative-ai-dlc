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
