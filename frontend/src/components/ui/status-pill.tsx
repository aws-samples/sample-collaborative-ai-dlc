import { TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  TONE_CLASSES,
  getStatus,
  statusLabel,
  type StatusKeyMap,
  type StatusKind,
  type StatusTone,
} from '@/lib/statusModel';
import { cn } from '@/lib/utils';

const STALLED_HELP = 'No progress has been recorded for over 30 minutes, so the run may be stuck.';

interface StatusPillProps<K extends StatusKind> {
  kind: K;
  status: StatusKeyMap[K] | (string & {});
  /** Stalled: last activity. Otherwise: when the state began (shown as an age). */
  since?: string | null;
  stalled?: boolean;
  size?: 'sm' | 'md';
  /**
   * Short label for dense lists ("Waiting · 108 d", "Stalled · 4 mo"). The full
   * label stays available to assistive technology and as the title. Never
   * truncated: give it room, truncate the neighbouring text instead.
   */
  compact?: boolean;
  /** `true` shows the registry help in a tooltip; a string replaces it. */
  hint?: boolean | string;
  /** Injected clock for the age label. */
  now?: number | Date;
  className?: string;
}

export function StatusPill<K extends StatusKind>({
  kind,
  status,
  since,
  stalled = false,
  size = 'sm',
  compact = false,
  hint,
  now,
  className,
}: StatusPillProps<K>) {
  const entry = getStatus(kind, status);
  const tone: StatusTone = stalled ? 'warning' : entry.tone;
  const label = statusLabel(kind, status, { since, stalled, now });
  const shortLabel = compact ? statusLabel(kind, status, { since, stalled, now, compact }) : label;
  const pulse = Boolean(entry.live) && !stalled;
  const Icon = stalled ? TriangleAlert : entry.icon;
  const help = typeof hint === 'string' ? hint : stalled ? STALLED_HELP : entry.help;

  const pill = (
    <span
      data-tone={tone}
      data-stalled={stalled || undefined}
      tabIndex={hint ? 0 : undefined}
      title={compact && !hint ? label : undefined}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full font-medium',
        size === 'md' ? 'px-2.5 py-0.5 text-xs leading-5' : 'px-2 py-0.5 text-2xs',
        TONE_CLASSES[tone].pill,
        hint &&
          'cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {size === 'md' ? (
        <Icon
          aria-hidden="true"
          data-pulse={pulse || undefined}
          className={cn('h-3.5 w-3.5 shrink-0', pulse && 'motion-safe:animate-pulse')}
        />
      ) : (
        <span
          aria-hidden="true"
          data-pulse={pulse || undefined}
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
            pulse && 'motion-safe:animate-pulse',
          )}
        />
      )}
      {compact && shortLabel !== label ? (
        <>
          <span className="sr-only">{label}</span>
          <span aria-hidden="true">{shortLabel}</span>
        </>
      ) : (
        <span className={compact ? undefined : 'truncate'}>{label}</span>
      )}
    </span>
  );

  if (!hint) return pill;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent className="max-w-xs">{help}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
