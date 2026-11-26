import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Makes this skeleton the loading status for its region. Omit it inside a labelled group. */
  label?: string;
}

function Skeleton({ className, label, ...props }: SkeletonProps) {
  const classes = cn('animate-pulse rounded-md bg-primary/10', className);
  if (!label) return <div aria-hidden="true" className={classes} {...props} />;
  return (
    <div role="status" aria-busy="true" aria-label={label} className={classes} {...props}>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export { Skeleton };
