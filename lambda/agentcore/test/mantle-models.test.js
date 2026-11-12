import { describe, it, expect, vi } from 'vitest';
import { createMantleFetch, listMantleModels, mantleModelsUrl } from '../mantle-models.js';

const jsonResponse = (body, init = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
});

describe('mantleModelsUrl', () => {
  it('targets the regional OpenAI-compatible models route', () => {
    expect(mantleModelsUrl('us-east-1')).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/models');
    expect(mantleModelsUrl('eu-central-1')).toBe(
      'https://bedrock-mantle.eu-central-1.api.aws/v1/models',
    );
  });
});

describe('listMantleModels', () => {
  it('sends the Bedrock API key as a bearer token in keys mode', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: 'list', data: [{ id: 'openai.gpt-6-sol' }] }),
    );
    const payload = await listMantleModels({
      region: 'us-east-1',
      apiKey: 'secret-key',
      fetchImpl,
    });
    expect(payload.data.map((m) => m.id)).toEqual(['openai.gpt-6-sol']);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/models');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    expect(init.signal).toBeTruthy();
  });

  it('SigV4-signs the request with the invocation credentials in IAM mode', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    await listMantleModels({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(init.headers.authorization).toContain('/bedrock-mantle/aws4_request');
    expect(init.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    // `host` is signed but left to fetch to send, so it appears in SignedHeaders.
    expect(init.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
    );
  });

  it('throws on a non-2xx answer so the caller can report a failed lookup', async () => {
    const fetchImpl = async () => jsonResponse({ message: 'denied' }, { ok: false, status: 403 });
    await expect(listMantleModels({ region: 'us-east-1', apiKey: 'k', fetchImpl })).rejects.toThrow(
      '403',
    );
  });

  it('throws when the answer is not a model list', async () => {
    const fetchImpl = async () => jsonResponse({ object: 'error' });
    await expect(listMantleModels({ region: 'us-east-1', apiKey: 'k', fetchImpl })).rejects.toThrow(
      'model list',
    );
  });

  const answer = (status, body = { data: [{ id: 'openai.gpt-6-sol' }] }) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const list = (fetchImpl, options = {}) =>
    listMantleModels({
      region: 'us-east-1',
      apiKey: 'test-key',
      fetchImpl,
      retryDelayMs: 0,
      ...options,
    });

  it.each([
    ['a throttled answer', () => answer(429)],
    ['a server error', () => answer(503)],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('retries %s and returns the catalogue once the endpoint answers', async (_label, fail) => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => fail())
      .mockImplementationOnce(async () => fail())
      .mockResolvedValue(answer(200));

    const payload = await list(fetchImpl);

    expect(payload.data).toEqual([{ id: 'openai.gpt-6-sol' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after three attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer(503));

    await expect(list(fetchImpl)).rejects.toThrow(/answered 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])('does not retry a %i answer', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(answer(status));

    await expect(list(fetchImpl)).rejects.toThrow(new RegExp(`answered ${status}`));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request that timed out', async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    await expect(list(fetchImpl, { timeoutMs: 5 })).rejects.toThrow(/aborted/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry an answer that is not a model list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer(200, { object: 'error' }));

    await expect(list(fetchImpl)).rejects.toThrow(/did not return a model list/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires a region', async () => {
    await expect(listMantleModels({ apiKey: 'k' })).rejects.toThrow('region');
  });
});

describe('createMantleFetch', () => {
  it('prefers the bearer token when both a key and credentials exist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const send = createMantleFetch({
      region: 'us-east-1',
      apiKey: 'k',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 's' },
      fetchImpl,
    });
    await send(mantleModelsUrl('us-east-1'), { method: 'GET' });
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer k');
  });
});
