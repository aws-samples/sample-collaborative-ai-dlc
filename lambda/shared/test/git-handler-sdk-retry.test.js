import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { createGitHandler } from '../git-handler.js';
import { createSignedState } from '../git-oauth.js';
import { getProvider } from '../git-providers.js';

const TABLE = 'sdk-retry-review-connections';
const USER = 'review-user';
const SECRET = 'offline-oauth-test-secret';
const PREFIX = 'review/dev/git-token';
const REPLACEMENT_GENERATION = 'a5dde73d-cd0a-4ea3-91d2-a85183a7404c';
const originalDocumentSend = DynamoDBDocumentClient.prototype.send;
const clients = [];

const jsonResponse = (statusCode, body) => ({
  response: {
    statusCode,
    headers: { 'content-type': 'application/x-amz-json-1.0' },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  },
});

// The real DocumentClient serialization, signing, retry middleware and error
// deserialization run against this in-memory HTTP transport. In particular,
// .send() does NOT manufacture a ConditionalCheckFailedException: the installed
// SDK retries the committed HTTP 500 and receives the conditional failure.
const fixture = (providerId, recovery = 'matching') => {
  const requests = [];
  const parameters = new Map();
  let committed;
  let current;
  let putAttempts = 0;
  const replacementPath = `/${PREFIX}/${USER}/${providerId}-${REPLACEMENT_GENERATION}`;
  const requestHandler = {
    handle: vi.fn(async (request) => {
      const operation = request.headers['x-amz-target']?.split('.').at(-1);
      const input = JSON.parse(request.body);
      requests.push({ operation, input, sdkAttempt: request.headers['amz-sdk-request'] });
      expect(input.TableName).toBe(TABLE);

      if (operation === 'GetItem') {
        expect(input.ConsistentRead).toBe(true);
        expect(input.Key).toEqual({
          userId: { S: USER },
          providerInstance: { S: `${providerId}#public` },
        });
        if (committed && recovery === 'read-failure') {
          return jsonResponse(400, {
            __type: 'AccessDeniedException',
            message: 'Simulated recovery read failure',
          });
        }
        return jsonResponse(200, current ? { Item: current } : {});
      }

      if (operation === 'PutItem') {
        putAttempts++;
        expect(input.ConditionExpression).toBe('attribute_not_exists(#key)');
        expect(input.ExpressionAttributeNames['#key']).toBe('userId');
        if (!committed) {
          committed = structuredClone(input.Item);
          current = structuredClone(committed);
          if (recovery === 'different-generation' || recovery === 'different-path') {
            current.generation = { S: REPLACEMENT_GENERATION };
          }
          if (recovery === 'different-path') {
            current.parameterName = { S: replacementPath };
            parameters.set(replacementPath, 'replacement-token-bytes');
          }
          if (recovery === 'deleted') current.status = { S: 'deleted' };
          // The write took effect, but its successful result was not received.
          return jsonResponse(500, {
            __type: 'InternalServerError',
            message: 'Simulated failure after commit',
          });
        }
        // The retried create no longer satisfies the absence condition.
        return jsonResponse(400, {
          __type: 'ConditionalCheckFailedException',
          message: 'The committed row already exists',
        });
      }
      throw new Error(`Unexpected offline DynamoDB operation: ${operation}`);
    }),
  };
  const client = new DynamoDBClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'LOCAL_REVIEW_FAKE',
      secretAccessKey: 'LOCAL_REVIEW_FAKE',
    },
    maxAttempts: 2,
    retryMode: 'standard',
    requestHandler,
  });
  clients.push(client);
  const realDdb = DynamoDBDocumentClient.from(client);
  vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(function (...args) {
    return originalDocumentSend.apply(realDdb, args);
  });
  vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({
    SecretString: JSON.stringify({ client_id: 'offline-client', client_secret: SECRET }),
  });
  const ssmSend = vi.spyOn(SSMClient.prototype, 'send').mockImplementation(async (command) => {
    const { Name, Value, Overwrite } = command.input;
    if (command instanceof PutParameterCommand) {
      expect(Overwrite).toBe(false);
      expect(parameters.has(Name)).toBe(false);
      parameters.set(Name, Value);
      return {};
    }
    if (command instanceof DeleteParameterCommand) {
      parameters.delete(Name);
      return {};
    }
    throw new Error(`Unexpected offline SSM operation: ${command.constructor.name}`);
  });

  const original = getProvider(providerId);
  const provider = {
    ...original,
    getAuthenticatedUser: undefined,
    oauth: {
      ...original.oauth,
      exchangeCode: vi.fn(async () => ({
        accessToken: 'callback-token-bytes',
        tokenType: 'bearer',
        scope: original.oauth.requiredConnectionScopes.join(' '),
      })),
    },
  };
  vi.stubEnv(provider.oauth.secretEnvName, 'offline-secret');
  vi.stubEnv(provider.oauth.redirectUriEnvName, `https://example.test/${providerId}/callback`);
  const handler = createGitHandler(provider, {});
  return {
    requests,
    parameters,
    replacementPath,
    ssmSend,
    committed: () => committed,
    current: () => current,
    putAttempts: () => putAttempts,
    callback: () =>
      handler({
        httpMethod: 'GET',
        path: `/${providerId}/callback`,
        headers: { origin: 'https://example.test' },
        queryStringParameters: {
          code: 'offline-code',
          state: createSignedState({ userId: USER, ts: Date.now() }, SECRET),
        },
      }),
  };
};

