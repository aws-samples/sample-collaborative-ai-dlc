import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface KeyValueItem {
  label: string;
  value?: React.ReactNode;
  /** Shown when `value` is null, undefined or "" (default "—"). */
  empty?: string;
  /** Full text copied by a "Copy <label>" button (use for IDs shown abbreviated). */
  copy?: string;
}

export interface KeyValueListProps extends React.HTMLAttributes<HTMLDListElement> {
  items: KeyValueItem[];
  columns?: 1 | 2;
}

export function KeyValueList({ items, columns = 1, className, ...props }: KeyValueListProps) {
  return (
    <dl
      className={cn('grid gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', className)}
      {...props}
    >
      {items.map((item) => {
        const isEmpty = item.value == null || item.value === '';
        return (
          <div key={item.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 flex min-w-0 items-start gap-1 text-sm break-words">
              {isEmpty ? (
                <span className="text-muted-foreground">{item.empty ?? '—'}</span>
              ) : (
                <span className="min-w-0 break-words">{item.value}</span>
              )}
              {item.copy ? <CopyButton label={item.label} text={item.copy} /> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={`Copy ${label}`}
      onClick={copy}
      className="-my-1 shrink-0 text-muted-foreground"
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className={copied ? undefined : 'sr-only'}>{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}
