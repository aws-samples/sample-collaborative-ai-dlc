# Frontend Authentication Implementation

This implementation provides AWS Cognito authentication integration for the collaborative AI platform.

## Features

- AWS Amplify Auth integration
- React Context for state management
- Protected routes
- Session management
- Login/logout functionality

## Environment Variables

Make sure to set the following environment variables in your `.env` file:

```
VITE_AWS_REGION=us-east-1
VITE_AWS_USER_POOL_ID=your-user-pool-id
VITE_AWS_USER_POOL_CLIENT_ID=your-user-pool-client-id
```

## Usage

### AuthProvider

Wrap your app with the `AuthProvider`:

```tsx
import { AuthProvider } from './contexts/AuthContext';

function App() {
  return (
    <AuthProvider>
      {/* Your app components */}
    </AuthProvider>
  );
}
```

### useAuth Hook

Use the `useAuth` hook to access authentication state:

```tsx
import { useAuth } from './contexts/AuthContext';

function MyComponent() {
  const { user, isAuthenticated, login, logout } = useAuth();
  
  // Component logic
}
```

### Protected Routes

Wrap protected components with `ProtectedRoute`:

```tsx
import { ProtectedRoute } from './components/ProtectedRoute';

<Route 
  path="/dashboard" 
  element={
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  } 
/>
```

## Files Structure

- `src/services/auth.ts` - AWS Amplify auth service
- `src/contexts/AuthContext.tsx` - React context for auth state
- `src/components/ProtectedRoute.tsx` - Protected route wrapper
- `src/hooks/useAuthSession.ts` - Custom hook for auth session
- `src/pages/Login.tsx` - Login page with Cognito integration

## Authentication Flow

1. User enters credentials on login page
2. Credentials are sent to AWS Cognito via Amplify
3. On successful authentication, user data is stored in context
4. Protected routes check authentication status
5. Unauthenticated users are redirected to login
6. Logout clears user session and redirects to login