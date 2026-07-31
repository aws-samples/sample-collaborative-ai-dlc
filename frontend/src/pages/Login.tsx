import React, { useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/contexts/AuthContext';
import { authConfiguration } from '@/services/auth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Building2, FolderGit2, Loader2, LogIn } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    login,
    loginWithSso,
    completeNewPassword,
    setDisplayName: saveDisplayName,
    isAuthenticated,
    needsNewPassword,
    needsDisplayName,
  } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/dashboard';
  const localEnabled = authConfiguration.mode !== 'sso-only';
  const ssoEnabled = authConfiguration.mode !== 'local';

  useEffect(() => {
    if (isAuthenticated && !needsDisplayName) setError('');
  }, [isAuthenticated, needsDisplayName]);

  // Paint the form immediately while the session check runs; the Navigate
  // below still redirects as soon as an existing session resolves.
  if (isAuthenticated && !needsDisplayName) return <Navigate to={from} replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await login(username, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSsoLogin = async (providerName: string) => {
    setError('');
    setIsSubmitting(true);
    try {
      await loginWithSso(providerName, from);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Enterprise sign-in failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }
    setIsSubmitting(true);
    try {
      await completeNewPassword(newPassword);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!displayName.trim() || displayName.trim().length < 2) {
      setError('Display name must be at least 2 characters');
      return;
    }
    setIsSubmitting(true);
    try {
      await saveDisplayName(displayName.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set display name');
    } finally {
      setIsSubmitting(false);
    }
  };

  const errorBanner = error ? (
    <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3">
      <p className="text-sm text-destructive">{error}</p>
    </div>
  ) : null;

  if (needsDisplayName) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <FolderGit2 className="h-5 w-5 text-primary-foreground" />
              </div>
            </div>
            <CardTitle>Set your display name</CardTitle>
            <CardDescription>This name will be visible to other collaborators</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleDisplayName} className="space-y-4">
              {errorBanner}
              <div>
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  disabled={isSubmitting}
                  autoFocus
                  className="mt-1"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                  </>
                ) : (
                  'Continue'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (needsNewPassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <FolderGit2 className="h-5 w-5 text-primary-foreground" />
              </div>
            </div>
            <CardTitle>Set new password</CardTitle>
            <CardDescription>Please set a new password for your account</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleNewPassword} className="space-y-4">
              {errorBanner}
              <div>
                <Label htmlFor="newPw">New Password</Label>
                <Input
                  id="newPw"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password"
                  disabled={isSubmitting}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="confirmPw">Confirm Password</Label>
                <Input
                  id="confirmPw"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  disabled={isSubmitting}
                  className="mt-1"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Setting...
                  </>
                ) : (
                  'Set Password'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
              <FolderGit2 className="h-5 w-5 text-primary-foreground" />
            </div>
          </div>
          <CardTitle>Sign in to AI-DLC</CardTitle>
          <CardDescription>Collaborative AI-Driven Development</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {errorBanner}
          {ssoEnabled && (
            <section aria-labelledby="enterprise-sso-heading" className="space-y-3">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <h2 id="enterprise-sso-heading" className="text-sm font-medium">
                  Enterprise SSO
                </h2>
              </div>
              <div className="space-y-2">
                {authConfiguration.providers.map((provider) => (
                  <Button
                    key={provider.name}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                    disabled={isSubmitting}
                    onClick={() => handleSsoLogin(provider.name)}
                  >
                    {isSubmitting ? (
                      <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <LogIn className="mr-2 h-4 w-4 shrink-0" />
                    )}
                    <span className="min-w-0 break-words">
                      Continue with {provider.displayName}
                    </span>
                  </Button>
                ))}
              </div>
            </section>
          )}
          {ssoEnabled && localEnabled && (
            <div className="flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          {localEnabled && (
            <section aria-labelledby="cognito-account-heading" className="space-y-3">
              <h2
                id="cognito-account-heading"
                className={ssoEnabled ? 'text-sm font-medium' : 'sr-only'}
              >
                Cognito account
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username or email"
                    disabled={isSubmitting}
                    autoFocus={!ssoEnabled}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    disabled={isSubmitting}
                    className="mt-1"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in...
                    </>
                  ) : (
                    'Sign in'
                  )}
                </Button>
              </form>
            </section>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
