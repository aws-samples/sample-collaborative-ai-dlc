import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { IntentArtifact } from '@/services/intents';

/**
 * Explains a body the viewer cannot show: still loading (paged in after the
 * intent detail), too large, or failed. Renders nothing once a body is loaded.
 */
export function ArtifactBodyStatus({
  artifact,
  onRetry,
  className,
}: {
  artifact: Pick<IntentArtifact, 'content' | 'contentUnavailable'>;
  /** Shown as a Retry button after a failed load. */
  onRetry?: () => void;
  className?: string;
}) {
  const unavailable = artifact.contentUnavailable ?? null;

  if (unavailable === 'too_large') {
    return (
      <p role="status" className={cn('text-xs text-muted-foreground', className)}>
        This document is too large to display here.
      </p>
    );
  }
  if (unavailable === 'error') {
    return (
      <div
        role="alert"
        className={cn('flex items-center gap-2 text-xs text-destructive', className)}
      >
        The document couldn't be loaded.
        {onRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (artifact.content === undefined) {
    return (
      <p
        role="status"
        className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}
      >
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading document…
      </p>
    );
  }
  return null;
}
