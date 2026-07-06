// Status pill used across the Platform Admin page to show whether a
// credential/config slot is populated. Dot-and-tint pill instead of raw text
// so states are scannable at a glance.

import { cn } from '@/lib/utils';

type Tone = 'success' | 'warning' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-agent-success/10 text-agent-success',
  warning: 'bg-agent-warning/15 text-amber-600 dark:text-amber-400',
  neutral: 'bg-muted text-muted-foreground',
};

interface Props {
  ok: boolean;
  okLabel?: string;
  notOkLabel?: string;
  /** Tone used when not ok — 'warning' for slots that block functionality. */
  notOkTone?: Exclude<Tone, 'success'>;
  className?: string;
}

export function ConfigStatusBadge({
  ok,
  okLabel = 'Configured',
  notOkLabel = 'Not configured',
  notOkTone = 'neutral',
  className,
}: Props) {
  const tone: Tone = ok ? 'success' : notOkTone;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {ok ? okLabel : notOkLabel}
    </span>
  );
}
