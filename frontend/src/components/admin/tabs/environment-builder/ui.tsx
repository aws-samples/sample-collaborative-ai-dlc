import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export const ACTIVE_REVISION_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING', 'VERIFYING']);

export const statusClass = (status: string) => {
  if (status === 'FAILED') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'PUBLISHED' || status === 'READY') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (status === 'SECURITY_REVIEW' || status === 'UPDATE_AVAILABLE') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  if (ACTIVE_REVISION_STATUSES.has(status)) {
    return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
  }
  return 'bg-muted/50 text-muted-foreground';
};

export const severityClass = (severity: string) => {
  if (severity === 'CRITICAL') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (severity === 'HIGH') {
    return 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300';
  }
  if (severity === 'MEDIUM') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'bg-muted/50 text-muted-foreground';
};

export const statusLabel = (status: string) => {
  const labels: Record<string, string> = {
    DRAFT: 'Ready to build',
    QUEUED: 'In progress',
    BUILDING: 'In progress',
    SCANNING: 'In progress',
    SECURITY_REVIEW: 'Action required',
    VERIFYING: 'In progress',
    READY: 'Ready to publish',
    PUBLISHED: 'Published',
    FAILED: 'Needs attention',
    SUPERSEDED: 'Previous revision',
    RETIRED: 'Retired',
    UPDATE_AVAILABLE: 'Update available',
  };
  return labels[status] ?? status.replaceAll('_', ' ');
};

export function StatusBadge({
  status,
  className,
  technical = false,
}: {
  status: string;
  className?: string;
  technical?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        technical && 'font-mono',
        'text-[10px] font-medium',
        statusClass(status),
        className,
      )}
    >
      {technical ? status.replaceAll('_', ' ') : statusLabel(status)}
    </Badge>
  );
}

export function Section({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3.5">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {badge}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ProcessOverview({
  title = 'How this works',
  steps,
  activeIndex = 0,
}: {
  title?: string;
  steps: { label: string; description: string }[];
  activeIndex?: number;
}) {
  const activeStep = steps[activeIndex] ?? steps[0];
  return (
    <section aria-label={title} className="rounded-lg border bg-muted/10 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <ol className="flex flex-wrap items-center gap-1.5">
          {steps.map((step, index) => (
            <li key={step.label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold text-muted-foreground',
                  index === activeIndex && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  'text-[11px] text-muted-foreground',
                  index === activeIndex && 'font-semibold text-foreground',
                )}
              >
                {step.label}
              </span>
              {index < steps.length - 1 && (
                <span aria-hidden="true" className="text-[10px] text-muted-foreground/60">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
      {activeStep && (
        <p className="mt-2 border-t pt-2 text-[10px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Current: {activeStep.label}.</span>{' '}
          {activeStep.description}
        </p>
      )}
    </section>
  );
}

export function Disclosure({
  title,
  icon,
  children,
  defaultOpen = false,
  className,
  contentClassName,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <div className="overflow-hidden rounded-xl border bg-background">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={title}
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          >
            <span className="flex items-center gap-2 text-xs font-semibold">
              {icon}
              {title}
            </span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className={cn('border-t p-3', contentClassName)}>{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
