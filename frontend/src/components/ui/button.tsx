import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-7 gap-1 rounded-md px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Shows a centered spinner over the (still measured, still announced) label so the
   * button keeps its width, marks the button `aria-busy` and disables it. Ignored with
   * `asChild`, where the rendered child owns its own content.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }), loading && 'relative')}
        ref={ref}
        aria-busy={loading || undefined}
        {...props}
        disabled={props.disabled || loading}
      >
        {loading ? (
          <>
            <Loader2
              aria-hidden="true"
              className="absolute inset-0 m-auto motion-safe:animate-spin"
            />
            <span className="inline-flex items-center justify-center gap-[inherit] opacity-0">
              {children}
            </span>
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
