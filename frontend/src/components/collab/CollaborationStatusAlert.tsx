import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useReportCollaboration } from '@/components/layout/StatusBar';
import { cn } from '@/lib/utils';
import type { YjsConnection } from '@/hooks/useYjsDocument';

/** A connection faster than this stays silent; slower ones get the subtle hint. */
export const CONNECTING_HINT_AFTER_MS = 1500;

const CONSEQUENCE = {
  answers: "Answers can't be submitted until it reconnects.",
  draft: "Edits to this draft can't be saved until it reconnects.",
} as const;

/**
 * Below `sm` the action wraps under the message, aligned with the text (icon
 * 16 px + gap 12 px), instead of squeezing the message into a narrow column.
 */
const STACK_ACTION_BELOW_SM =
  'max-sm:flex-wrap max-sm:[&>div:last-child]:basis-full max-sm:[&>div:last-child]:self-start max-sm:[&>div:last-child]:pl-7';

export interface CollaborationStatusAlertProps {
  connection: YjsConnection;
  onRetry: () => void;
  context: keyof typeof CONSEQUENCE;
  className?: string;
}

export function CollaborationStatusAlert({
  connection,
  onRetry,
  context,
  className,
}: CollaborationStatusAlertProps) {
  const [slow, setSlow] = useState(false);
  const [retryRequested, setRetryRequested] = useState(false);
  useReportCollaboration(connection);

  useEffect(() => {
    if (connection !== 'connecting') {
      setRetryRequested(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), CONNECTING_HINT_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [connection]);

  if (connection === 'synced') return null;

  // The warning stays mounted while the user's retry is in flight, so it is
  // neither re-announced nor swapped for the hint and back on a failed retry.
  const retrying = retryRequested && connection === 'connecting';
  if (connection === 'unavailable' || retrying) {
    return (
      <Alert
        tone="warning"
        live
        title="Live collaboration is unavailable"
        className={cn(STACK_ACTION_BELOW_SM, className)}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={retrying}
            onClick={() => {
              setRetryRequested(true);
              onRetry();
            }}
          >
            Retry now
          </Button>
        }
      >
        <AlertDescription className="text-muted-foreground-on-tint">
          {CONSEQUENCE[context]}
        </AlertDescription>
      </Alert>
    );
  }

  if (!slow) return null;
  return (
    <p
      role="status"
      className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}
    >
      <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
      Connecting to live collaboration…
    </p>
  );
}
