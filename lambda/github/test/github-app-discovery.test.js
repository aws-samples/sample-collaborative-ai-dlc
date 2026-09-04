// App-credentialed repo discovery for the create-space App path: any
// authenticated user can list App status and installation repositories
// without a personal OAuth connection.

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { generateKeyPairSync } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

const CONFIG_PARAM = '/proj/test/github-app-config';
const KEY_SECRET = 'proj/test/github-app-private-key';

const { privateKey: TEST_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (path, { authenticated = true } = {}) => ({
  httpMethod: 'GET',
  path,
  headers: { origin: 'https://app.example.com' },
  requestContext: {
    authorizer: { claims: authenticated ? { sub: 'member-user' } : {} },
  },
  queryStringParameters: null,
  body: null,
});

const ghRepo = (id, fullName) => ({
  id,
  name: fullName.split('/')[1],
  full_name: fullName,
  private: true,
  default_branch: 'main',
});

const stubApp = ({ appId = '123' } = {}) => {
  ssmMock.on(GetParameterCommand, { Name: CONFIG_PARAM }).resolves({
    Parameter: { Value: JSON.stringify({ appId }) },
  });
  secretsMock
    .on(GetSecretValueCommand, { SecretId: KEY_SECRET })
    .resolves({ SecretString: TEST_PEM });
};

describe('GET /github/app/*', () => {
  beforeEach(() => {
    secretsMock.reset();
    ssmMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', KEY_SECRET);
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('requires authentication', async () => {
    const handler = await loadHandler();
    const res = await handler(makeEvent('/github/app/repos', { authenticated: false }));
    expect(res.statusCode).toBe(401);
  });

  it('reports app status without requiring a personal connection', async () => {
    stubApp({ appId: '123' });
    const handler = await loadHandler();
    const res = await handler(makeEvent('/github/app/status'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ configured: true });
  });

  it('reports unconfigured when no App ID is stored', async () => {
    stubApp({ appId: null });
    const handler = await loadHandler();
    const res = await handler(makeEvent('/github/app/status'));
    expect(JSON.parse(res.body)).toEqual({ configured: false });
  });

  it('409s repo discovery when the App is not configured', async () => {
    stubApp({ appId: null });
    const handler = await loadHandler();
    const res = await handler(makeEvent('/github/app/repos'));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('APP_NOT_CONFIGURED');
  });

  it('lists deduplicated repos across every installation via read tokens', async () => {
    stubApp({ appId: '123' });
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.endsWith('/app/installations?per_page=100&page=1')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 11, account: { login: 'acme' } },
            { id: 22, account: { login: 'globex' } },
          ],
        };
      }
      if (href.includes('/access_tokens')) {
        // Discovery must mint metadata-read tokens only.
        expect(JSON.parse(init.body)).toEqual({ permissions: { metadata: 'read' } });
        const installationId = href.match(/installations\/(\d+)\//)[1];
        return {
          ok: true,
          status: 201,
          json: async () => ({ token: `read-token-${installationId}` }),
        };
      }
      if (href.includes('/installation/repositories')) {
        const token = init.headers.Authorization;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            repositories:
              token === 'Bearer read-token-11'
                ? [ghRepo(1, 'acme/api'), ghRepo(2, 'acme/web')]
                : [ghRepo(3, 'globex/api'), ghRepo(1, 'acme/api')],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });

    const handler = await loadHandler();
    const res = await handler(makeEvent('/github/app/repos'));
    expect(res.statusCode).toBe(200);
    const repos = JSON.parse(res.body);
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/api', 'acme/web', 'globex/api']);
  });
});
