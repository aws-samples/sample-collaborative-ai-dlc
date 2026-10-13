import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  currentSessionEpoch: vi.fn(() => 7),
  isSessionExpiryNotified: vi.fn(() => false),
  notifySessionExpired: vi.fn(),
}));

vi.mock('./auth', () => ({
  authService: { resolveSession: (...args: unknown[]) => mocks.resolveSession(...args) },
}));

vi.mock('./sessionExpiry', () => ({
  currentSessionEpoch: mocks.currentSessionEpoch,
  isSessionActive: () => true,
  isSessionExpiryNotified: mocks.isSessionExpiryNotified,
  notifySessionExpired: mocks.notifySessionExpired,
}));

import { api, ApiError } from './api';

const session = {
  accessToken: 'access',
  idToken: 'id',
  refreshToken: 'refresh',
};

describe('authenticated API session expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSessionEpoch.mockReturnValue(7);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not send an old answer with credentials resolved after account switching', async () => {
    let resolve!: (value: unknown) => void;
    mocks.resolveSession.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const result = api
      .post('/projects/p/native-intents/i/response', {
        requestId: 'old-member-request',
        text: 'Approve',
      })
      .catch((error) => error);
    mocks.currentSessionEpoch.mockReturnValue(8);
    resolve({ session: { ...session, idToken: 'new-member' }, expired: false });
    expect(await result).toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('sends the revision when deleting a workflow source and accepts an empty 204', async () => {
    mocks.resolveSession.mockResolvedValue({ session, expired: false });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);

    await expect(
      api.delete('/projects/p/workflow-sources/s', { expectedRevision: 'observed-revision' }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/projects/p/workflow-sources/s'), {
      method: 'DELETE',
      body: '{"expectedRevision":"observed-revision"}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer id' },
    });
  });

  it('preserves bodyless DELETE requests for existing endpoints', async () => {
    mocks.resolveSession.mockResolvedValue({ session, expired: false });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);

    await api.delete('/projects/p/source-control');

    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('does not expire the session after a transient refresh failure', async () => {
    mocks.resolveSession.mockResolvedValue({ session: null, expired: false });

    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401 });

    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('expires the session when Cognito can no longer resolve tokens', async () => {
    mocks.resolveSession.mockResolvedValue({ session: null, expired: true });

    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401 });

    expect(mocks.notifySessionExpired).toHaveBeenCalledWith(7);
  });

  it('does not expire a valid Cognito session for a provider 401 response', async () => {
    mocks.resolveSession
      .mockResolvedValueOnce({ session, expired: false })
      .mockResolvedValueOnce({ session, expired: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Provider unauthorized'),
      }),
    );

    await expect(api.get('/source-control')).rejects.toBeInstanceOf(ApiError);

    expect(mocks.resolveSession).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('expires the session when a provider 401 coincides with failed Cognito refresh', async () => {
    mocks.resolveSession
      .mockResolvedValueOnce({ session, expired: false })
      .mockResolvedValueOnce({ session: null, expired: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Unauthorized'),
      }),
    );

    await expect(api.get('/source-control')).rejects.toMatchObject({ status: 401 });

    expect(mocks.notifySessionExpired).toHaveBeenCalledWith(7);
  });
});
