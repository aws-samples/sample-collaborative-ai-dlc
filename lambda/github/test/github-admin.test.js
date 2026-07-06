// Platform-admin GitHub configuration endpoints (GET/PUT /github/admin/config)
// — mode switch, App config, private-key writes, and the live installation
// probe that gates any flip to app mode.

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { generateKeyPairSync } from 'node:crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

const MODE_PARAM = '/proj/test/github-auth-mode';
const CONFIG_PARAM = '/proj/test/github-app-config';
const KEY_SECRET = 'proj/test/github-app-private-key';
const USER_ID = 'admin-user';

const { privateKey: TEST_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (httpMethod, { admin = true, body = null, claims: extraClaims = {} } = {}) => ({
  httpMethod,
  path: '/github/admin/config',
  headers: { origin: 'https://app.example.com' },
  requestContext: {
    authorizer: {
      claims: {
        sub: USER_ID,
        ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
        ...extraClaims,
      },
    },
  },
  queryStringParameters: null,
  body,
});

const stubMode = (mode = 'oauth') =>
  ssmMock.on(GetParameterCommand, { Name: MODE_PARAM }).resolves({ Parameter: { Value: mode } });

const stubAppConfig = (appId = null, installationId = null) =>
  ssmMock
    .on(GetParameterCommand, { Name: CONFIG_PARAM })
    .resolves({ Parameter: { Value: JSON.stringify({ appId, installationId }) } });

const stubPrivateKey = (present = true) => {
  if (present) {
    secretsMock
      .on(GetSecretValueCommand, { SecretId: KEY_SECRET })
      .resolves({ SecretString: TEST_PEM });
  } else {
    secretsMock
      .on(GetSecretValueCommand, { SecretId: KEY_SECRET })
      .rejects(new Error('ResourceNotFoundException'));
  }
};

const stubInstallationProbe = (login = 'my-org', ok = true) => {
  globalThis.fetch = vi.fn(async () =>
    ok
      ? { ok: true, json: async () => ({ account: { login } }) }
      : { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) },
  );
};

describe('GET/PUT /github/admin/config', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    ssmMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_AUTH_MODE_PARAM', MODE_PARAM);
    vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', KEY_SECRET);
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.com');
    ssmMock.on(PutParameterCommand).resolves({});
    secretsMock.on(PutSecretValueCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  describe('authorization', () => {
    it('returns 401 without a Cognito sub', async () => {
      const handler = await loadHandler();
      const event = makeEvent('GET');
      event.requestContext.authorizer.claims = {};
      const res = await handler(event);
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for authenticated non-platform-admins (GET and PUT)', async () => {
      const handler = await loadHandler();
      for (const method of ['GET', 'PUT']) {
        const res = await handler(makeEvent(method, { admin: false, body: '{}' }));
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
      }
    });
  });

  describe('GET', () => {
    it('returns the current state (oauth defaults, nothing configured)', async () => {
      stubMode('oauth');
      stubAppConfig();
      stubPrivateKey(false);
      const handler = await loadHandler();
      const res = await handler(makeEvent('GET'));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        mode: 'oauth',
        appId: null,
        installationId: null,
        privateKeySet: false,
        appConfigured: false,
      });
    });

    it('reports a fully configured App', async () => {
      stubMode('app');
      stubAppConfig('123', '456');
      stubPrivateKey(true);
      const handler = await loadHandler();
      const res = await handler(makeEvent('GET'));
      expect(JSON.parse(res.body)).toEqual({
        mode: 'app',
        appId: '123',
        installationId: '456',
        privateKeySet: true,
        appConfigured: true,
      });
    });
  });

  describe('PUT validation', () => {
    it('rejects an invalid mode', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('PUT', { body: JSON.stringify({ mode: 'hybrid' }) }));
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-numeric appId / installationId', async () => {
      const handler = await loadHandler();
      for (const body of [{ appId: 'abc' }, { installationId: '12; DROP' }]) {
        const res = await handler(makeEvent('PUT', { body: JSON.stringify(body) }));
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects a bogus private key', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('PUT', { body: JSON.stringify({ privateKey: 'not-a-pem' }) }),
      );
      expect(res.statusCode).toBe(400);
      expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
    });

    it('rejects switching to app mode without a complete config', async () => {
      stubMode('oauth');
      stubAppConfig(); // no appId/installationId
      stubPrivateKey(false);
      const handler = await loadHandler();
      const res = await handler(makeEvent('PUT', { body: JSON.stringify({ mode: 'app' }) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('APP_CONFIG_INCOMPLETE');
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    });
  });

  describe('PUT writes + probe', () => {
    it('stores the private key and app config, probes, then flips the mode', async () => {
      stubMode('oauth');
      stubAppConfig();
      stubPrivateKey(true); // read-back after the write
      stubInstallationProbe('my-org', true);
      const handler = await loadHandler();

      const res = await handler(
        makeEvent('PUT', {
          body: JSON.stringify({
            mode: 'app',
            appId: '123',
            installationId: '456',
            privateKey: TEST_PEM,
          }),
        }),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.installationAccount).toBe('my-org');

      // Private key persisted
      const keyPuts = secretsMock.commandCalls(PutSecretValueCommand);
      expect(keyPuts).toHaveLength(1);
      expect(keyPuts[0].args[0].input.SecretId).toBe(KEY_SECRET);

      // App config + mode persisted (mode last, only after the probe passed)
      const paramPuts = ssmMock.commandCalls(PutParameterCommand).map((c) => c.args[0].input);
      expect(paramPuts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Name: CONFIG_PARAM }),
          expect.objectContaining({ Name: MODE_PARAM, Value: 'app' }),
        ]),
      );
    });

    it('does NOT flip the mode when the installation probe fails', async () => {
      stubMode('oauth');
      stubAppConfig();
      stubPrivateKey(true);
      stubInstallationProbe('my-org', false);
      const handler = await loadHandler();

      const res = await handler(
        makeEvent('PUT', {
          body: JSON.stringify({
            mode: 'app',
            appId: '123',
            installationId: '456',
            privateKey: TEST_PEM,
          }),
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('APP_CONFIG_INVALID');
      // Mode must not have been written
      const modePuts = ssmMock
        .commandCalls(PutParameterCommand)
        .filter((c) => c.args[0].input.Name === MODE_PARAM);
      expect(modePuts).toHaveLength(0);
    });

    it('switches back to oauth without any probe', async () => {
      stubMode('app');
      stubAppConfig('123', '456');
      stubPrivateKey(true);
      const handler = await loadHandler();

      const res = await handler(makeEvent('PUT', { body: JSON.stringify({ mode: 'oauth' }) }));
      expect(res.statusCode).toBe(200);
      const modePuts = ssmMock
        .commandCalls(PutParameterCommand)
        .filter((c) => c.args[0].input.Name === MODE_PARAM);
      expect(modePuts).toHaveLength(1);
      expect(modePuts[0].args[0].input.Value).toBe('oauth');
      // No GitHub API call happened
      expect(globalThis.fetch).toBeUndefined();
    });

    it('rejects malformed JSON bodies', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('PUT', { body: '{not json' }));
      expect(res.statusCode).toBe(400);
    });
  });
});
