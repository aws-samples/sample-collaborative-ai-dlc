import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import type { DiscussionMessage } from '@/services/discussions';
import { cn } from '@/lib/utils';

// ResolveDialog: optional resolution summary (the durable "what
// did we decide", lands in the timeline) + optional "mark a message as the
// outcome" picker over the most recent messages.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: DiscussionMessage[];
  onResolve: (input: { resolutionSummary?: string; outcomeMessageId?: string }) => Promise<void>;
}

const OUTCOME_CANDIDATES = 8;

export function ResolveDialog({ open, onOpenChange, messages, onResolve }: Props) {
  const [summary, setSummary] = useState('');
  const [outcomeId, setOutcomeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = messages.filter((m) => !m.redacted).slice(-OUTCOME_CANDIDATES);

  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      await onResolve({
        resolutionSummary: summary.trim() || undefined,
        outcomeMessageId: outcomeId || undefined,
      });
      setSummary('');
      setOutcomeId(null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Resolve discussion</DialogTitle>
          <DialogDescription className="text-xs">
            The summary is recorded on the sprint timeline and shown to agents as the team's
            decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Resolution summary (optional)</Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What did the team decide?"
              className="text-sm min-h-[70px]"
              maxLength={2000}
            />
          </div>

          {candidates.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Mark a message as the outcome (optional)</Label>
              <div className="max-h-40 overflow-y-auto space-y-1 rounded-md border p-1.5">
                {candidates.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setOutcomeId(outcomeId === m.id ? null : m.id)}
                    className={cn(
                      'w-full text-left rounded px-2 py-1 text-xs hover:bg-muted',
                      outcomeId === m.id && 'bg-primary/10 ring-1 ring-primary',
                    )}
                  >
                    <span className="font-medium">{m.authorName}: </span>
                    <span className="text-muted-foreground line-clamp-2">{m.content}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={resolve} disabled={busy}>
            {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
