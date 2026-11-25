import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { AuthMode, SsoProvider } from '@/services/auth';
import { PasswordResetRequiredError } from '@/services/authErrors';

const mocks = vi.hoisted(() => ({
  configuration: {
    mode: 'local' as AuthMode,
    providers: [] as SsoProvider[],
  },
  login: vi.fn(),
  loginWithSso: vi.fn(),
  completeNewPassword: vi.fn(),
  setDisplayName: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  needsNewPassword: false,
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
    requestPasswordReset: mocks.requestPasswordReset,
    confirmPasswordReset: mocks.confirmPasswordReset,
    isAuthenticated: false,
    needsNewPassword: mocks.needsNewPassword,
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

const renderLogin = (state?: { from: { pathname: string; search?: string; hash?: string } }) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
      <Login />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  setMode('local');
  mocks.needsNewPassword = false;
});

describe('Login authentication modes', () => {
  it('shows only Cognito credentials in local mode', () => {
    renderLogin();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByText('Enterprise SSO')).not.toBeInTheDocument();
  });

  it('names the page with one h1 and a document title, and restores the title on unmount', () => {
    document.title = 'AI-DLC — Collaborative AI Development Lifecycle';
    const view = renderLogin();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to AI-DLC' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The h1 and the tagline live inside the page's one main landmark.
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(main).toContainElement(screen.getByText('Collaborative AI-Driven Development'));
    expect(document.title).toBe('Sign in · AI-DLC');
    view.unmount();
    expect(document.title).toBe('AI-DLC — Collaborative AI Development Lifecycle');
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
    expect(screen.queryByRole('button', { name: 'Forgot password?' })).not.toBeInTheDocument();
  });

  it('starts the selected provider flow and preserves the protected return path', async () => {
    setMode('hybrid');
    const user = userEvent.setup();
    renderLogin({ from: { pathname: '/admin', search: '?tab=agents', hash: '#credentials' } });

    await user.click(screen.getByRole('button', { name: 'Continue with Corporate identity' }));

    expect(mocks.loginWithSso).toHaveBeenCalledWith(
      'CorporateOIDC',
      '/admin?tab=agents#credentials',
    );
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

describe('Login password reset', () => {
  it('resets a forgotten password with an emailed code and returns to sign-in', async () => {
    mocks.requestPasswordReset.mockResolvedValue(undefined);
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Username'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByLabelText('Email')).toHaveValue('user@example.com');
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));

    expect(mocks.requestPasswordReset).toHaveBeenCalledWith('user@example.com');
    expect(
      await screen.findByText(/If an account exists for user@example.com/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.type(screen.getByLabelText('New password'), 'New-password-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'New-password-1');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(mocks.confirmPasswordReset).toHaveBeenCalledWith(
      'user@example.com',
      '123456',
      'New-password-1',
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Password reset.');
    expect(screen.getByLabelText('Username')).toHaveValue('user@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('validates the new password before confirming the reset', async () => {
    mocks.requestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));
    await user.type(await screen.findByLabelText('Verification code'), '123456');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(screen.getByText(/at least 12 characters/)).toBeInTheDocument();
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('shows a reset failure and stays on the request step', async () => {
    mocks.requestPasswordReset.mockRejectedValue(
      new Error('This account has no verified email address.'),
    );
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));

    expect(await screen.findByText(/no verified email address/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('opens the reset flow when sign-in requires a password reset', async () => {
    mocks.login.mockRejectedValue(new PasswordResetRequiredError());
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Username'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'Old-password-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/must be reset before you can sign in/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('user@example.com');
  });

  it('confirms a resent code', async () => {
    mocks.requestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'Send verification code' }));
    await user.click(await screen.findByRole('button', { name: 'Resend code' }));

    expect(mocks.requestPasswordReset).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('A new verification code has been sent.')).toBeInTheDocument();
  });

  it('points Enterprise SSO users to their identity provider in hybrid mode', async () => {
    setMode('hybrid');
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(screen.getByText(/reset your password with your identity provider/)).toBeInTheDocument();
  });

  it('enters an emailed code without requesting a new one', async () => {
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'I already have a code' }));
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.type(screen.getByLabelText('New password'), 'New-password-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'New-password-1');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
    expect(mocks.confirmPasswordReset).toHaveBeenCalledWith(
      'user@example.com',
      '123456',
      'New-password-1',
    );
  });

  it('checks the full policy at the first-sign-in new-password prompt', async () => {
    mocks.needsNewPassword = true;
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('New password'), 'nouppercase-123');
    await user.type(screen.getByLabelText('Confirm new password'), 'nouppercase-123');
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/uppercase/);
    expect(mocks.completeNewPassword).not.toHaveBeenCalled();
  });

  it('states the password rules on the first-sign-in prompt, like the reset form does', () => {
    mocks.needsNewPassword = true;
    renderLogin();

    expect(screen.getByText('Set a new password')).toBeInTheDocument();
    const field = screen.getByLabelText('New password');
    expect(field).toHaveAccessibleDescription(
      'At least 12 characters, with lowercase and uppercase letters, a number, and a symbol.',
    );
    expect(field).toHaveAttribute('autocomplete', 'new-password');
  });

  it('returns to sign-in without resetting', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));

    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });
});
