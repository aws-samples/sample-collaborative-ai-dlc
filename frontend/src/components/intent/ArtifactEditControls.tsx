import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { useState } from 'react';
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
import { TechnicalDetails } from '@/components/ui/technical-details';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { displayStageName, humanizeSlug } from '@/lib/displayNames';
import { useIntent } from '@/contexts/IntentContext';
import {
  intentsService,
  type ArtifactImpact,
  type ArtifactImpactDownstream,
  type ArtifactImpactStage,
  type IntentArtifact,
} from '@/services/intents';

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
  const { detail, stageAccess } = useIntent();
  const { readOnly } = useSpacePermissions();
  if (readOnly) return 'You have view-only access to this space.';
  if (!stageAccess(artifact.createdByStageInstanceId)?.decide)
    return 'You need decision permission for this stage to edit the document.';
  if (artifact.supersededAt) return 'Superseded by a rewind — edit its replacement instead';
  const status = detail?.intent.status;
  if (status && !EDITABLE_INTENT_STATUSES.has(status)) {
    return `The run is ${status} — wait for the stage to park or finish before editing`;
  }
  if ((detail?.quorumEdits ?? []).some((q) => ACTIVE_QEDIT_STATES.has(q.state))) {
    return 'A Quorum edit is in progress for this intent';
  }
  return null;
}

/** Drift badge + one-click "mark verified". Renders nothing when not stale. */
export function ArtifactStaleBadge({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  const { projectId, intentId, reload, stageAccess } = useIntent();
  const { readOnly: spaceReadOnly } = useSpacePermissions();
  const readOnly = spaceReadOnly || !stageAccess(artifact.createdByStageInstanceId)?.decide;
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
              size="sm"
              className="border-agent-waiting/50 bg-agent-waiting/10 font-normal text-agent-waiting-fg"
            >
              <TriangleAlert aria-hidden="true" />
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
              size="xs"
              className="text-muted-foreground"
              loading={verifying}
              disabled={readOnly || verifying}
              onClick={(e) => {
                e.stopPropagation();
                verify();
              }}
            >
              {!verifying && <ShieldCheck aria-hidden="true" />}
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
        {error && (
          <span role="alert" className="text-2xs text-destructive">
            {error}
          </span>
        )}

        {/* Drift warning before a simple edit */}
        <Dialog open={warningOpen} onOpenChange={setWarningOpen}>
          <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
            <DialogHeader className="text-left">
              <DialogTitle className="flex items-center gap-2 text-base">
                <TriangleAlert className="h-4 w-4 text-agent-waiting" />
                This document has been consumed downstream
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3 pt-1 text-left text-sm">
                  {consumedBy.length === 0 && downstream.length === 0 ? (
                    <p>
                      No other work depends on this document yet. You can edit it directly; later
                      stages will read the new version.
                    </p>
                  ) : (
                    <>
                      {consumedBy.length > 0 && (
                        <ImpactList
                          title={
                            consumedBy.length === 1
                              ? 'One stage used it as input'
                              : `${consumedBy.length} stages used it as input`
                          }
                          lines={consumedBy.map(describeConsumer)}
                        />
                      )}
                      {downstream.length > 0 && (
                        <ImpactList
                          title={
                            downstream.length === 1
                              ? 'One document was built from it'
                              : `${downstream.length} documents were built from it`
                          }
                          lines={downstream.map(describeDownstream)}
                        />
                      )}
                      <p className="text-muted-foreground">
                        Editing it directly leaves those documents behind: they will be marked{' '}
                        <span className="font-medium text-foreground">possibly stale</span> until
                        someone updates or verifies them. Quorum plans and applies the follow-up
                        changes for you.
                      </p>
                    </>
                  )}
                  <TechnicalDetails
                    items={[
                      { label: 'Document id', value: artifact.id, copy: true },
                      {
                        label: 'Consuming stages',
                        value: consumedBy
                          .map((s) => `${s.stageId} (${s.via.join(' + ')})`)
                          .join(', '),
                        copy: consumedBy.length > 0,
                      },
                      {
                        label: 'Downstream artifacts',
                        value: downstream
                          .map(
                            (d) => `${d.id} (${d.via.join(', ').toLowerCase()}, depth ${d.depth})`,
                          )
                          .join(', '),
                        copy: downstream.length > 0,
                      },
                    ]}
                  />
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" size="sm" onClick={() => setWarningOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={Boolean(blocked)}
                variant="outline"
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
              <Button
                disabled={Boolean(blocked)}
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
              disabled={Boolean(blocked)}
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
                disabled={Boolean(blocked) || !changeDescription.trim() || submitting}
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

function describeConsumer(stage: ArtifactImpactStage): string {
  const name = displayStageName(stage.stageId);
  return stage.via.includes('read') ? `Read by ${name}` : `Listed as an input of ${name}`;
}

function describeDownstream(item: ArtifactImpactDownstream): string {
  const name = item.title || humanizeSlug(item.artifactType ?? 'document');
  const onlyCites = item.via.length > 0 && item.via.every((v) => v.toUpperCase() === 'CITES');
  const qualifiers = [
    onlyCites ? 'cites it' : null,
    item.depth > 1 ? 'indirectly' : null,
    item.stale ? 'already marked possibly stale' : null,
  ].filter(Boolean);
  return qualifiers.length ? `${name} · ${qualifiers.join(' · ')}` : name;
}

function ImpactList({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="font-medium text-foreground">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
