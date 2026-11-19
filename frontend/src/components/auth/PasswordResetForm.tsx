import { useState } from 'react';
import type React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { PASSWORD_POLICY_HINT, passwordPolicyError } from '@/lib/passwordPolicy';

interface Props {
  initialUsername: string;
  /** Why the reset was opened, when the user did not ask for it. */
  notice?: string;
  onDone: (username: string) => void;
  onCancel: () => void;
}

// Forgot-password flow for local Cognito accounts: request an emailed code,
// then set a new password with it.
export function PasswordResetForm({ initialUsername, notice, onDone, onCancel }: Props) {
  const { requestPasswordReset, confirmPasswordReset } = useAuth();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [username, setUsername] = useState(initialUsername);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setError('');
    setResent(false);
    setSubmitting(true);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setSubmitting(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      await requestPasswordReset(username.trim());
      setResent(step === 'confirm');
      setStep('confirm');
    });

  const handleRequest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return setError('Enter your email address');
    void sendCode();
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return setError('Enter the verification code');
    if (newPassword !== confirmPassword) return setError('Passwords do not match');
    const policyError = passwordPolicyError(newPassword);
    if (policyError) return setError(policyError);
    void run(async () => {
      await confirmPasswordReset(username.trim(), code.trim(), newPassword);
      onDone(username.trim());
    });
  };

  const errorBanner = error ? (
    <div role="alert" className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
      <p className="text-sm text-destructive">{error}</p>
    </div>
  ) : null;

  if (step === 'request') {
    return (
      <form onSubmit={handleRequest} className="space-y-4">
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        {errorBanner}
        <div>
          <Label htmlFor="resetUsername">Email</Label>
          <Input
            id="resetUsername"
            type="email"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@example.com"
            disabled={submitting}
            autoFocus
            className="mt-1"
          />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending...
            </>
          ) : (
            'Send verification code'
          )}
        </Button>
        <div className="flex justify-between">
          {/* An operator reset (admin-reset-user-password) already emailed a code. */}
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() => {
              if (!username.trim()) return setError('Enter your email address');
              setError('');
              setStep('confirm');
            }}
            disabled={submitting}
          >
            I already have a code
          </Button>
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={onCancel}
            disabled={submitting}
          >
            Back to sign in
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleConfirm} className="space-y-4">
      {/* The app client masks unknown accounts, so never confirm the account exists. */}
      <p className="text-sm text-muted-foreground">
        If an account exists for {username.trim()}, a verification code has been sent to its email
        address.
      </p>
      {resent && (
        <p role="status" className="text-sm text-emerald-700">
          A new verification code has been sent.
        </p>
      )}
      {errorBanner}
      <div>
        <Label htmlFor="resetCode">Verification code</Label>
        <Input
          id="resetCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={submitting}
          autoFocus
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="resetNewPw">New password</Label>
        <Input
          id="resetNewPw"
          type="password"
          autoComplete="new-password"
          aria-describedby="resetPolicyHint"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={submitting}
          className="mt-1"
        />
        <p id="resetPolicyHint" className="mt-1 text-xs text-muted-foreground">
          {PASSWORD_POLICY_HINT}
        </p>
      </div>
      <div>
        <Label htmlFor="resetConfirmPw">Confirm new password</Label>
        <Input
          id="resetConfirmPw"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={submitting}
          className="mt-1"
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Resetting...
          </>
        ) : (
          'Reset password'
        )}
      </Button>
      <div className="flex justify-between">
        <Button
          type="button"
          variant="link"
          className="px-0"
          onClick={() => void sendCode()}
          disabled={submitting}
        >
          Resend code
        </Button>
        <Button
          type="button"
          variant="link"
          className="px-0"
          onClick={onCancel}
          disabled={submitting}
        >
          Back to sign in
        </Button>
      </div>
    </form>
  );
}
