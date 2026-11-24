import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
export function IntentInitialPrompt({ prompt }: { prompt?: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  useEffect(() => {
    if (!promptCopied) return;
    const timeout = window.setTimeout(() => setPromptCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [promptCopied]);

  const handleCopyPrompt = async () => {
    if (!prompt?.trim()) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
    } catch {
      setError('Failed to copy initial prompt');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">Initial prompt</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={promptCopied ? 'Initial prompt copied' : 'Copy initial prompt'}
            title={promptCopied ? 'Copied' : 'Copy initial prompt'}
            disabled={!prompt?.trim()}
            onClick={() => void handleCopyPrompt()}
          >
            {promptCopied ? (
              <Check className="h-3.5 w-3.5 text-agent-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {prompt?.trim() ? (
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground select-text">
            {prompt}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No initial prompt recorded</span>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
