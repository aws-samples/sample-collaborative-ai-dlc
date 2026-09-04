import { useState } from 'react';
import { useIntent } from '@/contexts/IntentContext';
import { getTimeAgo } from '@/lib/timeAgo';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RotateCcw } from 'lucide-react';

// ---------------------------------------------------------------------------
// WaitingCard — rich "parked, waiting on human" state with context + actions.
// ---------------------------------------------------------------------------

export interface WaitingCardProps {
  intent: NonNullable<ReturnType<typeof useIntent>['detail']>['intent'];
  gates: ReturnType<typeof useIntent>['gates'];
  stageRows: ReturnType<typeof useIntent>['stageRows'];
  stageNameOf: ReturnType<typeof useIntent>['stageNameOf'];
  rewindIntent: ReturnType<typeof useIntent>['rewindIntent'];
}

export function WaitingCard({
  intent,
  gates,
  stageRows,
  stageNameOf,
  rewindIntent,
}: WaitingCardProps) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);

  const activeGate =
    gates.find((g) => g.humanTaskId === intent.pendingHumanTaskId) ??
    gates.findLast((g) => g.status === 'pending') ??
    null;

  const parkedRow = stageRows.find((r) => r.state === 'WAITING_FOR_HUMAN') ?? null;
  const stageId = parkedRow?.stageId ?? intent.currentStage ?? '';
  const displayStageName = parkedRow?.stageInstanceId
    ? stageNameOf(parkedRow.stageInstanceId)
    : stageId;

  const waitingSince = activeGate?.createdAt ?? parkedRow?.parkedAt ?? null;

  let questionPreview: string | null = null;
  if (activeGate) {
    if (activeGate.prompt) {
      questionPreview = activeGate.prompt;
    } else if (activeGate.kind === 'question' && activeGate.questions) {
      try {
        const parsed: { text?: string }[] = JSON.parse(activeGate.questions);
        if (Array.isArray(parsed) && parsed.length > 0) {
          questionPreview = parsed[0].text ?? null;
          if (questionPreview && parsed.length > 1) {
            questionPreview = `${questionPreview} — and ${parsed.length - 1} more`;
          }
        }
      } catch {
        questionPreview = null;
      }
    }
  }

  const handleRestart = async () => {
    setRewindError(null);
    setRewinding(true);
    try {
      await rewindIntent(stageId);
      setConfirmRestart(false);
    } catch (err) {
      setRewindError(err instanceof Error ? err.message : 'Failed to restart stage');
    } finally {
      setRewinding(false);
    }
  };

  const handleRestartWithGuidance = async () => {
    if (!guidance.trim()) return;
    setRewindError(null);
    setRewinding(true);
    try {
      await rewindIntent(stageId, guidance.trim());
      setGuidanceOpen(false);
      setGuidance('');
    } catch (err) {
      setRewindError(err instanceof Error ? err.message : 'Failed to restart stage');
    } finally {
      setRewinding(false);
    }
  };

  return (
    <div className="rounded-lg border border-agent-waiting/30 bg-agent-waiting/[0.05] px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-agent-waiting" />
            <span className="text-sm font-semibold text-agent-waiting">Waiting for your input</span>
            {waitingSince && (
              <span className="text-xs text-muted-foreground">
                since {getTimeAgo(waitingSince)}
              </span>
            )}
          </div>
          {displayStageName && (
            <p className="text-xs text-muted-foreground">
              Stage: <span className="font-medium text-foreground/80">{displayStageName}</span>
            </p>
          )}
          {questionPreview && (
            <p className="line-clamp-1 text-xs text-muted-foreground italic">
              &ldquo;{questionPreview}&rdquo;
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={rewinding || !stageId}
          onClick={() => {
            setRewindError(null);
            setConfirmRestart(true);
          }}
        >
          <RotateCcw className="h-3 w-3" />
          Restart stage
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={rewinding || !stageId}
          onClick={() => {
            setRewindError(null);
            setGuidanceOpen(true);
          }}
        >
          <RotateCcw className="h-3 w-3" />
          Restart with guidance
        </Button>
      </div>

      {/* Confirm restart */}
      <AlertDialog
        open={confirmRestart}
        onOpenChange={(o) => {
          if (!rewinding) {
            setConfirmRestart(o);
            if (o) setRewindError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart stage</AlertDialogTitle>
            <AlertDialogDescription>
              This will rewind the run to re-execute "{displayStageName || stageId}" from scratch.
              Any pending questions for this stage are retired.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rewindError && !guidanceOpen && (
            <p className="text-xs text-destructive">{rewindError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rewinding}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestart} disabled={rewinding}>
              {rewinding ? 'Restarting…' : 'Restart'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restart with guidance dialog */}
      <Dialog
        open={guidanceOpen}
        onOpenChange={(o) => {
          if (!rewinding) {
            setGuidanceOpen(o);
            if (o) setRewindError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Restart with guidance</DialogTitle>
            <DialogDescription>
              Tell the agent what to do differently when it re-runs this stage.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. 'Use the existing event bus instead of creating a new REST layer.'"
            rows={3}
            className="text-sm"
            aria-label="Guidance for the restarted stage"
          />
          {rewindError && guidanceOpen && <p className="text-xs text-destructive">{rewindError}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={rewinding}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              disabled={!guidance.trim() || rewinding}
              onClick={handleRestartWithGuidance}
            >
              {rewinding ? 'Restarting…' : 'Restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
