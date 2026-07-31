import { Amplify } from 'aws-amplify';
import 'aws-amplify/auth/enable-oauth-listener';
import { Hub } from 'aws-amplify/utils';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  fetchUserAttributes,
  confirmSignIn,
  signInWithRedirect,
  updateUserAttributes,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { clearPersistedCache } from '@/lib/persistentCache';
import { normalizeSsoLoginError, SsoLoginTimeoutError } from './authErrors';

export type AuthMode = 'local' | 'hybrid' | 'sso-only';

export interface SsoProvider {
  name: string;
  displayName: string;
  type: 'oidc' | 'saml';
}

export const parseSsoProviders = (raw: string): SsoProvider[] => {
  try {
    const serialized = raw.startsWith('uri:') ? decodeURIComponent(raw.slice(4)) : raw;
    const parsed = JSON.parse(serialized || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error('Invalid VITE_SSO_PROVIDERS configuration');
    return [];
  }
};

export const authConfiguration = {
  mode: (import.meta.env.VITE_AUTH_MODE || 'local') as AuthMode,
  providers: parseSsoProviders(import.meta.env.VITE_SSO_PROVIDERS || '[]'),
};

export const cognitoOauthScopes = [
  'openid',
  'email',
  'profile',
  // Do not add aws.cognito.signin.user.admin. Cognito requires IdP-mapped
  // attributes to be app-client writable, so hosted tokens must not receive
  // the scope that authorizes user-pool self-service writes.
] as const;

const hostedUiOrigin = import.meta.env.VITE_COGNITO_HOSTED_UI_DOMAIN || '';
const callbackUrl =
  import.meta.env.VITE_AUTH_CALLBACK_URL ||
  `${import.meta.env.VITE_APP_ORIGIN || window.location.origin}/auth/callback`;
const logoutUrl = `${import.meta.env.VITE_APP_ORIGIN || window.location.origin}/login`;
let completedReturnTo: string | null = null;
let ssoRedirectFailure: unknown;
const SSO_LOGIN_ATTEMPTS = 40;
const SSO_LOGIN_POLL_INTERVAL_MS = 250;

const clearStoredBrokerSession = () =>
  cognitoUserPoolsTokenProvider.tokenOrchestrator.clearTokens();

// Amplify completes the OAuth code exchange during configure(), before React
// mounts the callback page. Preserve the result so the page does not lose the
// broker's real failure and replace it with a later unauthenticated error.
Hub.listen('auth', ({ payload }) => {
  if (payload.event === 'signInWithRedirect_failure') {
    ssoRedirectFailure =
      payload.data?.error || new Error('Enterprise sign-in redirect failed without an error');
  } else if (payload.event === 'signInWithRedirect') {
    ssoRedirectFailure = undefined;
  }
});

const cognitoConfig: Record<string, unknown> = {
  userPoolId: import.meta.env.VITE_AWS_USER_POOL_ID,
  userPoolClientId: import.meta.env.VITE_AWS_USER_POOL_CLIENT_ID,
};
if (authConfiguration.mode !== 'local' && hostedUiOrigin) {
  cognitoConfig.loginWith = {
    oauth: {
      domain: hostedUiOrigin.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      scopes: [...cognitoOauthScopes],
      redirectSignIn: [callbackUrl],
      redirectSignOut: [logoutUrl],
      responseType: 'code',
    },
  };
}

Amplify.configure({
  Auth: {
    Cognito: cognitoConfig as any,
  },
});

export interface User {
  /** Stable Cognito subject used by backend authorization and application data. */
  userId: string;
  /** Cognito username used for credential login and user-pool administration. */
  username: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  /** Cognito groups from the ID token (e.g. 'platform-admin'). */
  groups: string[];
  identitySource: 'cognito' | 'sso';
  identityProvider?: string;
}

export interface AuthSession {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user?: User;
  nextStep?: 'NEW_PASSWORD_REQUIRED' | 'MFA_REQUIRED';
}

export const authService = {
  async login(username: string, password: string): Promise<AuthResult> {
    try {
      // In hybrid mode signOut redirects through the hosted UI. Clear only the
      // local token store so credential login can replace a partial SSO session.
      if (authConfiguration.mode === 'local') {
        try {
          await signOut();
        } catch {
          // There may be no active session.
        }
      } else {
        await clearStoredBrokerSession();
      }

      const result = await signIn({ username, password });

      if (result.isSignedIn) {
        return { user: await this.getCurrentUser() };
      }

      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        return { nextStep: 'NEW_PASSWORD_REQUIRED' };
      }

      if (
        result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_SMS_CODE' ||
        result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE'
      ) {
        return { nextStep: 'MFA_REQUIRED' };
      }

      throw new Error('Sign in failed');
    } catch (error: any) {
      console.error('Login error:', error);
      if (error.name === 'NotAuthorizedException') {
        throw new Error('Incorrect username or password', { cause: error });
      }
      if (error.name === 'UserNotFoundException') {
        throw new Error('User does not exist', { cause: error });
      }
      if (error.name === 'UserNotConfirmedException') {
        throw new Error('User is not confirmed', { cause: error });
      }
      throw error;
    }
  },

  async loginWithSso(providerName: string, returnTo: string): Promise<void> {
    if (!authConfiguration.providers.some((provider) => provider.name === providerName)) {
      throw new Error('Unknown enterprise identity provider');
    }
    sessionStorage.setItem('aidlc-auth-return-to', returnTo);
    completedReturnTo = null;
    ssoRedirectFailure = undefined;
    clearPersistedCache();
    await signInWithRedirect({ provider: { custom: providerName } });
  },

  async completeSsoLogin(): Promise<User> {
    // Amplify's OAuth listener completes the code exchange asynchronously when
    // the auth module loads. Wait briefly for the token store to become ready.
    let lastError: unknown;
    for (let attempt = 0; attempt < SSO_LOGIN_ATTEMPTS; attempt++) {
      if (ssoRedirectFailure !== undefined) {
        lastError = ssoRedirectFailure;
        break;
      }
      try {
        return await this.getCurrentUser();
      } catch (error) {
        lastError = ssoRedirectFailure === undefined ? error : ssoRedirectFailure;
        if (ssoRedirectFailure !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, SSO_LOGIN_POLL_INTERVAL_MS));
      }
    }
    try {
      await clearStoredBrokerSession();
    } catch (error) {
      console.error('Failed to clear incomplete enterprise session:', error);
    }
    if (ssoRedirectFailure !== undefined) {
      throw normalizeSsoLoginError(ssoRedirectFailure);
    }
    throw new SsoLoginTimeoutError(lastError);
  },

  consumeReturnTo(): string {
    if (completedReturnTo) return completedReturnTo;
    const path = sessionStorage.getItem('aidlc-auth-return-to') || '/dashboard';
    sessionStorage.removeItem('aidlc-auth-return-to');
    completedReturnTo = path.startsWith('/') && !path.startsWith('//') ? path : '/dashboard';
    return completedReturnTo;
  },

  async completeNewPassword(newPassword: string): Promise<User> {
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      if (result.isSignedIn) {
        return await this.getCurrentUser();
      }
      throw new Error('Password change failed');
    } catch (error: any) {
      console.error('Complete new password error:', error);
      if (error.name === 'InvalidPasswordException') {
        throw new Error('Password does not meet requirements', { cause: error });
      }
      throw error;
    }
  },

  async logout(): Promise<void> {
    try {
      clearPersistedCache();
      await signOut();
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  },

  async getCurrentUser(): Promise<User> {
    try {
      const [user, sessionResult] = await Promise.all([
        getCurrentUser(),
        fetchAuthSession().catch(() => null),
      ]);
      let groups: string[] = [];
      const payload = sessionResult?.tokens?.idToken?.payload;
      const raw = payload?.['cognito:groups'];
      if (Array.isArray(raw)) groups = raw.map(String);
      const identityProvider =
        typeof payload?.['custom:identity_provider'] === 'string'
          ? payload['custom:identity_provider']
          : undefined;
      // Hosted SSO tokens intentionally cannot call Cognito's GetUser API.
      // Their requested OIDC scopes put the readable profile claims in the ID
      // token. Local API-authenticated users retain GetUser profile updates.
      const attributes = identityProvider
        ? {
            email: typeof payload?.email === 'string' ? payload.email : undefined,
            name: typeof payload?.name === 'string' ? payload.name : undefined,
            'custom:display_name':
              typeof payload?.['custom:display_name'] === 'string'
                ? payload['custom:display_name']
                : undefined,
            'custom:avatar_url':
              typeof payload?.['custom:avatar_url'] === 'string'
                ? payload['custom:avatar_url']
                : undefined,
          }
        : await fetchUserAttributes();
      return {
        userId: user.userId,
        username: user.username,
        email: attributes.email,
        displayName:
          attributes['custom:display_name'] ||
          attributes.name ||
          attributes.email?.split('@')[0] ||
          user.username,
        avatarUrl: attributes['custom:avatar_url'],
        groups,
        identitySource: identityProvider ? 'sso' : 'cognito',
        identityProvider,
      };
    } catch (error) {
      console.error('Get current user error:', error);
      throw error;
    }
  },

  async updateProfile(displayName?: string, avatarUrl?: string): Promise<void> {
    const attrs: Record<string, string> = {};
    if (displayName !== undefined) attrs['custom:display_name'] = displayName;
    if (avatarUrl !== undefined) attrs['custom:avatar_url'] = avatarUrl;
    await updateUserAttributes({ userAttributes: attrs });
  },

  async getSession(): Promise<AuthSession | null> {
    try {
      const session = await fetchAuthSession();
      if (session.tokens) {
        return {
          accessToken: session.tokens.accessToken.toString(),
          idToken: session.tokens.idToken?.toString() || '',
          refreshToken: (session.tokens as any).refreshToken?.toString() || '',
        };
      }
      return null;
    } catch (error) {
      console.error('Get session error:', error);
      return null;
    }
  },

  async isAuthenticated(): Promise<boolean> {
    try {
      await getCurrentUser();
      return true;
    } catch {
      return false;
    }
  },
};
