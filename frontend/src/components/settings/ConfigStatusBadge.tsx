// Status pill used across settings and admin to show whether a credential or
// config slot is populated. Labels and tones come from the shared status
// registry (`config` kind); dot-and-tint so states are scannable at a glance.

import { TONE_CLASSES, getStatus, type ConfigStatusKey } from '@/lib/statusModel';
import { cn } from '@/lib/utils';

type LegacyTone = 'success' | 'warning' | 'neutral';

interface Props {
  /** Registry status. When set, `ok`/`okLabel`/`notOkLabel`/`notOkTone` are ignored. */
  status?: ConfigStatusKey;
  /** Overrides the registry label for `status`. */
  label?: string;
  ok?: boolean;
  okLabel?: string;
  notOkLabel?: string;
  /** Tone used when not ok — 'warning' for slots that block functionality. */
  notOkTone?: Exclude<LegacyTone, 'success'>;
  className?: string;
}

function legacyStatus(ok: boolean, notOkTone: Exclude<LegacyTone, 'success'>): ConfigStatusKey {
  if (ok) return 'configured';
  return notOkTone === 'warning' ? 'incomplete' : 'none';
}

export function ConfigStatusBadge({
  status,
  label,
  ok = false,
  okLabel = 'Configured',
  notOkLabel = 'Not configured',
  notOkTone = 'neutral',
  className,
}: Props) {
  const key = status ?? legacyStatus(ok, notOkTone);
  const entry = getStatus('config', key);
  const text = status ? (label ?? entry.label) : ok ? okLabel : notOkLabel;
  return (
    <span
      data-tone={entry.tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium',
        TONE_CLASSES[entry.tone].pill,
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}
