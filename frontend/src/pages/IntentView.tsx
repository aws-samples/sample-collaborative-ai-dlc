import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { intentsService } from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useAuth } from '@/contexts/AuthContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { RecomposePanel } from '@/components/intent/RecomposePanel';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { deriveLaneWaits } from '@/lib/intentRecovery';
import { PendingQuestionsTabs } from '@/components/intent/PendingQuestionsTabs';
import { ScopeBadge } from '@/components/intent/ScopeBadge';
import { QuorumEditPanel } from '@/components/intent/QuorumEditPanel';
import { UnitLaneBoard, isFanoutActive } from '@/components/intent/UnitLaneBoard';
import { AgentProgressCard } from '@/components/intent/AgentProgressCard';
import { GateCard } from '@/components/intent/GateCard';
import { StageReviewPanel } from '@/components/intent/StageReviewPanel';
import { WorkProductsSection } from '@/components/intent/WorkProductsSection';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2,
  MoreHorizontal,
  Play,
  Trash2,
  TriangleAlert,
  Wrench,
  XCircle,
} from 'lucide-react';

// The v2 intent page — main-pane content only. All fetch/realtime/output state
// lives in IntentProvider (mounted by AppShell, shared with the right-hand
// IntentActivityPanel where output/timeline/discussions render).

const TERMINAL_STATUSES = new Set(['FAILED', 'CANCELLED', 'SUCCEEDED']);

