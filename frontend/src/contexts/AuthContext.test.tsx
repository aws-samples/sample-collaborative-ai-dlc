import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  loginWithSso: vi.fn(),
  completeSsoLogin: vi.fn(),
  consumeReturnTo: vi.fn(),
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
      <button onClick={() => void logout()}>Logout</button>
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
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiry();
  mocks.isAuthenticated.mockResolvedValue(false);
  mocks.logout.mockResolvedValue(undefined);
  mocks.consumeReturnTo.mockReturnValue('/dashboard');
});

describe('AuthProvider SSO state', () => {
  it('keeps the replacement identity when an earlier logout finishes late', async () => {
    let finish!: () => void;
    mocks.logout.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.completeSsoLogin.mockResolvedValue({
      userId: 'new',
      username: 'new@example.com',
      groups: [],
    });
    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    expect(await screen.findByText('idle')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Logout'));
    await userEvent.click(screen.getByText('Complete SSO'));
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    await act(async () => {
      finish();
    });
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
  });

  it('does not restore an identity from a startup lookup completed after session expiry', async () => {
    let finish!: (value: unknown) => void;
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getCurrentUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <AuthProvider>
        <SsoLoginHarness />
      </AuthProvider>,
    );
    await act(async () => {});
    act(() => notifySessionExpired());
    await act(async () => {
      finish({ userId: 'old', username: 'old@example.com', groups: [] });
    });
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

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
  });
});
