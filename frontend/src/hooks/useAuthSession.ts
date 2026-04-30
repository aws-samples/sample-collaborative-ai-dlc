import { useAuth } from '../contexts/AuthContext';

export const useAuthSession = () => {
  const { user, isAuthenticated, isLoading } = useAuth();
  
  return {
    user,
    isAuthenticated,
    isLoading,
    username: user?.username,
    displayName: user?.displayName,
    avatarUrl: user?.avatarUrl,
  };
};