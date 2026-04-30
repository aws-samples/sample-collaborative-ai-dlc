import { Amplify } from 'aws-amplify';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes, confirmSignIn, updateUserAttributes } from 'aws-amplify/auth';

// Configure Amplify
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_AWS_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_AWS_USER_POOL_CLIENT_ID,
    }
  }
});

export interface User {
  username: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
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
      // Clear any existing session first
      try {
        await signOut();
      } catch {
        // Ignore - user might not be signed in
      }
      
      const result = await signIn({ username, password });
      
      if (result.isSignedIn) {
        return { user: await this.getCurrentUser() };
      }
      
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        return { nextStep: 'NEW_PASSWORD_REQUIRED' };
      }
      
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_SMS_CODE' || 
          result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        return { nextStep: 'MFA_REQUIRED' };
      }
      
      throw new Error('Sign in failed');
    } catch (error: any) {
      console.error('Login error:', error);
      if (error.name === 'NotAuthorizedException') {
        throw new Error('Incorrect username or password');
      }
      if (error.name === 'UserNotFoundException') {
        throw new Error('User does not exist');
      }
      if (error.name === 'UserNotConfirmedException') {
        throw new Error('User is not confirmed');
      }
      throw error;
    }
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
        throw new Error('Password does not meet requirements');
      }
      throw error;
    }
  },

  async logout(): Promise<void> {
    try {
      await signOut();
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  },

  async getCurrentUser(): Promise<User> {
    try {
      const user = await getCurrentUser();
      const attributes = await fetchUserAttributes();
      return {
        username: user.username,
        email: attributes.email,
        displayName: attributes['custom:display_name'] || attributes.email?.split('@')[0],
        avatarUrl: attributes['custom:avatar_url'],
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
          refreshToken: (session.tokens as any).refreshToken?.toString() || ''
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
  }
};