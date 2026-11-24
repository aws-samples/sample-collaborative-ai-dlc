import { act, render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bindUserCache: vi.fn(
    () => 'bound' as 'bound' | 'missing-user' | 'session-ended' | 'different-user',
  ),
  endUserCache: vi.fn(),
  isAuthenticated: vi.fn(),
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  loginWithSso: vi.fn(),
  completeSsoLogin: vi.fn(),
  consumeReturnTo: vi.fn(),
}));

vi.mock('@/lib/persistentCache', () => ({
  onUserCacheEnded: () => () => {},
  bindUserCache: mocks.bindUserCache,
  endUserCache: mocks.endUserCache,
}));

vi.mock('../services/auth', () => ({
  authService: mocks,
}));

import { AuthProvider, useAuth } from './AuthContext';
import {
  currentSessionEpoch,
  notifySessionExpired,
  resetSessionExpiry,
} from '../services/sessionExpiry';

function SsoLoginHarness() {
  const { user, isLoading, loginWithSso, completeSsoLogin, logout } = useAuth();

  return (
    <>
      <span>{isLoading ? 'loading' : 'idle'}</span>
      <span>{user?.username ?? 'anonymous'}</span>
      <button
        type="button"
        onClick={() => {
          void loginWithSso('CorporateOIDC', '/dashboard').catch(() => undefined);
        }}
      >
        Start SSO
      </button>
      <button
        type="button"
        onClick={() => {
          void completeSsoLogin();
        }}
      >
        Complete SSO
      </button>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bindUserCache.mockReturnValue('bound');
  resetSessionExpiry();
  mocks.isAuthenticated.mockResolvedValue(false);
  mocks.logout.mockResolvedValue(undefined);
  mocks.consumeReturnTo.mockReturnValue('/dashboard');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthProvider SSO state', () => {
  it('releases the loading state when an SSO redirect fails', async () => {
    let rejectRedirect!: (reason?: unknown) => void;
    mocks.loginWithSso.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRedirect = reject;
        }),
    );
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('idle')).toBeInTheDocument();
    expect(mocks.isAuthenticated).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Start SSO' }));
    expect(screen.getByText('loading')).toBeInTheDocument();

    await act(async () => {
      rejectRedirect(new Error('Redirect failed'));
    });
    expect(await screen.findByText('idle')).toBeInTheDocument();
  });

  it('starts a new session epoch after successful SSO completion', async () => {
    mocks.completeSsoLogin.mockResolvedValue({
      userId: 'sso-user',
      username: 'sso@example.com',
      groups: [],
      identitySource: 'sso',
    });
    const epoch = currentSessionEpoch();

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('idle')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Complete SSO' }));

    expect(currentSessionEpoch()).toBe(epoch + 1);
  });

  it('does not reload when authenticated identity has no stable user id', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mocks.bindUserCache.mockReturnValue('missing-user');
    mocks.completeSsoLogin.mockResolvedValue({
      userId: '',
      username: 'sso@example.com',
      groups: [],
      identitySource: 'sso',
    });

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    await screen.findByText('idle');
    await userEvent.click(screen.getByRole('button', { name: 'Complete SSO' }));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

  it('reloads once after accepting a different account in an already-bound document', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mocks.bindUserCache.mockReturnValue('different-user');
    mocks.completeSsoLogin.mockResolvedValue({
      userId: 'user-2',
      username: 'other@example.com',
      groups: [],
      identitySource: 'sso',
    });

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    await screen.findByText('idle');
    await userEvent.click(screen.getByRole('button', { name: 'Complete SSO' }));

    expect(reload).toHaveBeenCalledOnce();
    expect(mocks.endUserCache).toHaveBeenCalledOnce();
    expect(mocks.endUserCache).toHaveBeenCalledWith('user-switch');
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

  it('clears the previous user when a replacement identity lacks a subject', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mocks.bindUserCache.mockReturnValueOnce('bound').mockReturnValueOnce('missing-user');
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'first@example.com',
      groups: [],
      identitySource: 'cognito',
    });
    mocks.completeSsoLogin.mockResolvedValue({
      userId: '',
      username: 'second@example.com',
      groups: [],
      identitySource: 'sso',
    });

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('first@example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Complete SSO' }));

    expect(reload).not.toHaveBeenCalled();
    expect(mocks.endUserCache).toHaveBeenCalledOnce();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

  it('ignores an auth-state lookup that resolves after session expiry', async () => {
    let resolveUser!: (user: {
      userId: string;
      username: string;
      groups: string[];
      identitySource: string;
    }) => void;
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getCurrentUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.getCurrentUser).toHaveBeenCalledOnce());
    act(() => notifySessionExpired());
    await act(async () => {
      resolveUser({
        userId: 'expired-user',
        username: 'expired@example.com',
        groups: [],
        identitySource: 'cognito',
      });
    });

    expect(screen.getByText('anonymous')).toBeInTheDocument();
    expect(mocks.bindUserCache).not.toHaveBeenCalled();
  });

  it('does not restore an expired session when expiry predates provider mount', async () => {
    act(() => notifySessionExpired());
    mocks.isAuthenticated.mockResolvedValue(true);

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(mocks.isAuthenticated).not.toHaveBeenCalled();
    expect(mocks.bindUserCache).not.toHaveBeenCalled();
  });

  it('does not accept a pending initial auth check after a successful logout', async () => {
    let resolveAuth!: (authenticated: boolean) => void;
    mocks.isAuthenticated.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    );
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => resolveAuth(true));

    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

  it('clears an authenticated user and logs out once when the session expires', async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'user@example.com',
      groups: [],
      identitySource: 'cognito',
    });

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('user@example.com')).toBeInTheDocument();

    act(() => {
      notifySessionExpired();
      notifySessionExpired();
    });

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.endUserCache).toHaveBeenCalledOnce();
    expect(mocks.endUserCache).toHaveBeenCalledWith('session-expired');
  });

  it('ends the user cache (and with it the in-memory query cache) on sign-out', async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'user@example.com',
      groups: [],
      identitySource: 'cognito',
    });

    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(mocks.endUserCache).toHaveBeenCalledOnce();
    expect(mocks.endUserCache).toHaveBeenCalledWith();
  });
});
