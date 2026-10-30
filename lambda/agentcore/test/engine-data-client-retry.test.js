// Transport retries of the remote process store: reads may be retried by the
// SDK, mutations must reach engine-data exactly once. The default transports
// are exercised for real — a LambdaClient with its retry middleware, sending
// to a local endpoint that answers with a retryable 500 — and, through
// aws-sdk-client-mock, every allowlisted method is checked for the client it
// is sent with.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  ENGINE_DATA_STORE_METHODS,
  ENGINE_DATA_STORE_READ_METHODS,
} from '../../shared/engine-data-ops.js';

const ENV = {
  ENGINE_DATA_FUNCTION: 'engine-data',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_SESSION_TOKEN: 'test',
};

// A fresh module per test: the client cache is module state.
const freshClient = async () => {
  vi.resetModules();
  return import('../engine-data-client.js');
};

afterEach(() => vi.unstubAllEnvs());

describe('the read allowlist', () => {
  it('names only allowlisted store methods', () => {
    expect(ENGINE_DATA_STORE_METHODS).toEqual(
      expect.arrayContaining(ENGINE_DATA_STORE_READ_METHODS),
    );
    for (const method of ENGINE_DATA_STORE_READ_METHODS) {
      expect(method).toMatch(/^(get|list)[A-Z]/);
    }
  });
});

describe('remote process store transport retries', () => {
  let server;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(500, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'ServiceException',
        });
        response.end(JSON.stringify({ message: 'transient' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const remoteStore = async () => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    vi.stubEnv('AWS_ENDPOINT_URL_LAMBDA', `http://127.0.0.1:${server.address().port}`);
    const { createRemoteProcessStore } = await freshClient();
    return createRemoteProcessStore({ grant: () => 'grant' });
  };

  it('sends a mutation once on a retryable error', async () => {
    const store = await remoteStore();
    requests = 0;
    await expect(store.appendEvent({ executionId: 'e-1', type: 'x' })).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it('retries a read on the same error', async () => {
    const store = await remoteStore();
    requests = 0;
    await expect(store.getExecution('e-1')).rejects.toThrow();
    expect(requests).toBeGreaterThan(1);
  }, 30_000);
});

describe('remote process store clients', () => {
  let lambda;
  beforeAll(() => {
    lambda = mockClient(LambdaClient);
  });
  afterAll(() => lambda.restore());

  it('sends every mutation with a single-attempt client and reads with the retrying one', async () => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    lambda.reset();
    lambda
      .on(InvokeCommand)
      .resolves({ Payload: Buffer.from(JSON.stringify({ ok: true, result: null })) });
    const { createRemoteProcessStore } = await freshClient();
    const store = createRemoteProcessStore({ grant: () => 'grant' });
    const reads = new Set(ENGINE_DATA_STORE_READ_METHODS);
    for (const method of ENGINE_DATA_STORE_METHODS) {
      lambda.resetHistory();
      await store[method]({});
      const client = lambda.send.getCall(0).thisValue;
      const maxAttempts = await client.config.maxAttempts();
      expect(maxAttempts > 1, method).toBe(reads.has(method));
      expect(JSON.parse(Buffer.from(lambda.call(0).args[0].input.Payload)).op).toBe(
        `store.${method}`,
      );
    }
  });
});
