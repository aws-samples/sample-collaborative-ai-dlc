import * as React from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: string;
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A `StatusPill`; wraps under the title below `sm`. */
  status?: React.ReactNode;
  /** Badges and other short facts; wraps under the title below `sm`. */
  meta?: React.ReactNode;
  /** The one primary `Button`. */
  primaryAction?: React.ReactNode;
  backTo?: { href: string; label: string };
  className?: string;
}

function useOverflowTitle(title: string) {
  const ref = React.useRef<HTMLHeadingElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setOverflowing(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [title]);

  return { ref, overflowing };
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  status,
  meta,
  primaryAction,
  backTo,
  className,
}: PageHeaderProps) {
  const { ref, overflowing } = useOverflowTitle(title);

  return (
    <header
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}
    >
      <div className="min-w-0 flex-1">
        {backTo ? (
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground">
            <Link to={backTo.href}>
              <ArrowLeft aria-hidden="true" />
              {backTo.label}
            </Link>
          </Button>
        ) : null}
        {eyebrow ? <div className="mb-0.5 text-xs text-muted-foreground">{eyebrow}</div> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1
            ref={ref}
            title={overflowing ? title : undefined}
            className="min-w-0 max-w-full truncate text-xl font-semibold tracking-tight"
          >
            {title}
          </h1>
          {status || meta ? (
            <div
              data-slot="page-header-status"
              className="flex min-w-0 basis-full flex-wrap items-center gap-1.5 sm:basis-auto"
            >
              {status}
              {meta}
            </div>
          ) : null}
        </div>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {primaryAction ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {primaryAction}
        </div>
      ) : null}
    </header>
  );
}
