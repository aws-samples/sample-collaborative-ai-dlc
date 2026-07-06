// Shared card shell for the Platform Admin page: icon tile + title + status
// pill + one-line description, then content. Gives every settings card the
// same visual rhythm instead of ad-hoc headers.

import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  icon: ReactNode;
  title: ReactNode;
  /** Status pill(s) rendered next to the title. */
  badge?: ReactNode;
  /** Keep it to one line — details belong in the content or a setup guide. */
  description?: ReactNode;
  /** Right-aligned header slot (e.g. a counter or quick action). */
  headerAction?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AdminCard({
  icon,
  title,
  badge,
  description,
  headerAction,
  children,
  className,
}: Props) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-gradient-to-b from-muted/30 to-muted/70 text-foreground [&_svg]:h-[18px] [&_svg]:w-[18px]">
          {icon}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold leading-none tracking-tight">{title}</h3>
            {badge}
          </div>
          {description && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {headerAction && <div className="shrink-0 pt-0.5">{headerAction}</div>}
      </div>
      <CardContent className="px-5 pb-5 pt-0">{children}</CardContent>
    </Card>
  );
}
