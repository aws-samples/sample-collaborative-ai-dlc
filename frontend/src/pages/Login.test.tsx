import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { AuthMode, SsoProvider } from '@/services/auth';

const mocks = vi.hoisted(() => ({
  configuration: {
    mode: 'local' as AuthMode,
    providers: [] as SsoProvider[],
  },
  login: vi.fn(),
  loginWithSso: vi.fn(),
  completeNewPassword: vi.fn(),
  setDisplayName: vi.fn(),
}));

vi.mock('@/services/auth', () => ({
  authConfiguration: mocks.configuration,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    login: mocks.login,
    loginWithSso: mocks.loginWithSso,
    completeNewPassword: mocks.completeNewPassword,
    setDisplayName: mocks.setDisplayName,
    isAuthenticated: false,
    needsNewPassword: false,
    needsDisplayName: false,
  }),
}));

import Login from './Login';

const setMode = (mode: AuthMode) => {
  mocks.configuration.mode = mode;
  mocks.configuration.providers.splice(
    0,
    mocks.configuration.providers.length,
    ...(mode === 'local'
      ? []
      : [{ name: 'CorporateOIDC', displayName: 'Corporate identity', type: 'oidc' as const }]),
  );
};

const renderLogin = (state?: { from: { pathname: string } }) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
      <Login />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  setMode('local');
});

describe('Login authentication modes', () => {
  it('shows only Cognito credentials in local mode', () => {
    renderLogin();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByText('Enterprise SSO')).not.toBeInTheDocument();
  });

  it('clearly separates enterprise SSO from Cognito credentials in hybrid mode', () => {
    setMode('hybrid');
    renderLogin();
    expect(screen.getByText('Enterprise SSO')).toBeInTheDocument();
    expect(screen.getByText('Cognito account')).toBeInTheDocument();
    expect(screen.getByText('Collaborative AI-Driven Development')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Corporate identity' })).toBeVisible();
    expect(screen.getByLabelText('Username')).toBeVisible();
  });

  it('hides Cognito credentials in SSO-only mode', () => {
    setMode('sso-only');
    renderLogin();
    expect(screen.getByRole('button', { name: 'Continue with Corporate identity' })).toBeVisible();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Cognito account')).not.toBeInTheDocument();
  });

  it('starts the selected provider flow and preserves the protected return path', async () => {
    setMode('hybrid');
    const user = userEvent.setup();
    renderLogin({ from: { pathname: '/admin' } });

    await user.click(screen.getByRole('button', { name: 'Continue with Corporate identity' }));

    expect(mocks.loginWithSso).toHaveBeenCalledWith('CorporateOIDC', '/admin');
  });

  it('re-enables provider actions when the redirect cannot be started', async () => {
    setMode('hybrid');
    mocks.loginWithSso.mockRejectedValueOnce(new Error('Redirect could not be started'));
    const user = userEvent.setup();
    renderLogin();

    const providerButton = screen.getByRole('button', {
      name: 'Continue with Corporate identity',
    });
    await user.click(providerButton);

    expect(await screen.findByText('Redirect could not be started')).toBeInTheDocument();
    expect(providerButton).toBeEnabled();
  });
});
