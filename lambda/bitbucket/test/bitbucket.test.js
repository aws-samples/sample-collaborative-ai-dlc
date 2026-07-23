import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const secretsMock = mockClient(SecretsManagerClient);
const { handler } = await import('../index.js');

const adminClaims = {
  requestContext: {
    authorizer: { claims: { sub: 'admin-1', 'cognito:groups': '[platform-admin]' } },
  },
};

const userClaims = {
  requestContext: { authorizer: { claims: { sub: 'user-1' } } },
};

const event = (httpMethod, body, claims = adminClaims) => ({
  httpMethod,
  path: '/bitbucket/oauth-config',
  headers: { origin: 'https://example.com' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  ...claims,
});

beforeEach(() => {
  vi.stubEnv('BITBUCKET_OAUTH_SECRET_NAME', 'bitbucket-oauth');
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://example.com');
  secretsMock.reset();
});

describe('Bitbucket OAuth admin configuration', () => {
  it('returns whether OAuth credentials are configured', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'id', client_secret: 'secret' }),
    });

    const result = await handler(event('GET'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ configured: true });
  });

  it('writes the OAuth credentials to the Bitbucket secret', async () => {
    secretsMock.on(PutSecretValueCommand).resolves({});

    const result = await handler(event('PUT', { clientId: 'id', clientSecret: 'secret' }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ success: true });
    expect(secretsMock.commandCalls(PutSecretValueCommand)[0].args[0].input).toEqual({
      SecretId: 'bitbucket-oauth',
      SecretString: JSON.stringify({ client_id: 'id', client_secret: 'secret' }),
    });
  });

  it('rejects non-admin callers', async () => {
    const result = await handler(
      event('PUT', { clientId: 'id', clientSecret: 'secret' }, userClaims),
    );

    expect(result.statusCode).toBe(403);
    expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it('rejects incomplete credentials', async () => {
    const result = await handler(event('PUT', { clientId: 'id', clientSecret: '' }));

    expect(result.statusCode).toBe(400);
    expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });
});
