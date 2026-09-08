// A value that is not a secret but is tenant-identifying: masked by default with
// an explicit reveal, and copyable.
//
// specs/bedrock-iam-role-credential-mode: dec-external-id-not-secret. AWS states
// an external ID "can be seen by anyone with permission to view the role" and is
// explicitly NOT treated as a secret, so a write-only field would be wrong — an
// operator has to paste this value into a trust policy. Masking is presentation
// hygiene for a shoulder-surfer, not a security control, which is why the reveal
// needs no confirmation.

import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';

interface Props {
  id: string;
  label: string;
  value: string;
  helpText?: string;
  /** Masked by default with an explicit reveal, for a value that is not a secret
   *  but IS tenant-identifying (the external ID). A value that is identical for
   *  every tenant — the broker principal — gains nothing from masking, so it
   *  passes `masked={false}` and renders plainly. */
  masked?: boolean;
}

export function RevealableValue({ id, label, value, helpText, masked = true }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const visible = revealed || !masked;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard is not an error worth interrupting the operator for:
      // revealing the value leaves it selectable by hand.
      setRevealed(true);
    }
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <code
          id={id}
          data-testid={`${id}-value`}
          className="min-w-0 flex-1 truncate rounded-md border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-[11px]"
        >
          {visible ? value : '•'.repeat(Math.min(value.length, 32))}
        </code>
        {masked && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {revealed ? 'Hide' : 'Reveal'}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {helpText && <p className="text-[11px] text-muted-foreground">{helpText}</p>}
    </div>
  );
}
