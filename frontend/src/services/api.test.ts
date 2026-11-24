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
import { endUserCache } from '@/lib/persistentCache';

const session = {
  accessToken: 'access',
  idToken: 'id',
  refreshToken: 'refresh',
};

it.each(['get', 'post', 'put', 'patch', 'delete'] as const)(
  '%s discards a response completed after logout',
  async (method) => {
    mocks.resolveSession.mockReset().mockResolvedValue({ session, expired: false });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = api[method]('/late-response', {});
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    endUserCache('logout');
    finish(new Response(JSON.stringify({ value: 'old session' })));
    await rejected;
  },
);

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

describe('api.get options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSession.mockResolvedValue({ session, expired: false });
  });

  it('passes the abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: 'i1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(api.get('/intents/i1', { signal: controller.signal })).resolves.toEqual({
      id: 'i1',
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('does not expire the session when the request is aborted during the forced refresh', async () => {
    const controller = new AbortController();
    mocks.resolveSession
      .mockResolvedValueOnce({ session, expired: false })
      .mockImplementationOnce(async () => {
        controller.abort();
        return { session: null, expired: true };
      });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: vi.fn().mockResolvedValue('') }),
    );

    await expect(api.get('/projects', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('drops an error body that finishes reading after logout', async () => {
    let finish!: (text: string) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      }),
    );
    const pending = api.get('/admin/users');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    endUserCache('logout');
    finish(JSON.stringify({ message: 'old session' }));
    await rejected;
  });

  it('does not touch session expiry when an in-flight request is aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }),
    );

    const pending = api.get('/intents/i1', { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.resolveSession).toHaveBeenCalledTimes(1);
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('does not force a refresh or expire the session for a 401 on an aborted request', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        return { ok: false, status: 401, text: vi.fn().mockResolvedValue('Unauthorized') };
      }),
    );

    await expect(api.get('/intents/i1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.resolveSession).toHaveBeenCalledTimes(1);
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });

  it('does not expire the session when the request was abandoned before it was sent', async () => {
    mocks.resolveSession.mockResolvedValue({ session: null, expired: true });
    const controller = new AbortController();
    controller.abort();

    await expect(api.get('/projects', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mocks.notifySessionExpired).not.toHaveBeenCalled();
  });
});
