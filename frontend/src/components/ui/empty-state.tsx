import * as React from 'react';
import { CircleAlert, RotateCw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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

export interface ErrorStateProps {
  title: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  /** Reconnect / Request access when a plain retry is not the safe recovery. */
  secondaryAction?: React.ReactNode;
  /** Announce as `role="alert"` (only for errors that interrupt an ongoing task). */
  live?: boolean;
  size?: StateSize;
  headingLevel?: HeadingLevel;
  className?: string;
}

export function ErrorState({
  title,
  description,
  onRetry,
  retrying = false,
  secondaryAction,
  live = false,
  size = 'page',
  headingLevel = 3,
  className,
}: ErrorStateProps) {
  const isPage = size === 'page';
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      role={live ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 text-center',
        isPage ? 'px-6 py-12' : 'px-4 py-8',
        className,
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className={cn('mb-3 text-destructive', isPage ? 'h-7 w-7' : 'h-5 w-5')}
      />
      <Heading className={cn('font-semibold', isPage ? 'text-lg' : 'text-sm')}>{title}</Heading>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {onRetry || secondaryAction ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry} loading={retrying}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          ) : null}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

export interface LoadingStateProps {
  label: string;
  lines?: number;
  className?: string;
}

export function LoadingState({ label, lines = 3, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn('space-y-3 rounded-lg border p-4', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-4', index === 0 ? 'w-1/3' : index % 2 ? 'w-full' : 'w-2/3')}
        />
      ))}
    </div>
  );
}
