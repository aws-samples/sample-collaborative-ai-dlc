import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Status = 'loading' | 'success' | 'error' | 'custom';

const BACK_LABELS: Record<string, string> = {
  '/dashboard': 'Back to spaces',
};

interface Props {
  status: Status;
  providerLabel: string;
  loadingMessage?: string;
  successMessage?: string;
  errorMessage?: string | null;
  /** For `error`, from `useOAuthReturnPath`: the space settings, or the Spaces dashboard. */
  backTo?: string;
  // For multi-step callbacks (e.g. Jira's site picker) callers render their
  // own UI alongside the standard shell. Provide it as `children` and pass
  // status='custom' to suppress the built-in spinner/check/error blocks.
  children?: ReactNode;
}

// Centered spinner / green check / red X card used by both /github/callback
// and /trackers/callback/jira-cloud. Both pages used to copy-paste this
// JSX wholesale; consolidating here keeps the visual identity consistent.
export function OAuthCallbackShell({
  status,
  providerLabel,
  loadingMessage,
  successMessage,
  errorMessage,
  backTo,
  children,
}: Props) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md space-y-3 p-6 text-center" aria-live="polite">
        {status === 'loading' && (
          <>
            <Loader2
              aria-hidden="true"
              className="mx-auto h-5 w-5 text-muted-foreground motion-safe:animate-spin"
            />
            <h1 className="font-semibold">{loadingMessage ?? `Connecting ${providerLabel}…`}</h1>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 aria-hidden="true" className="mx-auto h-6 w-6 text-primary" />
            <h1 className="font-semibold">{successMessage ?? `${providerLabel} connected`}</h1>
          </>
        )}
        {status === 'error' && (
          <>
            <CircleAlert aria-hidden="true" className="mx-auto h-6 w-6 text-destructive" />
            <h1 className="font-semibold">{providerLabel} connection incomplete</h1>
            {errorMessage && (
              <p className="break-words text-sm text-muted-foreground">{errorMessage}</p>
            )}
            {backTo && (
              <Button asChild variant="outline">
                <Link to={backTo} replace>
                  {BACK_LABELS[backTo] ?? 'Back to space settings'}
                </Link>
              </Button>
            )}
          </>
        )}
        {status === 'custom' && children}
      </Card>
    </main>
  );
}
