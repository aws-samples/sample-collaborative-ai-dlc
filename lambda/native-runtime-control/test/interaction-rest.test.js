import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { ACTOR, MEMBERSHIP, OTHER, PROJECT, createInput, event, setup } from './fixtures.js';

const input = (overrides = {}) => ({
  requestId: OTHER,
  interactionId: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
  text: 'Please compose the workflow.\nKeep the proposed validation stage.',
  ...overrides,
});
const route = (action, overrides = {}) => {
  const base = event('get');
  return {
    ...base,
    resource: `${base.resource}/${action}`,
    path: `${base.path}/${action}`,
    httpMethod: action === 'interaction' ? 'GET' : 'POST',
    ...(action === 'response' ? { body: JSON.stringify(input()) } : {}),
    ...(action === 'recover'
      ? { body: JSON.stringify({ requestId: OTHER, recoveryId: OTHER }) }
      : {}),
    ...overrides,
  };
};
const fixture = async (options = {}) => {
  const f = setup();
  await f.store.create(createInput());
  const membership = vi.fn(async () => ({ ...MEMBERSHIP }));
  const execution = {
    interaction: vi.fn(async (row, recheck) => {
      await recheck(row);
      return { id: 'a'.repeat(64), messages: [{ type: 'text', text: 'Choose a workflow.' }] };
    }),
    respond: vi.fn(async (row, actorId, reply, recheck) => {
      await recheck(row);
      return { execution: { status: 'CONTINUE_REQUESTED' } };
    }),
    recover: vi.fn(async (row, request, recheck) => {
      await recheck(row);
      return { execution: { status: 'RECOVERING' } };
    }),
  };
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    getMembershipSnapshot: membership,
    execution,
    ...options,
  });
  return { ...f, api, membership, execution };
};

