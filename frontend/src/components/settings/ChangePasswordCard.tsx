import { useId, useState } from 'react';
import type React from 'react';
import { CheckCircle2, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { useAuth } from '@/contexts/AuthContext';
import { PASSWORD_POLICY_HINT, passwordPolicyError } from '@/lib/passwordPolicy';

// Change the sign-in password of a local Cognito account. Federated users are
// not offered this: their credentials belong to the external identity provider.
export function ChangePasswordCard() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const ids = { current: useId(), next: useId(), confirm: useId(), hint: useId() };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setChanged(false);
    if (!current) return setError('Enter your current password');
    if (next !== confirm) return setError('New passwords do not match');
    if (next === current) return setError('New password must differ from the current one');
    const policyError = passwordPolicyError(next);
    if (policyError) return setError(policyError);
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setChanged(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Password change failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsCard
      icon={<Lock />}
      title="Sign-in password"
      description="Change the password you use to sign in to AI-DLC."
    >
      <form onSubmit={handleSubmit} className="max-w-sm space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {changed && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> Password changed.
          </p>
        )}
        <div>
          <Label htmlFor={ids.current}>Current password</Label>
          <Input
            id={ids.current}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={submitting}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={ids.next}>New password</Label>
          <Input
            id={ids.next}
            type="password"
            autoComplete="new-password"
            aria-describedby={ids.hint}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={submitting}
            className="mt-1"
          />
          <p id={ids.hint} className="mt-1 text-xs text-muted-foreground">
            {PASSWORD_POLICY_HINT}
          </p>
        </div>
        <div>
          <Label htmlFor={ids.confirm}>Confirm new password</Label>
          <Input
            id={ids.confirm}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
            className="mt-1"
          />
        </div>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Changing...
            </>
          ) : (
            'Change password'
          )}
        </Button>
      </form>
    </SettingsCard>
  );
}
