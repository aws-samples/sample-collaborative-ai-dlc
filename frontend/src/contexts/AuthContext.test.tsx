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
  const { user, isLoading, loginWithSso, completeSsoLogin } = useAuth();

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
