import { FileQuestion } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export const INTENT_NOT_FOUND_TITLE = 'This intent no longer exists';
export const INTENT_NOT_FOUND_DESCRIPTION = 'It may have been deleted, or the link is out of date.';

/**
 * The one state every intent page (Overview, Work, Graph, Audit, Compose)
 * shows when the detail request answered 404/410: a gone intent is not a
 * connection problem, so there is nothing to retry — only a way back.
 */
export function IntentNotFoundState({
  spacePath,
  headingLevel = 1,
  className,
}: {
  spacePath: string;
  headingLevel?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <EmptyState
      icon={FileQuestion}
      headingLevel={headingLevel}
      className={className ?? 'mx-auto mt-8 w-full max-w-lg'}
      title={INTENT_NOT_FOUND_TITLE}
      description={INTENT_NOT_FOUND_DESCRIPTION}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to={spacePath}>Back to space</Link>
        </Button>
      }
    />
  );
}
