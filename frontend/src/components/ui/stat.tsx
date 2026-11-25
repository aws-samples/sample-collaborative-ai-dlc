import * as React from 'react';
import { cn } from '@/lib/utils';

type StatState = 'ok' | 'missing' | 'estimated';

export interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** `missing` shows "Not available" (never a fake 0); `estimated` prefixes "≈". */
  state?: StatState;
  size?: 'default' | 'lg';
  className?: string;
}

const MISSING_LABEL = 'Not available';

export function Stat({ label, value, hint, state = 'ok', size = 'default', className }: StatProps) {
  const valueClass = cn(
    'tabular-nums',
    size === 'lg' ? 'text-lg font-semibold leading-tight' : 'text-sm font-medium',
  );

  return (
    <div className={cn('min-w-0 break-words', className)} data-state={state}>
      <div className="text-xs text-muted-foreground">{label}</div>
      {state === 'missing' ? (
        <div className={cn(valueClass, 'font-normal text-muted-foreground')}>{MISSING_LABEL}</div>
      ) : (
        <div className={valueClass}>
          {state === 'estimated' ? (
            <span className="mr-0.5 text-muted-foreground" title="Estimated">
              ≈
            </span>
          ) : null}
          {value}
        </div>
      )}
      {hint ? (
        <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

export interface MetricRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/** Inline row for 2–5 numbers; wraps on narrow widths. Prefer this over a card grid. */
export function MetricRow({ className, children, ...props }: MetricRowProps) {
  return (
    <div
      role="group"
      className={cn(
        'flex flex-wrap gap-x-5 gap-y-3 [&>*+*]:border-l [&>*+*]:border-border [&>*+*]:pl-5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