const expectRetriedCommitAndRecoveryRead = (f) => {
  expect(f.putAttempts()).toBe(2);
  expect(f.requests.map(({ operation }) => operation)).toEqual([
    'GetItem',
    'PutItem',
    'PutItem',
    'GetItem',
  ]);
  const writes = f.requests.filter(({ operation }) => operation === 'PutItem');
  expect(writes[1].input).toEqual(writes[0].input);
  expect(writes[0].sdkAttempt).toMatch(/\battempt=1\b/);
  expect(writes[1].sdkAttempt).toMatch(/\battempt=2\b/);
  expect(f.committed()).toBeDefined();
};

const tokenDeletes = (f) =>
  f.ssmSend.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof DeleteParameterCommand)
    .map((command) => command.input.Name);

const expectPreservedCallbackToken = (f) => {
  const raw = f.parameters.get(f.committed().parameterName.S);
  expect(JSON.parse(raw).accessToken).toBe('callback-token-bytes');
  expect(tokenDeletes(f)).toEqual([]);
};

const expectConflict = (response) => {
  expect(response.statusCode).toBe(409);
  expect(JSON.parse(response.body)).toMatchObject({ code: 'CONNECTION_CHANGED' });
};

beforeEach(() => {
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', TABLE);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', '');
  vi.stubEnv('GIT_TOKEN_SSM_PREFIX', PREFIX);
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://example.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network access is forbidden in SDK retry regression tests');
    }),
  );
});

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(['github', 'gitlab', 'bitbucket'])(
  '%s callback with real SDK retries',
  (provider) => {
    it('recovers a committed retry as success and preserves its active token', async () => {
      const f = fixture(provider);
      const response = await f.callback();

      expectRetriedCommitAndRecoveryRead(f);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ success: true });
      expect(f.current()).toEqual(f.committed());
      expectPreservedCallbackToken(f);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('preserves token bytes and returns conflict when the recovery read fails', async () => {
      const f = fixture(provider, 'read-failure');
      const response = await f.callback();

      expectRetriedCommitAndRecoveryRead(f);
      expectConflict(response);
      expectPreservedCallbackToken(f);
    });

    it.each(['different-generation', 'deleted'])(
      'never deletes a currently referenced path or reports success for %s',
      async (recovery) => {
        const f = fixture(provider, recovery);
        const response = await f.callback();

        expectRetriedCommitAndRecoveryRead(f);
        expectConflict(response);
        expect(f.current().parameterName).toEqual(f.committed().parameterName);
        expectPreservedCallbackToken(f);
      },
    );

    it('cleans only its own parameter when the strong read identifies a different current path', async () => {
      const f = fixture(provider, 'different-path');
      const response = await f.callback();

      expectRetriedCommitAndRecoveryRead(f);
      expectConflict(response);
      const oldPath = f.committed().parameterName.S;
      expect(tokenDeletes(f)).toEqual([oldPath]);
      expect(f.parameters.has(oldPath)).toBe(false);
      expect(f.parameters.get(f.replacementPath)).toBe('replacement-token-bytes');
      expect(f.current().parameterName.S).toBe(f.replacementPath);
    });
  },
);
