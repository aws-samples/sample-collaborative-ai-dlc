import { useMemo, useState } from 'react';
import { Loader2, Pencil, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService, type ArtifactImpact, type IntentArtifact } from '@/services/intents';

// Post-hoc artifact editing affordances, shared by the ArtifactViewer card and
// the document Preview tab:
//   - drift badge ("possibly stale — upstream edited") + one-click verify;
//   - Edit → fetch impact → drift warning dialog → the caller's inline editor;
//   - Edit with Quorum → describe-the-change dialog → durable Quorum flow
//     (plan → approval → apply), surfaced in the QuorumEditPanel.
// Editing is blocked while a run or a Quorum edit is active — the buttons
// disable from the detail DTO, and the backend enforces the same rule (409).

// WAITING is editable on purpose: v2 runs park on human gates constantly, so
// blocking it would make editing effectively impossible. A parked run is the
// established safe mutation point (rewind/cancel/steering all allow it); the
// backend announces a mid-run edit to the parked conversation via a steering
// row delivered at resume. Only a genuinely executing run (CREATED/RUNNING)
// blocks.
const EDITABLE_INTENT_STATUSES = new Set(['DRAFT', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const ACTIVE_QEDIT_STATES = new Set(['PLANNING', 'AWAITING_APPROVAL', 'APPLYING']);

/** Why editing is currently unavailable, or null when it is allowed. */
export function useArtifactEditability(artifact: IntentArtifact): string | null {
  const { detail } = useIntent();
  return useMemo(() => {
    if (artifact.supersededAt) return 'Superseded by a rewind — edit its replacement instead';
    const status = detail?.intent.status;
    if (status && !EDITABLE_INTENT_STATUSES.has(status)) {
      return `The run is ${status} — wait for the stage to park or finish before editing`;
    }
    if ((detail?.quorumEdits ?? []).some((q) => ACTIVE_QEDIT_STATES.has(q.state))) {
      return 'A Quorum edit is in progress for this intent';
    }
    return null;
  }, [artifact.supersededAt, detail]);
}

/** Drift badge + one-click "mark verified". Renders nothing when not stale. */
export function ArtifactStaleBadge({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  const { projectId, intentId, reload } = useIntent();
  const [verifying, setVerifying] = useState(false);
  if (!artifact.staleSince) return null;

  const verify = async () => {
    setVerifying(true);
    try {
      await intentsService.verifyArtifact(projectId, intentId, artifact.id);
      await reload();
    } catch (err) {
      console.error('Verify failed:', err);
    } finally {
      setVerifying(false);
    }
  };

  return (
    // Local provider: these controls also render outside AppShell's tooltip
    // scope (tests, potential standalone hosts); nesting providers is cheap.
    <TooltipProvider>
      <span className={cn('inline-flex items-center gap-1', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="gap-1 border-agent-waiting/50 bg-agent-waiting/10 px-1.5 py-0 text-[10px] text-agent-waiting"
            >
              <TriangleAlert className="h-2.5 w-2.5" />
              possibly stale
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-xs">
            An upstream document was edited after this artifact was derived from it
            {artifact.staleSince ? ` (${new Date(artifact.staleSince).toLocaleString()})` : ''}.
            Review it, then mark it verified — or update it (a new edit clears the marker too).
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
              disabled={verifying}
              onClick={(e) => {
                e.stopPropagation();
                verify();
              }}
            >
              {verifying ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-2.5 w-2.5" />
              )}
              Mark verified
            </Button>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            Reviewed — still valid despite the upstream edit
          </TooltipContent>
        </Tooltip>
      </span>
    </TooltipProvider>
  );
}

export function ArtifactEditControls({
  artifact,
  onStartEdit,
  className,
}: {
  artifact: IntentArtifact;
  /** Enter the caller's inline collaborative editor (after the warning). */
  onStartEdit: () => void;
  className?: string;
}) {
  const { projectId, intentId, reload } = useIntent();
  const blocked = useArtifactEditability(artifact);

  const [impact, setImpact] = useState<ArtifactImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [quorumOpen, setQuorumOpen] = useState(false);
  const [changeDescription, setChangeDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadImpact = async (): Promise<ArtifactImpact | null> => {
    setImpactLoading(true);
    try {
      const data = await intentsService.artifactImpact(projectId, intentId, artifact.id);
      setImpact(data);
      return data;
    } catch (err) {
      console.error('Impact fetch failed:', err);
      return null;
    } finally {
      setImpactLoading(false);
    }
  };

  // Edit: always show the drift warning first — the user must see what was
  // consumed/derived downstream before changing something under it.
  const onEditClick = async () => {
    setError(null);
    const data = await loadImpact();
    if (!data) {
      setError('Could not load the impact data — try again');
      return;
    }
    setWarningOpen(true);
  };

  const startQuorum = async () => {
    if (!changeDescription.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await intentsService.startQuorumEdit(
        projectId,
        intentId,
        artifact.id,
        changeDescription.trim(),
      );
      setQuorumOpen(false);
      setChangeDescription('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the Quorum edit');
    } finally {
      setSubmitting(false);
    }
  };

  const consumedBy = impact?.consumingStages ?? [];
  const downstream = impact?.downstream ?? [];

  return (
    // Local provider — see ArtifactStaleBadge.
    <TooltipProvider>
      <span className={cn('inline-flex items-center gap-0.5', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Edit document"
                disabled={Boolean(blocked) || impactLoading}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditClick();
                }}
              >
                {impactLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Pencil className="h-3 w-3" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{blocked ?? 'Edit this document'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Edit with Quorum"
                disabled={Boolean(blocked)}
                onClick={(e) => {
                  e.stopPropagation();
                  setError(null);
                  setQuorumOpen(true);
                }}
              >
                <Sparkles className="h-3 w-3" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {blocked ?? 'Edit with Quorum — it plans and applies the downstream updates too'}
          </TooltipContent>
        </Tooltip>
        {error && <span className="text-[10px] text-destructive">{error}</span>}

        {/* Drift warning before a simple edit */}
        <Dialog open={warningOpen} onOpenChange={setWarningOpen}>
          <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <TriangleAlert className="h-4 w-4 text-agent-waiting" />
                This document has been consumed downstream
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3 pt-1 text-left text-xs">
                  {consumedBy.length > 0 ? (
                    <div>
                      <p className="font-medium text-foreground">
                        Consumed by {consumedBy.length} stage{consumedBy.length > 1 ? 's' : ''}:
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {consumedBy.map((s) => (
                          <li key={s.stageId}>
                            {s.stageId}{' '}
                            <span className="text-muted-foreground">({s.via.join(' + ')})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p>No stage is recorded as having consumed this document.</p>
                  )}
                  {downstream.length > 0 && (
                    <div>
                      <p className="font-medium text-foreground">
                        {downstream.length} artifact{downstream.length > 1 ? 's were' : ' was'}{' '}
                        derived from it (transitively):
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {downstream.map((d) => (
                          <li key={d.id}>
                            {d.title || d.id}
                            <span className="text-muted-foreground">
                              {' '}
                              ({d.via.join(', ').toLowerCase()}, depth {d.depth})
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p>
                    Editing may cause drift: verify the output of these stages afterwards or update
                    the derived artifacts. Downstream artifacts will be marked{' '}
                    <span className="font-medium">possibly stale</span> until they are updated or
                    verified — or let Quorum plan and apply the updates for you.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="ghost" size="sm" onClick={() => setWarningOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setWarningOpen(false);
                  setQuorumOpen(true);
                }}
              >
                <Sparkles className="h-3 w-3" />
                Edit with Quorum
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setWarningOpen(false);
                  onStartEdit();
                }}
              >
                <Pencil className="h-3 w-3" />
                Edit anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Quorum edit kick-off: describe the change */}
        <Dialog open={quorumOpen} onOpenChange={setQuorumOpen}>
          <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4" />
                Edit with Quorum
              </DialogTitle>
              <DialogDescription className="text-left text-xs">
                Describe the change to “{artifact.title || artifact.id}”. Quorum analyzes every
                downstream artifact, proposes an update plan for your approval, and then applies it
                — keeping the derived documents consistent.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={changeDescription}
              onChange={(e) => setChangeDescription(e.target.value)}
              placeholder="e.g. Reposition the product for the EU market instead of the US market; adjust the competitor list accordingly…"
              rows={5}
              className="text-sm"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setQuorumOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!changeDescription.trim() || submitting}
                onClick={startQuorum}
              >
                {submitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Ask Quorum to plan the edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </span>
    </TooltipProvider>
  );
}
