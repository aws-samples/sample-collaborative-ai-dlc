import React from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { Loader2 } from 'lucide-react';

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
      <div
        role="status"
        className="min-h-screen flex items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />
        Loading workspace…
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
