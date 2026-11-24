import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
  decorative?: boolean;
}

function Skeleton({ className, label = 'Loading', decorative = false, ...props }: SkeletonProps) {
  const classes = cn('animate-pulse rounded-md bg-primary/10', className);
  if (decorative) {
    return <div aria-hidden="true" className={classes} {...props} />;
  }
  return (
    <div role="status" aria-busy="true" aria-label={label} className={classes} {...props}>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export { Skeleton };
