import { afterEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  signInWithRedirect: vi.fn(),
  clearTokens: vi.fn(),
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  fetchUserAttributes: vi.fn(),
}));
const hubMocks = vi.hoisted(() => ({
  listeners: [] as Array<
    (capsule: {
      payload: {
        event: string;
        data?: { error?: unknown };
      };
    }) => void
  >,
}));

vi.mock('aws-amplify', () => ({
  Amplify: { configure: vi.fn() },
}));
vi.mock('aws-amplify/utils', () => ({
  Hub: {
    listen: vi.fn((_channel, listener) => {
      hubMocks.listeners.push(listener);
      return vi.fn();
    }),
  },
}));
vi.mock('aws-amplify/auth/enable-oauth-listener', () => ({}));
vi.mock('aws-amplify/auth', () => ({
  signIn: authMocks.signIn,
  signOut: authMocks.signOut,
  getCurrentUser: authMocks.getCurrentUser,
  fetchAuthSession: authMocks.fetchAuthSession,
  fetchUserAttributes: authMocks.fetchUserAttributes,
  confirmSignIn: vi.fn(),
  signInWithRedirect: authMocks.signInWithRedirect,
  updateUserAttributes: vi.fn(),
}));
vi.mock('aws-amplify/auth/cognito', () => ({
  cognitoUserPoolsTokenProvider: {
    tokenOrchestrator: { clearTokens: authMocks.clearTokens },
  },
}));

import { cognitoOauthScopes, parseSsoProviders } from './auth';

describe('SSO frontend configuration', () => {
  const providers = [
    {
      name: 'CorporateOIDC',
      displayName: "Company's identity",
      type: 'oidc' as const,
    },
  ];

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    hubMocks.listeners.length = 0;
  });

  it('decodes generated URI-encoded provider configuration', () => {
    const encoded = `uri:${encodeURIComponent(JSON.stringify(providers))}`;
    expect(parseSsoProviders(encoded)).toEqual(providers);
  });

  it('accepts raw JSON for hand-written development environments', () => {
    expect(parseSsoProviders(JSON.stringify(providers))).toEqual(providers);
  });

  it('requests the Cognito self-service scope used to load user attributes', () => {
    expect(cognitoOauthScopes).toContain('aws.cognito.signin.user.admin');
  });

  it('clears a partial SSO session before local credential login in hybrid mode', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_MODE', 'hybrid');
    authMocks.clearTokens.mockResolvedValue(undefined);
    authMocks.signIn.mockResolvedValue({ isSignedIn: true });

    const { authService } = await import('./auth');
    vi.spyOn(authService, 'getCurrentUser').mockResolvedValue({
      userId: 'local-sub',
      username: 'local@example.com',
      groups: [],
      identitySource: 'cognito',
    });

    await authService.login('local@example.com', 'password');

    expect(authMocks.clearTokens).toHaveBeenCalledOnce();
    expect(authMocks.signIn).toHaveBeenCalledWith({
      username: 'local@example.com',
      password: 'password',
    });
    expect(authMocks.clearTokens.mock.invocationCallOrder[0]).toBeLessThan(
      authMocks.signIn.mock.invocationCallOrder[0],
    );
  });

  it('uses the Cognito subject as the stable application user ID', async () => {
    vi.resetModules();
    authMocks.getCurrentUser.mockResolvedValue({
      username: 'CorporateOIDC_external-user',
      userId: 'cognito-sub-123',
    });
    authMocks.fetchUserAttributes.mockResolvedValue({
      email: 'user@example.com',
      name: 'Enterprise User',
    });
    authMocks.fetchAuthSession.mockResolvedValue({
      tokens: {
        idToken: {
          payload: { 'custom:identity_provider': 'CorporateOIDC' },
        },
      },
    });

    const { authService } = await import('./auth');

    await expect(authService.getCurrentUser()).resolves.toMatchObject({
      userId: 'cognito-sub-123',
      username: 'CorporateOIDC_external-user',
      identitySource: 'sso',
      identityProvider: 'CorporateOIDC',
    });
  });

  it('uses the same broker redirect contract for OIDC and SAML providers', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_MODE', 'hybrid');
    vi.stubEnv(
      'VITE_SSO_PROVIDERS',
      JSON.stringify([
        ...providers,
        {
          name: 'CorporateSAML',
          displayName: 'Company SAML',
          type: 'saml',
        },
      ]),
    );
    authMocks.signInWithRedirect.mockResolvedValue(undefined);

    const { authService } = await import('./auth');
    await authService.loginWithSso('CorporateOIDC', '/dashboard');
    await authService.loginWithSso('CorporateSAML', '/dashboard');

    expect(authMocks.signInWithRedirect.mock.calls).toEqual([
      [{ provider: { custom: 'CorporateOIDC' } }],
      [{ provider: { custom: 'CorporateSAML' } }],
    ]);
  });

  it('preserves an OAuth access-gate failure and clears the partial session', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_MODE', 'hybrid');
    authMocks.clearTokens.mockResolvedValue(undefined);

    const { authService } = await import('./auth');
    const getCurrentUser = vi.spyOn(authService, 'getCurrentUser');
    const listener = hubMocks.listeners.at(-1);
    expect(listener).toBeDefined();
    listener?.({
      payload: {
        event: 'signInWithRedirect_failure',
        data: { error: new Error('invalid_grant') },
      },
    });

    await expect(authService.completeSsoLogin()).rejects.toMatchObject({
      name: 'SsoAccessDeniedError',
      code: 'SSO_ACCESS_DENIED',
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(authMocks.clearTokens).toHaveBeenCalledOnce();
  });

  it('keeps unrelated OAuth failures generic', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_MODE', 'hybrid');
    authMocks.clearTokens.mockResolvedValue(undefined);
    const redirectError = new Error('OAuth token endpoint is unavailable');

    const { authService } = await import('./auth');
    const listener = hubMocks.listeners.at(-1);
    listener?.({
      payload: {
        event: 'signInWithRedirect_failure',
        data: { error: redirectError },
      },
    });

    await expect(authService.completeSsoLogin()).rejects.toBe(redirectError);
    expect(authMocks.clearTokens).toHaveBeenCalledOnce();
  });
});
