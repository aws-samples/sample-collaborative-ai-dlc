import { useState } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  prNumber: string | number;
  branch?: string | null;
  baseBranch?: string | null;
  gitRepo?: string;
}

export function PrCheckoutCommand({ prNumber, branch: _branch, baseBranch, gitRepo }: Props) {
  const [copied, setCopied] = useState(false);
  const [useGh, setUseGh] = useState(true);

  const base = baseBranch || 'main';

  // gh CLI: checkout PR and fetch base for diffing
  const ghCommand = gitRepo
    ? `gh pr checkout ${prNumber} -R ${gitRepo} && git fetch origin ${base}`
    : `gh pr checkout ${prNumber} && git fetch origin ${base}`;

  // Plain git: fetch PR ref into a local branch, checkout, fetch base
  const gitCommand = `git fetch origin pull/${prNumber}/head:pr-${prNumber} && git checkout pr-${prNumber} && git fetch origin ${base}`;

  const command = useGh ? ghCommand : gitCommand;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 bg-muted/60 rounded px-2.5 py-1.5 font-mono text-xs">
        <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
        <code className="flex-1 select-all truncate">{command}</code>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopy}
          title="Copy to clipboard">
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
        </Button>
      </div>
      <div className="flex items-center gap-1.5 px-1">
        <button
          onClick={() => setUseGh(true)}
          className={`text-[10px] px-1.5 py-0.5 rounded ${useGh ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
        >
          gh cli
        </button>
        <button
          onClick={() => setUseGh(false)}
          className={`text-[10px] px-1.5 py-0.5 rounded ${!useGh ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
        >
          git
        </button>
      </div>
    </div>
  );
}