describe('native assistant interaction REST boundary', () => {
  it.each(['owner', 'admin', 'member'])(
    'lets an authenticated %s read and reply through the protected service',
    async (role) => {
      const f = await fixture();
      f.membership.mockResolvedValue({ ...MEMBERSHIP, role });
      expect((await f.api(route('interaction'))).statusCode).toBe(200);
      expect((await f.api(route('response'))).statusCode).toBe(202);
      expect(f.execution.respond).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT }),
        ACTOR,
        input(),
        expect.any(Function),
      );
    },
  );

  it.each(['interaction', 'response', 'recover'])(
    'denies %s without project membership',
    async (action) => {
      const f = await fixture();
      f.membership.mockResolvedValue(null);
      expect((await f.api(route(action))).statusCode).toBe(403);
      expect(f.execution.interaction).not.toHaveBeenCalled();
      expect(f.execution.respond).not.toHaveBeenCalled();
      expect(f.execution.recover).not.toHaveBeenCalled();
    },
  );

  it.each(['interaction', 'response', 'recover'])(
    'rechecks membership during %s and suppresses data on revocation',
    async (action) => {
      const f = await fixture();
      f.membership
        .mockResolvedValueOnce(MEMBERSHIP)
        .mockResolvedValueOnce(MEMBERSHIP)
        .mockResolvedValue(null);
      const result = await f.api(route(action));
      expect(result.statusCode).toBe(403);
      expect(result.body).not.toContain('Choose a workflow');
    },
  );

  it.each(['owner', 'admin', 'member'])(
    'permits %s recovery through the existing membership boundary',
    async (role) => {
      const f = await fixture();
      f.membership.mockResolvedValue({ ...MEMBERSHIP, role });
      const result = await f.api(route('recover'));
      expect(result.statusCode).toBe(202);
      expect(f.execution.recover).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT }),
        { requestId: OTHER, recoveryId: OTHER },
        expect.any(Function),
      );
      expect(f.execution.respond).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    {},
    { requestId: OTHER },
    { requestId: OTHER, recoveryId: 'untrusted-episode' },
    { requestId: OTHER, recoveryId: OTHER, checkpoint: 'forged-storage-key' },
    { requestId: OTHER, recoveryId: OTHER, writerGeneration: 100 },
    { requestId: OTHER, recoveryId: OTHER, text: 'another reply' },
  ])('rejects a malformed recovery request before authorization: %j', async (body) => {
    const f = await fixture();
    expect((await f.api(route('recover', { body: JSON.stringify(body) }))).statusCode).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.execution.recover).not.toHaveBeenCalled();
  });

  it.each([
    ['actor override', input({ actorId: 'forged-member' })],
    ['approval override', input({ approved: true })],
    ['runtime override', input({ nativeSessionId: 'forged-session' })],
    ['missing request identity', { ...input(), requestId: undefined }],
    ['missing interaction', { ...input(), interactionId: undefined }],
    ['bad content digest', input({ contentSha256: 'not-a-digest' })],
    ['blank', input({ text: ' \r\n\t ' })],
    ['NUL', input({ text: 'Approve\0this' })],
    ['ANSI control', input({ text: '\x1b[31mApprove' })],
    ['invalid surrogate', input({ text: 'Reply\ud800' })],
    ['oversized Unicode', input({ text: '🐦'.repeat(4097) })],
    ['non-text', input({ text: ['Approve'] })],
  ])('rejects %s before touching membership or execution', async (_label, body) => {
    const f = await fixture();
    expect((await f.api(route('response', { body: JSON.stringify(body) }))).statusCode).toBe(400);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.execution.respond).not.toHaveBeenCalled();
  });

  it('preserves a byte-bounded Unicode reply, line endings and whitespace exactly', async () => {
    const f = await fixture();
    const body = input({ text: '\ufeff  Ändere den Plan.\r\n🐦\t\r\n' });
    expect((await f.api(route('response', { body: JSON.stringify(body) }))).statusCode).toBe(202);
    expect(f.execution.respond.mock.calls[0][2]).toEqual(body);
  });

  it('accepts valid escaped JSON at the decoded text byte limit', async () => {
    const f = await fixture();
    const body = input({ text: 'a'.repeat(16 * 1024) });
    const escaped = JSON.stringify(body).replace(/a/g, '\\u0061');
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(96 * 1024);
    expect((await f.api(route('response', { body: escaped }))).statusCode).toBe(202);
    expect(f.execution.respond.mock.calls[0][2]).toEqual(body);
  });

  it.each([
    ['response', { body: undefined }, 400],
    ['response', { body: '{' }, 400],
    ['response', { body: ' '.repeat(100 * 1024 + 1) }, 400],
    ['response', { isBase64Encoded: true }, 400],
    ['response', { queryStringParameters: { actorId: ACTOR } }, 400],
    ['response', { httpMethod: 'GET' }, 405],
    ['interaction', { httpMethod: 'POST' }, 405],
    ['interaction', { body: '{}' }, 400],
    ['interaction', { path: '/unrelated/interaction' }, 400],
    ['response', { requestContext: { authorizer: { principalId: ACTOR } } }, 401],
  ])('rejects malformed %s envelope %j', async (action, override, status) => {
    const f = await fixture();
    expect((await f.api(route(action, override))).statusCode).toBe(status);
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.execution.respond).not.toHaveBeenCalled();
    expect(f.execution.interaction).not.toHaveBeenCalled();
  });

  it.each([
    ['NATIVE_INTERACTION_INVALID', 503],
    ['NATIVE_INTERACTION_NOT_FOUND', 404],
    ['NATIVE_EXECUTION_CONFLICT', 409],
  ])('exposes a fixed %s error without storage or credential details', async (code, status) => {
    const f = await fixture();
    f.execution.interaction.mockRejectedValue(
      Object.assign(new Error('private bucket pointer and credentials'), { code }),
    );
    const result = await f.api(route('interaction'));
    expect(result.statusCode).toBe(status);
    expect(JSON.parse(result.body).code).toBe(code);
    expect(result.body).not.toContain('private');
  });
});
