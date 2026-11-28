import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',
        outline: 'text-foreground',
        inception: 'border-transparent bg-phase-inception text-phase-inception-foreground',
        construction: 'border-transparent bg-phase-construction text-phase-construction-foreground',
        review: 'border-transparent bg-phase-review text-phase-review-foreground',
        initialization:
          'border-transparent bg-phase-initialization text-phase-initialization-foreground',
        ideation: 'border-transparent bg-phase-ideation text-phase-ideation-foreground',
        operation: 'border-transparent bg-phase-operation text-phase-operation-foreground',
        warning: 'border-transparent bg-warning/15 text-warning-fg',
      },
      size: {
        default: 'gap-1.5 px-2.5 py-0.5 text-xs [&_svg]:size-3.5',
        sm: 'h-5 gap-1 px-1.5 text-2xs [&_svg]:size-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

// Renders a <span> so a Badge stays valid phrasing content inside <button>, <summary>, <p>.
function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
