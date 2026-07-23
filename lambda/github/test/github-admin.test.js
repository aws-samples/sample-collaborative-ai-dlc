// Platform GitHub credentials coexist: OAuth configuration plus the App
// identity (App ID/private key). Installation IDs are project-bound.

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { generateKeyPairSync } from 'node:crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

const CONFIG_PARAM = '/proj/test/github-app-config';
const KEY_SECRET = 'proj/test/github-app-private-key';
const OAUTH_SECRET = 'proj/test/github-oauth';
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

const makeEvent = (httpMethod, { admin = true, body = null } = {}) => ({
  httpMethod,
  path: '/github/admin/config',
  headers: { origin: 'https://app.example.com' },
  requestContext: {
    authorizer: {
      claims: {
        sub: USER_ID,
        ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
      },
    },
  },
  queryStringParameters: null,
  body,
});

const stubState = ({
  appId = null,
  privateKey = null,
  oauthConfigured = false,
  appIdentity = 'aidlc',
} = {}) => {
  ssmMock.on(GetParameterCommand, { Name: CONFIG_PARAM }).resolves({
    Parameter: { Value: JSON.stringify({ appId }) },
  });
  secretsMock.on(GetSecretValueCommand, { SecretId: KEY_SECRET }).callsFake(async () => {
    if (!privateKey) throw new Error('ResourceNotFoundException');
    return { SecretString: privateKey };
  });
  secretsMock.on(GetSecretValueCommand, { SecretId: OAUTH_SECRET }).callsFake(async () => {
    if (!oauthConfigured) throw new Error('ResourceNotFoundException');
    return {
      SecretString: JSON.stringify({ client_id: 'client', client_secret: 'secret' }),
    };
  });
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 42, slug: appIdentity, name: 'AI-DLC' }),
  }));
};

describe('GET/PUT /github/admin/config', () => {
  beforeEach(() => {
    secretsMock.reset();
    ssmMock.reset();
    delete globalThis.fetch;
    vi.stubEnv('GITHUB_APP_CONFIG_PARAM', CONFIG_PARAM);
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_SECRET_NAME', KEY_SECRET);
    vi.stubEnv('GITHUB_OAUTH_SECRET_NAME', OAUTH_SECRET);
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.com');
    ssmMock.on(PutParameterCommand).resolves({});
    secretsMock.on(PutSecretValueCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('requires a platform admin', async () => {
    const handler = await loadHandler();
    const unauthorized = makeEvent('GET');
    unauthorized.requestContext.authorizer.claims = {};
    expect((await handler(unauthorized)).statusCode).toBe(401);
    expect((await handler(makeEvent('GET', { admin: false }))).statusCode).toBe(403);
  });

  it('returns independent OAuth and App configuration state', async () => {
    stubState({
      appId: '123',
      privateKey: TEST_PEM,
      oauthConfigured: true,
      appIdentity: 'aidlc',
    });
    const handler = await loadHandler();

    const response = await handler(makeEvent('GET'));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      oauthConfigured: true,
      appId: '123',
      privateKeySet: true,
      appConfigured: true,
      appIdentity: 'aidlc[bot]',
    });
  });

  it('reports invalid App credentials without hiding OAuth readiness', async () => {
    stubState({ appId: '123', privateKey: TEST_PEM, oauthConfigured: true });
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Bad credentials' }),
    }));
    const handler = await loadHandler();

    const response = await handler(makeEvent('GET'));
    const body = JSON.parse(response.body);

    expect(body.oauthConfigured).toBe(true);
    expect(body.appConfigured).toBe(false);
    expect(body.appConfigurationError).toContain('Bad credentials');
  });

  it('rejects legacy global mode and installation fields', async () => {
    const handler = await loadHandler();
    for (const update of [{ mode: 'app' }, { installationId: '456' }]) {
      const response = await handler(makeEvent('PUT', { body: JSON.stringify(update) }));
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).code).toBe('PROJECT_BINDING_REQUIRED');
    }
  });

  it('validates App ID and private-key input', async () => {
    const handler = await loadHandler();
    expect(
      (await handler(makeEvent('PUT', { body: JSON.stringify({ appId: 'not-numeric' }) })))
        .statusCode,
    ).toBe(400);
    expect(
      (await handler(makeEvent('PUT', { body: JSON.stringify({ privateKey: 'not-a-pem' }) })))
        .statusCode,
    ).toBe(400);
  });

  it('stores and validates platform App identity without a global installation', async () => {
    let storedAppId = null;
    stubState({ privateKey: TEST_PEM });
    ssmMock.on(GetParameterCommand, { Name: CONFIG_PARAM }).callsFake(async () => ({
      Parameter: { Value: JSON.stringify({ appId: storedAppId }) },
    }));
    ssmMock.on(PutParameterCommand).callsFake(async (input) => {
      storedAppId = JSON.parse(input.Value).appId;
      return {};
    });
    const handler = await loadHandler();

    const response = await handler(
      makeEvent('PUT', {
        body: JSON.stringify({ appId: '123', privateKey: TEST_PEM }),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      appId: '123',
      appConfigured: true,
      appIdentity: 'aidlc[bot]',
    });
    expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
    expect(JSON.parse(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Value)).toEqual({
      appId: '123',
    });
  });

  it('rejects malformed JSON', async () => {
    const handler = await loadHandler();
    expect((await handler(makeEvent('PUT', { body: '{nope' }))).statusCode).toBe(400);
  });
});
