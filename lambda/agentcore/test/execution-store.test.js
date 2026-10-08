import { describe, it, expect, vi } from 'vitest';
import { executionCredentials, createExecutionStore } from '../execution-store.js';

const start = Date.parse('2026-09-29T12:00:00Z');
const response = (executionId, at, key = executionId) => ({
  executionId,
  credentials: {
    accessKeyId: key,
    secretAccessKey: 'test-secret',
    sessionToken: 'test-token',
    expiration: new Date(at + 3600_000).toISOString(),
  },
});

describe('execution-scoped credential provider', () => {
  it('isolates concurrent providers and coalesces renewals for each invocation', async () => {
    let at = start;
    const broker = vi.fn(async ({ executionId }) => response(executionId, at));
    const a = executionCredentials({
      executionId: 'A',
      grant: 'grant-A',
      broker,
      now: () => at,
    });
    const b = executionCredentials({
      executionId: 'B',
      grant: 'grant-B',
      broker,
      now: () => at,
    });
    const values = await Promise.all([a(), a(), b()]);
    expect(values.map((v) => v.accessKeyId)).toEqual(['A', 'A', 'B']);
    expect(broker).toHaveBeenCalledTimes(2);
    at += 56 * 60_000;
    await Promise.all([a(), a()]);
    expect(broker).toHaveBeenCalledTimes(3);
    expect(broker).toHaveBeenLastCalledWith({
      action: 'resolve-execution-data',
      executionId: 'A',
      grant: 'grant-A',
    });
  });

  it('rejects failed refresh instead of using cached or ambient credentials', async () => {
    let at = start;
    const broker = vi
      .fn()
      .mockResolvedValueOnce(response('A', start))
      .mockRejectedValue(new Error('denied'));
    const provider = executionCredentials({
      executionId: 'A',
      grant: 'lease',
      broker,
      now: () => at,
    });
    await provider();
    at += 56 * 60_000;
    await expect(provider()).rejects.toThrow('denied');
    await expect(provider()).rejects.toThrow('denied');
    expect(broker).toHaveBeenCalledTimes(3);
  });

  it.each([
    response('B', start),
    response('A', start - 3600_000),
    { executionId: 'A', credentials: {} },
  ])('rejects mismatched, expired or incomplete broker results', async (value) => {
    const provider = executionCredentials({
      executionId: 'A',
      grant: 'lease',
      broker: async () => value,
      now: () => start,
    });
    await expect(provider()).rejects.toThrow('invalid');
  });

  it('requires a lease even when a local endpoint or ambient credentials are configured', async () => {
    await expect(
      createExecutionStore({
        executionId: 'A',
        env: {
          DYNAMODB_LOCAL_ENDPOINT: 'http://localhost:8000',
          AWS_ACCESS_KEY_ID: 'ambient',
          AWS_SECRET_ACCESS_KEY: 'ambient',
        },
      }),
    ).rejects.toThrow('grant is required');
  });
});
