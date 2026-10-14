import { expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { MEMBERSHIP, PROJECT, createInput, event, setup } from './fixtures.js';

const input = {
  requestId: '10000000-0000-4000-8000-000000000001',
  publicationId: 'a'.repeat(64),
  publicationSequence: 1,
};
const route = (method = 'GET') => {
  const request = event('get');
  return {
    ...request,
    resource: `${request.resource}/results`,
    path: `${request.path}/results`,
    httpMethod: method,
    ...(method === 'POST'
      ? { body: JSON.stringify(input) }
      : {
          queryStringParameters: Object.fromEntries(
            Object.entries(input).map(([key, value]) => [key, String(value)]),
          ),
        }),
  };
};
const fixture = async () => {
  const f = setup();
  await f.store.create(createInput());
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const read = vi.fn(async () => ({ status: 'ready', download: { downloadUrl: 'private' } }));
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    getMembershipSnapshot: membership,
    execution: { requestResult: read, result: read },
  });
  return { api, membership, read };
};
it.each(['GET', 'POST'])(
  'authorizes %s results for either current project member and returns no cacheable token',
  async (method) => {
    const f = await fixture();
    const request = route(method);
    for (const sub of ['first-member', 'second-member']) {
      request.requestContext.authorizer.claims.sub = sub;
      const result = await f.api(request);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Cache-Control']).toBe('private, no-store');
    }
    expect(f.read.mock.calls[0][1]).toEqual(input);
  },
);
it.each(['GET', 'POST'])(
  'denies unauthorized %s and rechecks revoked access before exposing bearer URLs',
  async (method) => {
    const f = await fixture();
    f.membership.mockResolvedValueOnce(null);
    expect((await f.api(route(method))).statusCode).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
    f.read.mockImplementationOnce(async () => {
      f.membership.mockResolvedValue(null);
      return { status: 'ready', download: { downloadUrl: 'private' } };
    });
    const response = await f.api(route(method));
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('private');
  },
);
it('rejects duplicate query identities before result work', async () => {
  const f = await fixture();
  const request = route();
  request.multiValueQueryStringParameters = { requestId: [input.requestId, input.requestId] };
  expect((await f.api(request)).statusCode).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
