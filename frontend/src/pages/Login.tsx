import React, { useState, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/contexts/AuthContext';
import { authConfiguration } from '@/services/auth';
import { PasswordResetRequiredError } from '@/services/authErrors';
import { PasswordResetForm } from '@/components/auth/PasswordResetForm';
import { PASSWORD_POLICY_HINT, passwordPolicyError } from '@/lib/passwordPolicy';
import { Card, CardContent, CardHeader, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Building2, FolderGit2, Loader2, LogIn } from 'lucide-react';
import { BrandMark } from '@/components/layout/BrandMark';
import { getBranding } from '@/lib/branding';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Forgot-password flow; `notice` is set when sign-in itself demanded a reset.
  const [reset, setReset] = useState<{ notice?: string } | null>(null);

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
  const origin = (location.state as { from?: { pathname: string; search?: string; hash?: string } })
    ?.from;
  const from =
    origin?.pathname?.startsWith('/') && !origin.pathname.startsWith('//')
      ? `${origin.pathname}${origin.search ?? ''}${origin.hash ?? ''}`
      : '/dashboard';
  const localEnabled = authConfiguration.mode !== 'sso-only';
  const ssoEnabled = authConfiguration.mode !== 'local';

  useEffect(() => {
    if (isAuthenticated && !needsDisplayName) setError('');
  }, [isAuthenticated, needsDisplayName]);

  useEffect(() => {
    const previous = document.title;
    document.title = `Sign in · ${getBranding().name}`;
    return () => {
      document.title = previous;
    };
  }, []);

  // Paint the form immediately while the session check runs; the Navigate
  // below still redirects as soon as an existing session resolves.
  if (isAuthenticated && !needsDisplayName) return <Navigate to={from} replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setIsSubmitting(true);
    try {
      await login(username, password);
    } catch (err: unknown) {
      if (err instanceof PasswordResetRequiredError) {
        setPassword('');
        setReset({ notice: `${err.message} Request a verification code to set a new one.` });
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
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
    const policyError = passwordPolicyError(newPassword);
    if (policyError) {
      setError(policyError);
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
    <div role="alert" className="rounded-md bg-destructive/10 border border-destructive/20 p-3">
      <p className="text-sm text-destructive">{error}</p>
    </div>
  ) : null;

  if (reset && localEnabled) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <h1 className="font-semibold leading-none tracking-tight">Reset your password</h1>
            <CardDescription>We will email a verification code to your account</CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordResetForm
              initialUsername={username}
              notice={reset.notice}
              onCancel={() => setReset(null)}
              onDone={(resetUsername) => {
                setUsername(resetUsername);
                setPassword('');
                setError('');
                setInfo('Password reset. Sign in with your new password.');
                setReset(null);
              }}
            />
            {ssoEnabled && (
              <p className="mt-4 text-xs text-muted-foreground">
                This resets Cognito account passwords only. For an Enterprise SSO account, reset
                your password with your identity provider.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  if (needsDisplayName) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <FolderGit2 className="h-5 w-5 text-primary-foreground" />
              </div>
            </div>
            <h1 className="font-semibold leading-none tracking-tight">Set your display name</h1>
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
      </main>
    );
  }

  if (needsNewPassword) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <FolderGit2 className="h-5 w-5 text-primary-foreground" />
              </div>
            </div>
            <h1 className="font-semibold leading-none tracking-tight">Set a new password</h1>
            <CardDescription>
              Your account was created with a temporary password. Choose your own to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleNewPassword} className="space-y-4">
              {errorBanner}
              <div>
                <Label htmlFor="newPw">New password</Label>
                <Input
                  id="newPw"
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="newPwPolicyHint"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={isSubmitting}
                  autoFocus
                  className="mt-1"
                />
                <p id="newPwPolicyHint" className="mt-1 text-xs text-muted-foreground">
                  {PASSWORD_POLICY_HINT}
                </p>
              </div>
              <div>
                <Label htmlFor="confirmPw">Confirm new password</Label>
                <Input
                  id="confirmPw"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isSubmitting}
                  className="mt-1"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                  </>
                ) : (
                  'Set password'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <BrandMark
              wordmarkClassName="h-9"
              fallback={
                <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                  <FolderGit2 className="h-5 w-5 text-primary-foreground" />
                </div>
              }
            />
          </div>
          <h1 className="font-semibold leading-none tracking-tight">Sign in to AI-DLC</h1>
          <CardDescription>Collaborative AI-Driven Development</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {errorBanner}
          {info && (
            <div
              role="status"
              className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3"
            >
              <p className="text-sm text-emerald-700">{info}</p>
            </div>
          )}
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
                <Button
                  type="button"
                  variant="link"
                  className="h-auto w-full p-0 text-xs"
                  disabled={isSubmitting}
                  onClick={() => {
                    setError('');
                    setInfo('');
                    setReset({});
                  }}
                >
                  Forgot password?
                </Button>
              </form>
            </section>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
