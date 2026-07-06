import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** When true, additionally requires membership in the Cognito
   *  `platform-admin` group. UI-only soft gate — the backend enforces the
   *  same check on every admin endpoint. */
  requirePlatformAdmin?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requirePlatformAdmin = false,
}) => {
  const { isAuthenticated, isLoading, isPlatformAdmin } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requirePlatformAdmin && !isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};
