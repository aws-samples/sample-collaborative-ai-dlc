import { expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { MEMBERSHIP, PROJECT, createInput, event, setup } from './fixtures.js';

const target = { publicationId: 'a'.repeat(64), publicationSequence: '1' };
const fileId = `nf-${'b'.repeat(64)}`;
const route = (kind) => {
  const base = event('get');
  const suffix =
    kind === 'file' ? `/files/${fileId}` : `/${kind === 'history' ? 'publication' : kind}`;
  return {
    ...base,
    resource: `${base.resource}${kind === 'file' ? '/files/{fileId}' : suffix}`,
    path: `${base.path}${suffix}`,
    pathParameters: { ...base.pathParameters, ...(kind === 'file' ? { fileId } : {}) },
    queryStringParameters:
      kind === 'history'
        ? { history: '1', beforeSequence: '10' }
        : { ...target, ...(kind === 'file' ? { sha256: 'c'.repeat(64) } : {}) },
  };
};
const fixture = async () => {
  const f = setup();
  await f.store.create(createInput());
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const read = vi.fn(async (_row, _target, recheck) => {
    await recheck(_row);
    return { safe: 'Exact protected history' };
  });
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    getMembershipSnapshot: membership,
    execution: { history: read, revision: read, revisionFile: read, revisionInteraction: read },
  });
  return { ...f, api, read, membership };
};

it.each(['history', 'publication', 'interaction', 'file'])(
  'authorizes and rechecks the %s read through the existing HTTP resource',
  async (kind) => {
    const f = await fixture();
    const result = await f.api(route(kind));
    expect(result.statusCode).toBe(200);
    expect(f.read.mock.calls[0][1]).toEqual(
      kind === 'history'
        ? 10
        : {
            publicationId: target.publicationId,
            publicationSequence: 1,
            ...(kind === 'file' ? { fileId, sha256: 'c'.repeat(64) } : {}),
          },
    );
  },
);
it.each(['history', 'publication', 'interaction', 'file'])(
  'denies %s to a nonmember before any history lookup',
  async (kind) => {
    const f = await fixture();
    f.membership.mockResolvedValue(null);
    expect((await f.api(route(kind))).statusCode).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  },
);
it.each(['history', 'publication', 'interaction', 'file'])(
  'withholds %s when access is revoked during the read',
  async (kind) => {
    const f = await fixture();
    f.read.mockImplementationOnce(async () => {
      f.membership.mockResolvedValue(null);
      return { safe: 'Exact protected history' };
    });
    const result = await f.api(route(kind));
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain('Exact protected history');
  },
);
it('keeps malformed and guessed revision links out of the read owner', async () => {
  const f = await fixture();
  const request = route('file');
  delete request.queryStringParameters.sha256;
  expect((await f.api(request)).statusCode).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'NATIVE_ARTIFACT_REVISION_INVALID' }),
  );
  const result = await f.api(route('publication'));
  expect(result.statusCode).toBe(404);
  expect(result.body).toContain('named native revision is unavailable');
});
