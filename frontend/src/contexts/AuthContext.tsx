import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { authService } from '../services/auth';
import type { User } from '../services/auth';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when the user belongs to the Cognito `platform-admin` group.
   *  UI-only soft gate — the backend independently enforces the same check. */
  isPlatformAdmin: boolean;
  needsNewPassword: boolean;
  needsDisplayName: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginWithSso: (providerName: string, returnTo: string) => Promise<void>;
  completeSsoLogin: () => Promise<string>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [needsDisplayName, setNeedsDisplayName] = useState(false);

  const checkAuthState = useCallback(async () => {
    try {
      const isAuth = await authService.isAuthenticated();
      if (isAuth) {
        const currentUser = await authService.getCurrentUser();
        setUser(currentUser);
        setNeedsDisplayName(!currentUser.displayName);
      }
    } catch (error) {
      console.error('Auth state check failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkAuthState();
  }, [checkAuthState]);

  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true);
    try {
      const result = await authService.login(username, password);
      if (result.nextStep === 'NEW_PASSWORD_REQUIRED') {
        setNeedsNewPassword(true);
      } else if (result.user) {
        setUser(result.user);
        setNeedsDisplayName(!result.user.displayName);
      }
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const completeNewPassword = useCallback(async (newPassword: string) => {
    setIsLoading(true);
    try {
      const authedUser = await authService.completeNewPassword(newPassword);
      setNeedsNewPassword(false);
      setUser(authedUser);
      setNeedsDisplayName(!authedUser.displayName);
    } catch (error) {
      console.error('Password change failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loginWithSso = useCallback(async (providerName: string, returnTo: string) => {
    setIsLoading(true);
    try {
      await authService.loginWithSso(providerName, returnTo);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const completeSsoLogin = useCallback(async () => {
    setIsLoading(true);
    try {
      const authedUser = await authService.completeSsoLogin();
      setUser(authedUser);
      setNeedsDisplayName(!authedUser.displayName);
      return authService.consumeReturnTo();
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setDisplayName = useCallback(async (name: string) => {
    setIsLoading(true);
    try {
      await authService.updateProfile(name);
      const updatedUser = await authService.getCurrentUser();
      setUser(updatedUser);
      setNeedsDisplayName(false);
    } catch (error) {
      console.error('Set display name failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setIsLoading(true);
    try {
      await authService.logout();
      setUser(null);
      setNeedsNewPassword(false);
      setNeedsDisplayName(false);
    } catch (error) {
      console.error('Logout failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      isPlatformAdmin: !!user?.groups?.includes('platform-admin'),
      needsNewPassword,
      needsDisplayName,
      login,
      loginWithSso,
      completeSsoLogin,
      completeNewPassword,
      setDisplayName,
      logout,
    }),
    [
      completeNewPassword,
      completeSsoLogin,
      isLoading,
      login,
      loginWithSso,
      logout,
      needsDisplayName,
      needsNewPassword,
      setDisplayName,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
