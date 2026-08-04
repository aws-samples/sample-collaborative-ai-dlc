import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  loginWithSso: vi.fn(),
}));

vi.mock('../services/auth', () => ({
  authService: mocks,
}));

import { AuthProvider, useAuth } from './AuthContext';

function SsoLoginHarness() {
  const { isLoading, loginWithSso } = useAuth();

  return (
    <>
      <span>{isLoading ? 'loading' : 'idle'}</span>
      <button
        type="button"
        onClick={() => {
          void loginWithSso('CorporateOIDC', '/dashboard').catch(() => undefined);
        }}
      >
        Start SSO
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthenticated.mockResolvedValue(false);
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

    await user.click(screen.getByRole('button', { name: 'Start SSO' }));
    expect(screen.getByText('loading')).toBeInTheDocument();

    await act(async () => {
      rejectRedirect(new Error('Redirect failed'));
    });
    expect(await screen.findByText('idle')).toBeInTheDocument();
  });
});
