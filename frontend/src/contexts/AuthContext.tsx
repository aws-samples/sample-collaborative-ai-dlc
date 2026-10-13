import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import { authService } from '../services/auth';
import type { User } from '../services/auth';
import {
  armSessionExpiry,
  currentSessionEpoch,
  isSessionActive,
  onSessionExpired,
  resetSessionExpiry,
} from '../services/sessionExpiry';

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

// For presence labels in surfaces that also render outside the signed-in shell
// (isolated previews/tests). Never use this for an authorization decision.
export const useOptionalAuth = () => useContext(AuthContext) ?? null;

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
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  useEffect(
    () =>
      onSessionExpired(() => {
        const wasSignedIn = userRef.current !== null;
        setUser(null);
        setNeedsNewPassword(false);
        setNeedsDisplayName(false);
        // Nobody was signed in (e.g. an API call from a public route): there is
        // no Amplify state or persisted cache to tear down.
        if (!wasSignedIn) return;
        // Best-effort: the session may already be invalid server-side.
        void authService.logout().catch((error) => {
          console.error('Sign-out after session expiry failed:', error);
        });
      }),
    [],
  );

  const checkAuthState = useCallback(async () => {
    const epoch = currentSessionEpoch();
    try {
      const isAuth = await authService.isAuthenticated();
      if (isAuth && epoch === currentSessionEpoch() && isSessionActive()) {
        // Re-arm without a new epoch: requests fired at mount carry the current
        // one and their 401s must still be able to report an expiry.
        armSessionExpiry();
        const currentUser = await authService.getCurrentUser();
        if (epoch !== currentSessionEpoch() || !isSessionActive()) return;
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
      resetSessionExpiry();
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
      resetSessionExpiry();
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
      resetSessionExpiry();
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
    const pending = authService.logout();
    // logout invalidates synchronously, before waiting for Cognito. Its late
    // completion must not clear a replacement login in this browser.
    const epoch = currentSessionEpoch();
    try {
      await pending;
      if (epoch !== currentSessionEpoch()) return;
      setUser(null);
      setNeedsNewPassword(false);
      setNeedsDisplayName(false);
    } catch (error) {
      console.error('Logout failed:', error);
      throw error;
    } finally {
      if (epoch === currentSessionEpoch()) setIsLoading(false);
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
