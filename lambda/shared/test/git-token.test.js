import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
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
const ITEM = { userId: 'user-1', parameterName: PARAM };

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
