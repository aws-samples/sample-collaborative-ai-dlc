import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { authService } from '../services/auth';
import type { User } from '../services/auth';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsNewPassword: boolean;
  needsDisplayName: boolean;
  login: (username: string, password: string) => Promise<void>;
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

  useEffect(() => {
    checkAuthState();
  }, []);

  const checkAuthState = async () => {
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
  };

  const login = async (username: string, password: string) => {
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
  };

  const completeNewPassword = async (newPassword: string) => {
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
  };

  const setDisplayName = async (name: string) => {
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
  };

  const logout = async () => {
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
  };

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    needsNewPassword,
    needsDisplayName,
    login,
    completeNewPassword,
    setDisplayName,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
