import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CopyableCommandBlockProps {
  children: string;
  label: string;
}

export function CopyableCommandBlock({ children, label }: CopyableCommandBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative mt-2 min-w-0">
      <pre className="w-full min-w-0 max-w-full whitespace-pre-wrap break-all rounded-md bg-muted py-2 pl-3 pr-10 font-mono text-xs leading-relaxed text-foreground">
        <code>{children}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1.5 top-1.5 h-7 w-7"
        aria-label={copied ? `${label} copied` : label}
        title={copied ? 'Copied' : label}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}
