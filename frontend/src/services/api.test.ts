import { beforeEach, describe, expect, it, vi } from 'vitest';

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
