import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ageLabel } from '@/lib/statusModel';
import { formatAbsolute, formatRelative } from '@/lib/timeAgo';
import { cn } from '@/lib/utils';

export interface RelativeTimeProps {
  value: Date | string | number | null | undefined;
  /** Leading words, e.g. "Updated" → "Updated 3h ago". */
  prefix?: string;
  /** Injected clock for stable tests. */
  now?: Date | string | number;
  /** At or beyond this many days the text becomes an absolute date (default 30). */
  absoluteAfterDays?: number;
  /**
   * `relative` (default): "3h ago", then an absolute date past `absoluteAfterDays`.
   * `age`: "Failed 59 days ago" — the same words as `ageLabel`, never an
   * absolute date, so a list row and the Spaces inbox read one grammar for
   * the same fact (review R3-6). The exact timestamp stays in the tooltip.
   */
  format?: 'relative' | 'age';
  className?: string;
}

/**
 * Relative age ("3h ago") in a `<time dateTime>` element, with the exact
 * timestamp ("5 Aug 2026, 14:08") in a tooltip on hover or focus. One column
 * never mixes "1d ago" with a locale date string. Missing / invalid → "—".
 */
export function RelativeTime({
  value,
  prefix,
  now,
  absoluteAfterDays,
  format = 'relative',
  className,
}: RelativeTimeProps) {
  const date =
    value instanceof Date ? value : value == null || value === '' ? null : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) {
    return (
      <span className={cn('text-muted-foreground', className)} aria-label="Date not available">
        —
      </span>
    );
  }

  const relative =
    format === 'age'
      ? `${ageLabel(date.getTime(), now == null ? Date.now() : new Date(now).getTime())} ago`
      : formatRelative(date, { now, absoluteAfterDays });
  const absolute = formatAbsolute(date);

  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)}>
      {prefix ? `${prefix} ` : null}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <time
              dateTime={date.toISOString()}
              tabIndex={0}
              className="inline-flex min-h-6 cursor-default items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {relative}
            </time>
          </TooltipTrigger>
          <TooltipContent>{absolute}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