export default function IntentView() {
  const {
    projectId,
    intentId,
    detail,
    loading,
    error: loadError,
    gates,
    pendingGates,
    reload,
    answerGate,
    cancelIntent,
    deleteIntent,
    focusOutput,
    stageNameOf,
  } = useIntent();
  const navigate = useNavigate();
  const { humanTaskId: reviewGateId } = useParams<{ humanTaskId?: string }>();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  // Role gate for the destructive delete (owner/admin — the API enforces it
  // too; hiding the button just avoids a guaranteed 403).
  const { project } = useProjectCache(projectId ?? null);
  const canDelete = project?.userRole === 'owner' || project?.userRole === 'admin';
  const canRepair = canDelete;

  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Restart (FAILED / stranded CREATED) via the /start endpoint, which
  // re-enters the pipeline and clears a prior failureReason. Fresh DRAFTs
  // start from the compose page, never from here (the redirect above).
  const handleStart = async () => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setActionError(null);
    try {
      await intentsService.start(projectId, intentId);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  // Cancel (steering): retire a parked (WAITING), stranded (CREATED) or FAILED
  // run — supersedes pending gates and flips the run to CANCELLED. RUNNING
  // cannot be cancelled mid-turn (the API 409s); the button hides for it.
  const handleCancel = async () => {
    if (!window.confirm('Cancel this run? Pending questions are retired and the run stops.')) {
      return;
    }
    setCancelling(true);
    setActionError(null);
    try {
      await cancelIntent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel intent');
    } finally {
      setCancelling(false);
    }
  };

  // Permanent delete (owner/admin): removes the intent's graph data, run
  // history and realtime docs, then returns to the project page. Refused by
  // the API while RUNNING — the button hides for it.
  const handleDelete = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await deleteIntent();
      navigate(`/space/${projectId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete intent');
      setConfirmDelete(false);
      setDeleting(false);
    }
  };

  const handleRepair = async () => {
    setRepairing(true);
    setActionError(null);
    try {
      await intentsService.repair(projectId, intentId);
      setConfirmRepair(false);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to repair intent');
    } finally {
      setRepairing(false);
    }
  };

  if (!projectId || !intentId) return <div className="p-6">Intent not found</div>;
  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-muted-foreground">
          {loadError ?? 'Intent not found — it may have been deleted.'}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => reload()}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(`/space/${projectId}`)}>
            Back to space
          </Button>
        </div>
      </div>
    );
  }

  const intent = detail.intent;
  const laneWaits = deriveLaneWaits(detail.stages, gates);
  const recoveryWaits = Object.values(laneWaits).filter((wait) => wait.kind === 'recovery');
  const needsLaneRepair =
    recoveryWaits.length > 0 && ['RUNNING', 'WAITING', 'FAILED'].includes(intent.status);
  const error = actionError ?? loadError;
  const isDraft = intent.status === 'DRAFT';
  // A DRAFT belongs on the collaborative compose page — one canonical draft
  // experience (shared prompt + projection selection) instead of two UIs.
  if (isDraft) {
    return <Navigate to={`/space/${projectId}/intent/${intentId}/compose`} replace />;
  }
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';
  const isFailed = intent.status === 'FAILED';
  // Cancellable (steering): parked, stranded, or failed — never mid-RUNNING.
  const isCancellable = ['WAITING', 'CREATED', 'FAILED'].includes(intent.status);
  // Deletable (destructive): owner/admin, any status except mid-RUNNING.
  const isDeletable = canDelete && intent.status !== 'RUNNING';
  // Pre-stage progress: before any stage row exists, init-ws lifecycle events
  // are the only signal the run is doing something (they stream into the
  // sidebar Timeline); this strip keeps the main pane from looking dead.
  const noStageRowsYet = detail.stages.length === 0;
  // While parallel unit lanes are live, the units board owns the "what's
  // building" view — suppress the single-stage Running card (it would just echo
  // one lane's stream). The Running card returns after fan-in.
  const fanoutActive = isFanoutActive(detail);
  const reviewGate = reviewGateId ? gates.find((g) => g.humanTaskId === reviewGateId) : null;
  // Stalled detection: a CREATED run whose hand-off never reached a live
  // orchestrator strands here (init-ws should flip it to RUNNING within
  // seconds). After >2 min untouched, offer a restart instead of spinning.
  const lastTouch = intent.updatedAt ?? intent.createdAt;
  const isStalled =
    intent.status === 'CREATED' &&
    !!lastTouch &&
    Date.now() - new Date(lastTouch).getTime() > 120_000;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <h1 className="text-lg font-bold tracking-tight truncate min-w-0">
            {intent.title || 'Intent'}
          </h1>
          {intent.scope && <ScopeBadge scope={intent.scope} className="shrink-0" />}
          {TERMINAL_STATUSES.has(intent.status) && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {intent.status}
            </Badge>
          )}
          {isActive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse shrink-0"
              aria-label="live"
            />
          )}
          <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {intent.source && (
            <span className="text-xs text-muted-foreground">
              {intent.source.resourceUrl ? (
                <a
                  href={intent.source.resourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  from {intent.source.resourceId}
                </a>
              ) : (
                <>from {intent.source.resourceId}</>
              )}
            </span>
          )}
          {(isCancellable || isDeletable) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Intent actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isCancellable && (
                  <DropdownMenuItem disabled={cancelling} onClick={handleCancel}>
                    <XCircle className="mr-2 h-4 w-4" />
                    {cancelling ? 'Cancelling…' : 'Cancel run'}
                  </DropdownMenuItem>
                )}
                {isDeletable && (
                  <DropdownMenuItem
                    disabled={deleting}
                    onClick={() => setConfirmDelete(true)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {deleting ? 'Deleting…' : 'Delete'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {needsLaneRepair && (
        <div className="rounded border border-agent-error/30 bg-agent-error/[0.06] px-3 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-agent-error">
                <TriangleAlert className="h-4 w-4" />
                Parallel execution needs recovery
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {recoveryWaits.length} lane{recoveryWaits.length === 1 ? ' is' : 's are'} parked
                without an answerable question. Merged units are safe; active lanes must be replayed
                from the section boundary.
              </p>
            </div>
            {canRepair && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={repairing}
                onClick={() => setConfirmRepair(true)}
              >
                {repairing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )}
                Repair execution
              </Button>
            )}
          </div>
        </div>
      )}

      {/* FAILED (or a stalled CREATED hand-off): show the reason + offer a restart
          (re-runs init-ws + the plan; the /start endpoint accepts both states). */}
      {(isFailed || isStalled) && (
        <div className="rounded border border-agent-error/30 bg-agent-error/10 px-3 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-agent-error">
                <XCircle className="h-4 w-4" />
                {isFailed ? 'Run failed' : 'Run stalled — never started'}
              </div>
              {isFailed && intent.failureReason && (
                <p className="mt-1 break-words font-mono text-[12px] text-agent-error/90">
                  {intent.failureReason}
                </p>
              )}
              {isStalled && (
                <p className="mt-1 text-[12px] text-agent-error/90">
                  Workspace setup never completed. Restart to re-run it.
                </p>
              )}
            </div>
            <Button
              onClick={handleStart}
              disabled={starting}
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {starting ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        </div>
      )}

      {/* In-flight reshape (Adaptive Workflows): skip/add PENDING stages on a
          parked or failed run — composer-assisted or manual, always applied
          through the validated recompose relaunch. Hidden mid-RUN and while
          construction runs autonomously (the endpoint rejects both anyway). */}
      {(intent.status === 'WAITING' || isFailed) &&
        intent.constructionAutonomyMode !== 'autonomous' &&
        projectId &&
        intentId && (
          <RecomposePanel
            projectId={projectId}
            intentId={intentId}
            intent={intent}
            stageRows={detail.stages}
            workflowVersion={intent.workflowVersion ?? undefined}
            onRelaunched={reload}
          />
        )}

      {/* DRAFT never renders here — it redirects to the compose page above. */}
      {reviewGate ? (
        <StageReviewPanel
          gate={reviewGate}
          detail={detail}
          projectId={projectId}
          intentId={intentId}
          userName={userName}
          onAnswer={answerGate}
          onBack={() => navigate(`/space/${projectId}/intent/${intentId}`)}
        />
      ) : reviewGateId ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            <p className="text-sm font-medium">Review gate not found</p>
            <p className="text-sm text-muted-foreground">
              This review may have been retired or belongs to another intent run.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/space/${projectId}/intent/${intentId}`)}
            >
              Back to intent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pending human gates — tabs: one GateCard at a time */}
          {pendingGates.length > 0 && (
            <PendingQuestionsTabs
              gates={pendingGates}
              activeGateId={intent.pendingHumanTaskId}
              gateContext={(gate) => {
                // stageNameOf falls back to the raw instance id when the stage
                // row is unknown — no prefix beats an opaque id on the tab.
                const resolved = gate.stageInstanceId ? stageNameOf(gate.stageInstanceId) : null;
                const stagePart =
                  resolved && resolved !== gate.stageInstanceId ? humanizeStageId(resolved) : null;
                return [stagePart, gate.unitSlug ?? null].filter(Boolean).join(' · ') || null;
              }}
              renderGateCard={(gate) => (
                <GateCard
                  gate={gate}
                  projectId={projectId}
                  intentId={intentId}
                  userName={userName}
                  onAnswer={answerGate}
                />
              )}
            />
          )}

          {pendingGates.length === 0 && !noStageRowsYet && isActive && !fanoutActive && (
            <AgentProgressCard />
          )}

          {/* Workspace setup indicator — init-ws creates no stage row, so without
              this the screen looks idle while repos clone + the anchor is created. */}
          {noStageRowsYet && isActive && (
            <div className="flex items-center gap-2 rounded-md border border-agent-running/30 bg-agent-running/[0.06] px-3 py-2 text-sm text-agent-running">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Setting up workspace (cloning repositories, preparing the run)…
            </div>
          )}

          {/* Units lane board — parallel unit work after fan-out. Renders null
              until fan-out is approved; hides again after fan-in. Owns the
              "View live output" affordance while it replaces the Running card. */}
          <UnitLaneBoard onViewLiveOutput={(stageInstanceId) => focusOutput(stageInstanceId)} />

          <QuorumEditPanel />

          <WorkProductsSection detail={detail} gates={gates} />
        </>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => !deleting && setConfirmDelete(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Intent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{intent.title || 'this intent'}"? All of its
              artifacts, questions, discussions and run history will be permanently removed. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Deleting…
                </span>
              ) : (
                'Delete Intent'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmRepair}
        onOpenChange={(open) => !repairing && setConfirmRepair(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Repair parallel execution</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the orphaned execution, preserves merged units, archives active lane
              artifacts, resets active lanes and their draft pull requests, then relaunches the
              affected section.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={repairing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={repairing}
              onClick={(event) => {
                event.preventDefault();
                void handleRepair();
              }}
            >
              {repairing ? 'Repairing…' : 'Repair execution'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
