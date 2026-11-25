import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';

export interface TechnicalDetailItem {
  label: string;
  value: string | null | undefined;
  copy?: boolean;
}

export interface TechnicalDetailsProps {
  items: TechnicalDetailItem[];
  title?: string;
  defaultOpen?: boolean;
  className?: string;
}

const COPIED_FEEDBACK_MS = 2000;

export function TechnicalDetails({
  items,
  title = 'Technical details',
  defaultOpen = false,
  className,
}: TechnicalDetailsProps) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copyValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Disclosure variant="inline" title={title} defaultOpen={defaultOpen} className={className}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {items.map((item) => {
          const isCopied = copied === item.label;
          // Ids, hashes and enums (no spaces) read as code and may break anywhere;
          // sentences keep the body font and break at words.
          const Value = item.value && /\s/.test(item.value) ? 'span' : 'code';
          return (
            <React.Fragment key={item.label}>
              <dt className="pt-1 text-muted-foreground">{item.label}</dt>
              <dd className="flex min-w-0 items-start gap-2">
                <Value
                  className={cn(
                    'min-w-0 flex-1 rounded bg-muted px-1.5 py-1 text-xs text-foreground',
                    Value === 'code' ? 'break-all font-mono' : 'break-words',
                    !item.value && 'text-muted-foreground',
                  )}
                >
                  {item.value || '—'}
                </Value>
                {item.copy && item.value ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={`Copy ${item.label}`}
                    onClick={() => void copyValue(item.label, item.value!)}
                  >
                    {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {isCopied ? 'Copied' : 'Copy'}
                  </Button>
                ) : null}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `Copied ${copied}` : ''}
      </span>
    </Disclosure>
  );
}
