import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type StateSize = 'page' | 'section';
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const containerClass: Record<StateSize, string> = {
  page: 'rounded-lg border border-dashed px-6 py-16',
  section: 'rounded-lg border border-dashed px-4 py-8',
};

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** The single primary call to action (a `Button`). */
  action?: React.ReactNode;
  size?: StateSize;
  /** Heading level of the title (default 3). A page whose only heading is this state (404) passes 1. */
  headingLevel?: HeadingLevel;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'page',
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const isPage = size === 'page';
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        containerClass[size],
        className,
      )}
    >
      {Icon ? (
        <div
          aria-hidden="true"
          className={cn(
            'mb-4 flex items-center justify-center rounded-full bg-muted text-muted-foreground',
            isPage ? 'h-14 w-14 [&>svg]:size-7' : 'h-10 w-10 [&>svg]:size-5',
          )}
        >
          <Icon />
        </div>
      ) : null}
      <Heading className={cn('font-semibold', isPage ? 'text-lg' : 'text-sm')}>{title}</Heading>
      {description ? (
        <p
          className={cn(
            'mt-1 max-w-sm text-muted-foreground',
            isPage ? 'text-sm' : 'text-xs leading-snug',
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-center gap-2',
            isPage ? 'mt-6' : 'mt-4',
          )}
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}
