// Write-only secret input with a "Set / Not set" status chip and an optional
// Clear action. The backend never returns secret values to the browser, so the
// field is always empty; typing a value rotates the secret, Clear removes it.

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader2, XCircle } from 'lucide-react';
import { ConfigStatusBadge } from './ConfigStatusBadge';

interface Props {
  id: string;
  label: string;
  isSet: boolean;
  notSetLabel?: string;
  value: string;
  onChange: (value: string) => void;
  /** Placeholder when no secret is stored yet. */
  emptyPlaceholder: string;
  /** Placeholder when a secret is already stored (rotate hint). */
  rotatePlaceholder?: string;
  helpText?: ReactNode;
  /** Advisory message under the input, such as a format hint. It never blocks a save. */
  warningText?: ReactNode;
  /** When provided (and the secret is set), renders a Clear action. */
  onClear?: () => void;
  clearing?: boolean;
  disabled?: boolean;
}

export function SecretField({
  id,
  label,
  isSet,
  notSetLabel = 'Not set',
  value,
  onChange,
  emptyPlaceholder,
  rotatePlaceholder = 'Enter new value to rotate, or leave blank',
  helpText,
  warningText,
  onClear,
  clearing = false,
  disabled = false,
}: Props) {
  const warningId = `${id}-warning`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground flex items-center gap-2">
          {label}
          <ConfigStatusBadge ok={isSet} okLabel="Set" notOkLabel={notSetLabel} />
        </label>
        {isSet && onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled || clearing}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            {clearing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            Clear
          </button>
        )}
      </div>
      <Input
        id={id}
        type="password"
        placeholder={isSet ? rotatePlaceholder : emptyPlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-sm h-9"
        autoComplete="off"
        disabled={disabled}
        aria-describedby={warningText ? warningId : undefined}
      />
      {helpText && <p className="text-[11px] text-muted-foreground">{helpText}</p>}
      {warningText && (
        <p
          id={warningId}
          role="status"
          className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400"
        >
          <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{warningText}</span>
        </p>
      )}
    </div>
  );
}
