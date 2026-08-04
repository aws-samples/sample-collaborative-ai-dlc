import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  SsoAccessDeniedError,
  SsoLoginTimeoutError,
  SSO_ACCESS_DENIED_MESSAGE,
} from '@/services/authErrors';

const completeSsoLogin = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ completeSsoLogin }),
}));

import AuthCallback from './AuthCallback';

const renderCallback = (entry = '/auth/callback') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/admin" element={<div>Admin destination</div>} />
        <Route path="/login" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  completeSsoLogin.mockReset();
});

describe('AuthCallback', () => {
  it('completes the Cognito code exchange and restores the return path', async () => {
    completeSsoLogin.mockResolvedValue('/admin');
    renderCallback();
    expect(await screen.findByText('Admin destination')).toBeInTheDocument();
    expect(completeSsoLogin).toHaveBeenCalledOnce();
  });

  it('shows an upstream provider denial without attempting a token exchange', () => {
    renderCallback('/auth/callback?error=access_denied&error_description=Not%20assigned');
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText(SSO_ACCESS_DENIED_MESSAGE)).toBeInTheDocument();
    expect(completeSsoLogin).not.toHaveBeenCalled();
  });

  it('shows unrelated upstream provider errors without labeling them as access denial', () => {
    renderCallback('/auth/callback?error=server_error&error_description=Provider%20unavailable');
    expect(screen.getByRole('heading', { name: 'Sign-in failed' })).toBeInTheDocument();
    expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
    expect(completeSsoLogin).not.toHaveBeenCalled();
  });

  it('shows a specific access-denied result when the broker rejects token issuance', async () => {
    completeSsoLogin.mockRejectedValue(new SsoAccessDeniedError(new Error('SSO_ACCESS_DENIED')));
    renderCallback();

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText(SSO_ACCESS_DENIED_MESSAGE)).toBeInTheDocument();
  });

  it('offers a retry after the code exchange times out', async () => {
    completeSsoLogin.mockRejectedValue(new SsoLoginTimeoutError());
    renderCallback();

    expect(await screen.findByRole('heading', { name: 'Sign-in timed out' })).toBeInTheDocument();
    expect(
      screen.getByText('Enterprise sign-in did not complete in time. Try signing in again.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Sign-in page')).toBeInTheDocument();
  });
});
