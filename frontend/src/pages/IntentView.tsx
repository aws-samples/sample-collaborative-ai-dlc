import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  intentsService,
  type GateAnswer,
  type IntentDetail,
  type IntentGate,
  type IntentSteering,
} from '@/services/intents';
import { INTENT_OUTPUT_KEY, useIntent } from '@/contexts/IntentContext';
import { useAuth } from '@/contexts/AuthContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { useYjsDocument } from '@/hooks/useYjsDocument';
import QuestionEditor from '@/components/QuestionEditor';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { RecomposePanel } from '@/components/intent/RecomposePanel';
import type { Question } from '@/services/questions';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { ArtifactViewer } from '@/components/intent/ArtifactViewer';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import { QuorumEditPanel } from '@/components/intent/QuorumEditPanel';
import { UnitLaneBoard, isFanoutActive } from '@/components/intent/UnitLaneBoard';
import {
  DerivedItemsSection,
  DERIVED_ITEMS_ACCORDION_VALUE,
  DERIVED_ITEMS_SECTION_ID,
} from '@/components/intent/DerivedItemsSection';
import {
  DocumentsSection,
  DOCUMENTS_ACCORDION_VALUE,
  isDocumentArtifact,
} from '@/components/intent/DocumentsSection';
import { CodeSection, CODE_ACCORDION_VALUE, buildCodeItems } from '@/components/intent/CodeSection';
import {
  onWorkProductFocus,
  scrollAndFlash,
  type WorkProductFocus,
} from '@/components/intent/workProductsFocus';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getTimeAgo } from '@/lib/timeAgo';
import { generateColor } from '@/utils/colors';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  FileText,
  FileQuestion,
  Layers,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';

// The v2 intent page — main-pane content only. All fetch/realtime/output state
// lives in IntentProvider (mounted by AppShell, shared with the right-hand
// IntentActivityPanel where output/timeline/discussions render).

const TERMINAL_STATUSES = new Set(['FAILED', 'CANCELLED', 'SUCCEEDED']);

const SCOPE_PALETTE = [
  'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
] as const;

function scopeColor(scope: string): string {
  let hash = 0;
  for (let i = 0; i < scope.length; i++) {
    hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  }
  return SCOPE_PALETTE[Math.abs(hash) % SCOPE_PALETTE.length];
}

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
  } = useIntent();
  const navigate = useNavigate();
  const { humanTaskId: reviewGateId } = useParams<{ humanTaskId?: string }>();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  // Role gate for the destructive delete (owner/admin — the API enforces it
  // too; hiding the button just avoids a guaranteed 403).
  const { project } = useProjectCache(projectId ?? null);
  const canDelete = project?.userRole === 'owner' || project?.userRole === 'admin';

  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      navigate(`/project/${projectId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete intent');
      setConfirmDelete(false);
      setDeleting(false);
    }
  };

  if (!projectId || !intentId) return <div className="p-6">Intent not found</div>;
  if (loading && !detail) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (!detail) return <div className="p-6">Intent not found</div>;

  const intent = detail.intent;
  const error = actionError ?? loadError;
  const isDraft = intent.status === 'DRAFT';
  // A DRAFT belongs on the collaborative compose page — one canonical draft
  // experience (shared prompt + projection selection) instead of two UIs.
  if (isDraft) {
    return <Navigate to={`/project/${projectId}/intent/${intentId}/compose`} replace />;
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
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-bold tracking-tight truncate">{intent.title || 'Intent'}</h1>
          {intent.scope && (
            <Badge
              variant="secondary"
              className={cn('text-xs font-semibold px-2.5 border-0', scopeColor(intent.scope))}
              aria-label={`Scope: ${intent.scope}`}
            >
              {intent.scope}
            </Badge>
          )}
          {TERMINAL_STATUSES.has(intent.status) && (
            <Badge variant="outline" className="text-[10px]">
              {intent.status}
            </Badge>
          )}
          {isActive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse"
              aria-label="live"
            />
          )}
          <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
        </div>
        <div className="flex items-center gap-2">
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

      {/* Degraded-scope note: the plan resolved with non-fatal scope-shortcut
          warnings at create (required inputs whose producer stage is out of this
          scope; per-unit sections downgraded to once-per-workflow). Informational
          only — the run proceeds; details expand on demand. */}
      {intent.planWarnings && intent.planWarnings.length > 0 && (
        <details className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Scope “{intent.scope}” runs degraded — {intent.planWarnings.length} declared input
            {intent.planWarnings.length === 1 ? '' : 's'} will not be produced in this scope
          </summary>
          <ul className="mt-2 space-y-1 pl-6 text-[12px] text-muted-foreground">
            {intent.planWarnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="list-disc">
                {w.message}
              </li>
            ))}
          </ul>
        </details>
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
          onBack={() => navigate(`/project/${projectId}/intent/${intentId}`)}
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
              onClick={() => navigate(`/project/${projectId}/intent/${intentId}`)}
            >
              Back to intent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pending human gates (D3: one editor per pending gate) */}
          {pendingGates.length > 0 && (
            <div className="rounded-lg border border-l-4 border-l-agent-waiting bg-agent-waiting/[0.04] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <FileQuestion className="h-4 w-4 text-agent-waiting" />
                <h2 className="text-sm font-semibold">Questions for you</h2>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {pendingGates.length}
                </Badge>
              </div>
              {pendingGates.map((gate) => (
                <GateCard
                  key={gate.humanTaskId}
                  gate={gate}
                  isActiveGate={gate.humanTaskId === intent.pendingHumanTaskId}
                  projectId={projectId}
                  intentId={intentId}
                  userName={userName}
                  onAnswer={answerGate}
                />
              ))}
            </div>
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

          <WorkProductsPanel detail={detail} gates={gates} />
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
              Are you sure you want to delete “{intent.title || 'this intent'}”? All of its
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live progress card — calm "agent working" presence while running with no
// pending questions. Replaces itself when questions arrive (mutually exclusive).
// ---------------------------------------------------------------------------

function AgentProgressCard() {
  const {
    detail,
    stageRows,
    stageNameOf,
    phaseNameOf,
    gates,
    outputBuffers,
    outputVersion,
    ensureOutputs,
    focusOutput,
    rewindIntent,
  } = useIntent();
  const intent = detail?.intent;
  const isRunning = intent?.status === 'RUNNING';
  const isWaiting = intent?.status === 'WAITING';

  const runningRow = stageRows.findLast((s) => s.state === 'RUNNING' && s.stageInstanceId);
  const parkedRow = stageRows.findLast((s) => s.state === 'WAITING_FOR_HUMAN' && s.stageInstanceId);
  const activePendingGate =
    gates.find((g) => g.status === 'pending' && g.humanTaskId === intent?.pendingHumanTaskId) ??
    gates.findLast((g) => g.status === 'pending') ??
    null;
  const lifecycleStageInstanceId =
    runningRow?.stageInstanceId ?? parkedRow?.stageInstanceId ?? null;
  const lifecycleSummary =
    detail?.events
      .toReversed()
      .find(
        (ev) =>
          [
            'v2.stage.resuming',
            'v2.workspace.restoring',
            'v2.workspace.restored',
            'v2.stage.resumed',
            'v2.stage.running',
          ].includes(ev.type) &&
          (!lifecycleStageInstanceId ||
            !ev.stageInstanceId ||
            ev.stageInstanceId === lifecycleStageInstanceId),
      )?.summary ?? null;
  const bufferKey = runningRow?.stageInstanceId ?? INTENT_OUTPUT_KEY;

  useTick(isRunning ?? false);

  useEffect(() => {
    if (isRunning) ensureOutputs(bufferKey);
  }, [isRunning, bufferKey, ensureOutputs]);

  void outputVersion;

  const content = outputBuffers.get(bufferKey) ?? '';
  const lastLines = content
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .slice(-2)
    .join('\n');

  const elapsed = runningRow?.startedAt ? formatDuration(runningRow.startedAt) : null;
  const stageName = runningRow?.stageInstanceId ? stageNameOf(runningRow.stageInstanceId) : null;
  const phaseName = runningRow?.phase ? phaseNameOf(runningRow.phase) : null;
  const statusLabel = isWaiting && !activePendingGate ? 'Resuming' : 'Running';
  const statusSummary =
    lifecycleSummary ?? (isWaiting && !activePendingGate ? 'Resuming agent session...' : null);

  if (isWaiting && activePendingGate) {
    return (
      <WaitingCard
        intent={intent}
        gates={gates}
        stageRows={stageRows}
        stageNameOf={stageNameOf}
        rewindIntent={rewindIntent}
      />
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-agent-running/30 bg-agent-running/[0.04]">
      <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
        <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-agent-running/60 to-transparent animate-shimmer" />
      </div>
      <div className="flex items-start gap-3 border-l-2 border-agent-running px-4 py-3">
        <span className="relative mt-1 flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-agent-running opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-agent-running" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{statusLabel}</span>
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1 w-1 rounded-full bg-agent-running animate-bounce [animation-delay:0ms]" />
              <span className="h-1 w-1 rounded-full bg-agent-running animate-bounce [animation-delay:150ms]" />
              <span className="h-1 w-1 rounded-full bg-agent-running animate-bounce [animation-delay:300ms]" />
            </span>
            {stageName && <span className="text-xs text-muted-foreground">{stageName}</span>}
            {phaseName && (
              <Badge variant="outline" className="h-4 text-[10px]">
                {phaseName}
              </Badge>
            )}
            {elapsed && <span className="text-xs text-muted-foreground/70">{elapsed}</span>}
          </div>
          {lastLines && (
            <pre className="mt-2 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {lastLines}
            </pre>
          )}
          {!lastLines && statusSummary && (
            <p className="mt-1 text-xs text-muted-foreground">{statusSummary}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={() => focusOutput(runningRow?.stageInstanceId ?? null)}
        >
          View live output
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WaitingCard — rich "parked, waiting on human" state with context + actions.
// ---------------------------------------------------------------------------

interface WaitingCardProps {
  intent: NonNullable<ReturnType<typeof useIntent>['detail']>['intent'];
  gates: ReturnType<typeof useIntent>['gates'];
  stageRows: ReturnType<typeof useIntent>['stageRows'];
  stageNameOf: ReturnType<typeof useIntent>['stageNameOf'];
  rewindIntent: ReturnType<typeof useIntent>['rewindIntent'];
}

function WaitingCard({ intent, gates, stageRows, stageNameOf, rewindIntent }: WaitingCardProps) {
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

function WorkProductsPanel({ detail, gates }: { detail: IntentDetail; gates: IntentGate[] }) {
  const { openArtifactPreview, openItemPreview, projectId, intentId, stageRows, phaseNameOf } =
    useIntent();
  // The knowledge-graph view powers the graph-context popovers, the derived
  // items section, and the per-artifact item chips (shared SWR cache; see
  // useIntentGraph). Fail-soft: while loading / on error everything below
  // renders without the graph affordances.
  const { getNeighbors, derivedItems, itemsByArtifact } = useIntentGraph(projectId, intentId);
  const [itemsFilter, setItemsFilter] = useState<string | null>(null);

  const questionGates = gates.filter((g) => g.kind === 'question');
  const steering = detail.steering ?? [];

  const influencedArtifactsByQuestion = new Map(
    detail.events
      .filter((ev) => ev.type === 'v2.question.answered' && ev.humanTaskId)
      .map((ev) => [ev.humanTaskId as string, ev.artifacts ?? []]),
  );

  const activeArtifacts = detail.artifacts.filter((a) => !a.supersededAt);
  // Only long-form markdown artifacts render as Documents. Short / unregistered
  // marker artifacts (e.g. practices-discovery-timestamp) are intentionally
  // dropped — they are diagnostic telemetry, not work products.
  const documents = activeArtifacts.filter(isDocumentArtifact);

  const codeItems = buildCodeItems(detail);
  const showCode = codeItems.length > 0;

  // Controlled accordion: groups open by default (as before), and newly
  // appearing groups auto-open — but a group the user closed stays closed.
  // Controlled because in-page navigation (popover/chip) must expand the
  // target group before scrolling to the anchor. Derived items start closed
  // (a supplementary layer).
  const defaultOpen = [
    showCode ? CODE_ACCORDION_VALUE : null,
    documents.length > 0 ? DOCUMENTS_ACCORDION_VALUE : null,
    questionGates.length > 0 ? 'questions' : null,
  ].filter((v): v is string => Boolean(v));
  const [openGroups, setOpenGroups] = useState<string[]>(defaultOpen);
  const seenGroupsRef = useRef<Set<string>>(new Set(defaultOpen));
  useEffect(() => {
    const fresh = defaultOpen.filter((k) => !seenGroupsRef.current.has(k));
    if (fresh.length === 0) return;
    fresh.forEach((k) => seenGroupsRef.current.add(k));
    setOpenGroups((prev) => [...new Set([...prev, ...fresh])]);
    // A string signature keeps the effect cheap; defaultOpen is order-stable.
  }, [defaultOpen.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const openGroup = (value: string) =>
    setOpenGroups((prev) => (prev.includes(value) ? prev : [...prev, value]));

  // In-page navigation target: the graph popover / items chip emits a focus
  // request; expand the owning group, then scroll-and-flash the anchor.
  const artifactsRef = useRef(detail.artifacts);
  artifactsRef.current = detail.artifacts;
  useEffect(
    () =>
      onWorkProductFocus((focus: WorkProductFocus) => {
        if (focus.kind === 'artifact') {
          const artifact = artifactsRef.current.find((a) => a.id === focus.id);
          if (!artifact) return;
          // Every rendered artifact is a document (short marker artifacts are
          // not shown); focusing one opens its preview.
          if (isDocumentArtifact(artifact)) {
            openGroup(DOCUMENTS_ACCORDION_VALUE);
            scrollAndFlash(`artifact-${artifact.id}`);
            openArtifactPreview(artifact.id);
          }
          return;
        }
        openGroup(DERIVED_ITEMS_ACCORDION_VALUE);
        if (focus.filterArtifactId !== undefined) {
          setItemsFilter(focus.filterArtifactId || null);
        }
        scrollAndFlash(focus.id ? `item-${focus.id}` : DERIVED_ITEMS_SECTION_ID);
      }),
    [openArtifactPreview],
  );

  if (
    detail.artifacts.length === 0 &&
    questionGates.length === 0 &&
    steering.length === 0 &&
    !showCode
  ) {
    return null;
  }

  const artifactTitleById = new Map(
    activeArtifacts.map((a) => [a.id, a.title || a.id] as [string, string]),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Work products</CardTitle>
        <p className="text-xs text-muted-foreground">
          Artifacts, human questions and course corrections captured during this intent.
        </p>
      </CardHeader>
      <CardContent>
        <Accordion
          type="multiple"
          value={openGroups}
          onValueChange={setOpenGroups}
          className="space-y-2"
        >
          <CodeSection items={codeItems} />
          <DocumentsSection
            documents={documents}
            stageRows={stageRows}
            phaseNameOf={phaseNameOf}
            getNeighbors={getNeighbors}
            itemsByArtifact={itemsByArtifact}
            openArtifactPreview={openArtifactPreview}
          />

          <DerivedItemsSection
            items={derivedItems}
            getNeighbors={getNeighbors}
            openItemPreview={openItemPreview}
            filterArtifactId={itemsFilter}
            onClearFilter={() => setItemsFilter(null)}
            artifactTitleById={artifactTitleById}
          />

          {questionGates.length > 0 && (
            <AccordionItem value="questions" className="rounded-md border px-3">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <FileQuestion className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Questions</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {questionGates.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pb-3">
                {questionGates.map((gate) => (
                  <QuestionHistoryCard
                    key={gate.humanTaskId}
                    gate={gate}
                    influencedArtifacts={influencedArtifactsByQuestion.get(gate.humanTaskId) ?? []}
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}

          {steering.length > 0 && (
            <AccordionItem value="steering" className="rounded-md border px-3">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Compass className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Course corrections</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {steering.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pb-3">
                {steering.map((s) => (
                  <SteeringCard key={s.steerId} steer={s} />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </CardContent>
    </Card>
  );
}

const STEERING_KIND_LABEL: Record<IntentSteering['kind'], string> = {
  'gate-steer': 'with an answer',
  revision: 'revised answer',
  rewind: 'rewind guidance',
};

function SteeringCard({ steer }: { steer: IntentSteering }) {
  return (
    <div className="rounded-md border bg-card px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Compass className="h-3.5 w-3.5 text-agent-waiting" />
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {STEERING_KIND_LABEL[steer.kind] ?? steer.kind}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            'px-1.5 py-0 text-[10px]',
            steer.status === 'consumed'
              ? 'bg-agent-success/10 text-agent-success border-agent-success/30'
              : steer.status === 'pending'
                ? 'bg-agent-waiting/10 text-agent-waiting border-agent-waiting/30'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {steer.status === 'consumed'
            ? 'delivered'
            : steer.status === 'pending'
              ? 'queued'
              : 'superseded'}
        </Badge>
        {steer.targetStageId && (
          <span className="text-[11px] text-muted-foreground">→ {steer.targetStageId}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {steer.createdByName ? `${steer.createdByName} · ` : ''}
          {steer.createdAt ? new Date(steer.createdAt).toLocaleString() : ''}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{steer.message}</p>
    </div>
  );
}

// Map a v2 HUMAN# gate to the right editor, keyed by the intent collaboration
// scope. `question` gates render the structured QuestionEditor; approval and
// review-verdict gates render prompt + options. NOTE: the runtime currently
// only emits `question` gates — the other branches are forward-compat for the
// schema-valid kinds (lambda/shared/v2-process-keys.js HUMAN_TASK_KINDS).
// Engine-gate option → answer status (WP5 construction gates): reject-flavored
// options retire the gate as 'rejected'; approve-flavored as 'approved'; the
// rest (retry/skip/abort/autonomous/gated) are plain answers.
const engineGateStatusFor = (opt: string): GateAnswer['status'] =>
  /^(reject|request-changes)/i.test(opt)
    ? 'rejected'
    : /^(approve|accept-as-is)/i.test(opt)
      ? 'approved'
      : 'answered';

function ReviewStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-md border bg-background px-3 py-2',
        tone === 'ok' && 'border-agent-success/30 bg-agent-success/5',
        tone === 'warn' && 'border-agent-waiting/30 bg-agent-waiting/5',
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

function useCollaborativeReviewFeedback({
  projectId,
  intentId,
  humanTaskId,
  userName,
  enabled,
}: {
  projectId: string;
  intentId: string;
  humanTaskId: string;
  userName: string;
  enabled: boolean;
}) {
  const docId = enabled ? `intent-review-${intentId}-${humanTaskId}` : null;
  const { doc, remoteUsers, setCursor } = useYjsDocument(
    docId,
    userName,
    generateColor(userName || humanTaskId),
    { intentId, projectId },
  );
  const [feedback, setFeedbackState] = useState('');

  useEffect(() => {
    setFeedbackState('');
  }, [docId]);

  useEffect(() => {
    if (!doc || !docId) return;
    const text = doc.getText('feedback');
    const update = () => setFeedbackState(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [doc, docId]);

  const setFeedback = useCallback(
    (value: string, cursorPos?: number) => {
      if (!doc || !docId) {
        setFeedbackState(value);
        return;
      }
      const text = doc.getText('feedback');
      const current = text.toString();
      if (current === value) return;
      const cursor = cursorPos ?? value.length;
      const diff = simpleDiffStringWithCursor(current, value, cursor);
      doc.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove);
        if (diff.insert) text.insert(diff.index, diff.insert);
      });
    },
    [doc, docId],
  );

  const getFeedback = useCallback(
    () => (doc && docId ? doc.getText('feedback').toString() : feedback),
    [doc, docId, feedback],
  );

  return { feedback, setFeedback, getFeedback, remoteUsers, setCursor };
}

function StageReviewPanel({
  gate,
  detail,
  projectId,
  intentId,
  userName,
  onAnswer,
  onBack,
}: {
  gate: IntentGate;
  detail: IntentDetail;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
  onBack: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  // Gate-time "skip to stage X" (stage-skip.js): the backend computed the
  // valid forward targets (every intermediate is CONDITIONAL); '' = none.
  // Rides the approve answer as { decision: 'approve', skipTo } and is
  // re-validated server-side.
  const [skipTo, setSkipTo] = useState('');
  const skipTargets = gate.skipTargets ?? [];
  // Gate-time recompose delta: arbitrary LATER CONDITIONAL stages to drop,
  // decided right here where the results are reviewed — rides the approve
  // answer as { recompose: { skip: [...] } }, applied in place (no relaunch),
  // re-validated server-side. The offer list was computed by the same
  // validator that judges the answer.
  const [reshapeSkips, setReshapeSkips] = useState<Set<string>>(new Set());
  const recomposeTargets = gate.recomposeTargets ?? [];
  const toggleReshapeSkip = (stageId: string) =>
    setReshapeSkips((prev) => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  const graph = useIntentGraph(projectId, intentId);
  const stage = detail.stages.find((s) => s.stageInstanceId === gate.stageInstanceId) ?? null;
  const artifacts = detail.artifacts.filter(
    (a) => a.createdByStageInstanceId === gate.stageInstanceId,
  );
  const sensors = detail.sensorRuns.filter((s) => s.stageInstanceId === gate.stageInstanceId);
  const reviewerRuns = sensors.filter((s) => s.sensorId.startsWith('reviewer:'));
  const reviewerFailCount = reviewerRuns.filter(
    (run) => run.result !== 'PASS' && run.detail?.verdict !== 'READY',
  ).length;
  const derivedItems = artifacts.flatMap(
    (artifact) => graph.itemsByArtifact.get(artifact.id) ?? [],
  );
  const artifactSummaries = artifacts.filter(
    (artifact) => artifact.summaryGist || (artifact.summaryClaims?.length ?? 0) > 0,
  );
  const pending = gate.status === 'pending';
  const reviewTitle = `Review ${stage?.stageId ?? gate.humanTaskId}`;
  const { feedback, setFeedback, getFeedback, remoteUsers, setCursor } =
    useCollaborativeReviewFeedback({
      projectId,
      intentId,
      humanTaskId: gate.humanTaskId,
      userName,
      enabled: pending,
    });
  const submit = async (decision: 'approve' | 'request-changes') => {
    setSubmitting(true);
    try {
      const currentFeedback = getFeedback();
      await onAnswer(gate, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        answer:
          decision === 'approve'
            ? {
                decision,
                ...(skipTo ? { skipTo } : {}),
                ...(reshapeSkips.size ? { recompose: { skip: [...reshapeSkips] } } : {}),
              }
            : { decision, feedback: currentFeedback },
      });
      onBack();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-agent-waiting/30">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              Review stage {stage?.stageId ?? gate.stageInstanceId}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Durable human validation gate. This page stays open alongside discussions and
              timeline.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to intent
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <ReviewStat label="Artifacts" value={artifacts.length} />
          <ReviewStat label="Derived items" value={derivedItems.length} />
          <ReviewStat
            label="Reviewer findings"
            value={reviewerFailCount}
            tone={reviewerFailCount ? 'warn' : 'ok'}
          />
          <ReviewStat label="Gate" value={gate.status} tone={pending ? 'warn' : 'ok'} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <section className="space-y-3 rounded-lg border border-agent-waiting/30 bg-agent-waiting/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Decision</h2>
            <DiscussButton
              entityType="review"
              entityId={gate.humanTaskId}
              entityTitle={reviewTitle}
            />
          </div>
          {pending ? (
            <div className="space-y-3">
              <Label htmlFor="review-feedback">Request changes feedback</Label>
              <CollaborativeTextarea
                id="review-feedback"
                value={feedback}
                onChange={setFeedback}
                onCursorChange={setCursor}
                remoteUsers={remoteUsers}
                rows={4}
                placeholder="What should the agent change before this stage can continue?"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
              />
              {remoteUsers.size > 0 && (
                <div className="flex items-center gap-1">
                  {Array.from(remoteUsers.values()).map((u, i) => (
                    <div
                      key={i}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
                      style={{ backgroundColor: u.color }}
                    >
                      {u.name?.charAt(0)}
                    </div>
                  ))}
                  <span className="text-xs text-primary">collaborating</span>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border bg-background p-3 text-sm text-muted-foreground">
              Answered by {gate.answeredByName || gate.answeredBy || 'someone'}
              {gate.answeredAt ? ` at ${new Date(gate.answeredAt).toLocaleString()}` : ''}.
            </div>
          )}
          {pending && recomposeTargets.length > 0 && (
            <details className="rounded-md border bg-background/60 px-3 py-2">
              <summary
                className="cursor-pointer list-none text-xs font-medium"
                data-testid="review-reshape-toggle"
              >
                Reshape upcoming stages
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {reshapeSkips.size
                    ? `— dropping ${reshapeSkips.size} with this approval`
                    : '— optionally drop later optional stages based on what you just reviewed'}
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Checked stages are skipped when you approve — applied in place, the run keeps
                  going. Downstream stages treat their outputs as absent by design; rewind to a
                  skipped stage to bring it back. For bigger reshapes (adding stages back, a whole
                  new grid), use <em>Reshape remaining stages</em> on the intent page.
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {recomposeTargets.map((t) => (
                    <label
                      key={t}
                      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
                      data-testid={`review-reshape-${t}`}
                    >
                      <input
                        type="checkbox"
                        checked={reshapeSkips.has(t)}
                        onChange={() => toggleReshapeSkip(t)}
                        disabled={submitting}
                        className="h-3.5 w-3.5"
                      />
                      <span
                        className={reshapeSkips.has(t) ? 'line-through text-muted-foreground' : ''}
                      >
                        {t}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </details>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {pending && (
              <>
                {skipTargets.length > 0 && (
                  <div className="mr-auto flex items-center gap-2">
                    <Label htmlFor="skip-to-select" className="text-xs text-muted-foreground">
                      After approval
                    </Label>
                    <Select
                      value={skipTo || 'next'}
                      onValueChange={(v) => setSkipTo(v === 'next' ? '' : v)}
                      disabled={submitting}
                    >
                      <SelectTrigger id="skip-to-select" className="h-8 w-56 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* Name the COMPUTED next stage verbatim (upstream
                            2.2.6) — "Complete workflow" when this is the last
                            stage; the generic label only on legacy gates that
                            never carried the field. */}
                        <SelectItem value="next">
                          {gate.nextStageId !== undefined
                            ? gate.nextStageId
                              ? `Continue to ${gate.nextStageId}`
                              : 'Complete workflow'
                            : 'Continue to the next stage'}
                        </SelectItem>
                        {skipTargets.map((t) => (
                          <SelectItem key={t} value={t}>
                            Skip ahead to {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  variant="outline"
                  disabled={submitting || !feedback.trim()}
                  onClick={() => submit('request-changes')}
                >
                  Request changes
                </Button>
                <Button disabled={submitting} onClick={() => submit('approve')}>
                  {skipTo
                    ? `Approve & skip to ${skipTo}`
                    : reshapeSkips.size
                      ? `Approve & drop ${reshapeSkips.size} stage${reshapeSkips.size === 1 ? '' : 's'}`
                      : gate.nextStageId !== undefined
                        ? gate.nextStageId
                          ? `Approve — continue to ${gate.nextStageId}`
                          : 'Approve — complete workflow'
                        : 'Approve stage'}
                </Button>
              </>
            )}
          </div>
          {pending && skipTo && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Every CONDITIONAL stage between this one and {skipTo} will be marked skipped;
              downstream stages treat their outputs as absent by design. {skipTo} itself runs in
              full. You can re-add a skipped stage later by rewinding to it.
            </p>
          )}
        </section>

        <Accordion type="multiple" defaultValue={[]} className="space-y-2">
          <AccordionItem value="summary" className="rounded-lg border px-4">
            <AccordionTrigger className="py-3 hover:no-underline">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-agent-running" />
                <span>At a glance</span>
                {artifactSummaries.length > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    LLM summary
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              {artifactSummaries.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {artifactSummaries.map((artifact) => (
                    <div key={artifact.id} className="rounded-md border bg-background p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {artifact.title || artifact.id}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {artifact.artifactType || 'artifact'}
                          </p>
                        </div>
                        {artifact.enrichmentModel && (
                          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9px]">
                            {artifact.enrichmentModel}
                          </Badge>
                        )}
                      </div>
                      {artifact.summaryGist && (
                        <p className="mt-2 text-sm text-muted-foreground">{artifact.summaryGist}</p>
                      )}
                      {artifact.summaryClaims && artifact.summaryClaims.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {artifact.summaryClaims.slice(0, 5).map((claim, idx) => (
                            <li key={`${artifact.id}-claim-${idx}`} className="flex gap-1.5">
                              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-agent-success" />
                              <span>{claim}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No LLM artifact summary is available for this stage. Review the extracted items
                  and full artifacts below.
                </p>
              )}
              {derivedItems.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Extracted review checklist</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {derivedItems.length}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {derivedItems.slice(0, 18).map((item) => (
                      <Badge key={item.id} variant="outline" className="max-w-full truncate">
                        {item.slug ? `${item.slug}: ` : ''}
                        {item.label}
                      </Badge>
                    ))}
                    {derivedItems.length > 18 && (
                      <Badge variant="secondary">+{derivedItems.length - 18} more</Badge>
                    )}
                  </div>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="reviewer-findings" className="rounded-lg border px-4">
            <AccordionTrigger className="py-3 hover:no-underline">
              <div className="flex items-center gap-2">
                <Badge variant={pending ? 'secondary' : 'outline'}>{gate.status}</Badge>
                <span>LLM reviewer findings</span>
                {stage?.phase && <Badge variant="outline">{stage.phase}</Badge>}
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              {reviewerRuns.length > 0 ? (
                <div className="space-y-2 text-sm">
                  {reviewerRuns.map((run) => (
                    <div key={run.sensorRunId} className="rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={run.result === 'PASS' ? 'default' : 'destructive'}>
                          {String(run.detail?.verdict ?? run.result)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{run.sensorId}</span>
                      </div>
                      {typeof run.detail?.findings === 'string' && run.detail.findings && (
                        <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                          {run.detail.findings}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No LLM reviewer findings were recorded.
                </p>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="full-artifacts" className="rounded-lg border px-4">
            <AccordionTrigger className="py-3 hover:no-underline">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span>Full artifacts</span>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {artifacts.length}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              {artifacts.length ? (
                artifacts.map((artifact) => (
                  <ArtifactViewer key={artifact.id} artifact={artifact} />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No graph artifacts were produced by this stage.
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={onBack}>
            Back to intent
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GateCard({
  gate,
  isActiveGate,
  projectId,
  intentId,
  userName,
  onAnswer,
}: {
  gate: IntentGate;
  isActiveGate: boolean;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
}) {
  const navigate = useNavigate();
  // Steering (docs/v2-steering.md): an optional course correction riding the
  // answer — injected into the resumed agent conversation right after it, so
  // the human can redirect the agent's direction while answering.
  const [steering, setSteering] = useState('');
  // Free-text feedback for engine gates offering 'request-changes' (skeleton /
  // batch revision loops): sent as { decision, feedback } so the engine
  // re-runs the increment with it and re-asks.
  const [feedback, setFeedback] = useState('');
  const question = useMemo<Question | null>(() => {
    let parsed: Question['questions'];
    try {
      parsed = gate.questions ? JSON.parse(gate.questions) : [];
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return {
      id: gate.humanTaskId,
      agent: gate.stageInstanceId ?? 'agent',
      questions: parsed,
      sprintId: '',
      createdAt: gate.createdAt ?? '',
    };
  }, [gate]);

  if (gate.kind === 'validation') {
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-3 py-3">
          <div>
            <p className="text-sm font-medium">Stage output awaits review</p>
            <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">
              {gate.prompt ||
                'Approve this stage or request changes before the workflow continues.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                navigate(`/project/${projectId}/intent/${intentId}/review/${gate.humanTaskId}`)
              }
            >
              Review stage
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (gate.kind === 'review-verdict') {
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-2 py-3">
          <p className="text-sm font-medium">{gate.prompt || 'Review verdict required'}</p>
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onAnswer(gate, {
                      answer: opt,
                      status: /reject/i.test(opt) ? 'rejected' : 'answered',
                    })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => onAnswer(gate, { answer: 'approve', status: 'approved' })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAnswer(gate, { answer: 'reject', status: 'rejected' })}
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!question) {
    // A non-structured gate — the engine's construction gates (walking
    // skeleton / autonomy ladder / batch / halt-and-ask, docs/v2-parallel.md
    // WP5) arrive as kind 'approval' with a prompt and an options array; each
    // option submits `{ decision }` (the shape the orchestrator's parseChoice
    // consumes). Gates offering 'request-changes' carry the free-text feedback
    // below with the answer — the engine re-runs the increment with it and
    // re-asks (upstream stage-protocol §1), so a reject never kills the run.
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    const offersRevision = options.some((o) => /^request-changes/i.test(o));
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-2 py-3">
          {gate.unitSlug && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-normal">
              unit {gate.unitSlug}
            </Badge>
          )}
          <p className="whitespace-pre-line text-sm">{gate.prompt || 'Approval required'}</p>
          {offersRevision && (
            <div className="space-y-1 rounded-md border border-dashed px-3 py-2">
              <Label
                htmlFor={`gate-feedback-${gate.humanTaskId}`}
                className="text-[11px] font-medium text-muted-foreground"
              >
                Request-changes feedback (optional)
              </Label>
              <Textarea
                id={`gate-feedback-${gate.humanTaskId}`}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What should change before you can approve? Sent with 'request-changes' — the engine revises the increment with this feedback and asks again."
                rows={2}
                className="text-xs"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant={engineGateStatusFor(opt) === 'rejected' ? 'outline' : 'default'}
                  onClick={() =>
                    onAnswer(gate, {
                      answer: {
                        decision: opt,
                        ...(/^request-changes/i.test(opt) && feedback.trim()
                          ? { feedback: feedback.trim() }
                          : {}),
                      },
                      status: engineGateStatusFor(opt),
                    })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <Button
                size="sm"
                onClick={() => onAnswer(gate, { answer: { approved: true }, status: 'approved' })}
              >
                Approve
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={cn(isActiveGate && 'ring-1 ring-agent-waiting/40 rounded-lg')}>
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: intentId, projectId }}
        userName={userName}
        onAnswer={(structuredAnswer) =>
          onAnswer(gate, {
            answer: structuredAnswer,
            ...(steering.trim() ? { steering: steering.trim() } : {}),
          })
        }
      />
      {/* Optional course correction delivered WITH the answer. */}
      <div className="mt-1.5 space-y-1 rounded-md border border-dashed px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Compass className="h-3 w-3" />
          Course correction (optional)
        </div>
        <Textarea
          value={steering}
          onChange={(e) => setSteering(e.target.value)}
          placeholder="Redirect the agent if it is heading the wrong way — e.g. 'Stop building the REST layer; integrate with the existing event bus instead.' Sent with your answer and overrides the agent's current plan."
          rows={2}
          className="text-xs"
        />
      </div>
    </div>
  );
}

function QuestionHistoryCard({
  gate,
  influencedArtifacts,
}: {
  gate: IntentGate;
  influencedArtifacts: { id: string; title: string }[];
}) {
  const { detail, steering, reviseGate } = useIntent();
  const questions = parseGateQuestions(gate.questions);
  const answer = formatGateAnswer(gate.answer, questions);
  const superseded = gate.status === 'superseded';
  const answered = !superseded && (gate.status !== 'pending' || Boolean(gate.answeredAt));

  // Steering revision (docs/v2-steering.md): correct an already-given answer.
  // The original stays; the correction is delivered at the next injection point.
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const revisionSteer = gate.revisionSteerId
    ? (steering.find((s) => s.steerId === gate.revisionSteerId) ?? null)
    : null;
  const intentStatus = detail?.intent.status ?? '';
  const canRevise = answered && !['SUCCEEDED', 'CANCELLED'].includes(intentStatus);

  const handleRevise = async () => {
    if (!revision.trim()) return;
    setRevising(true);
    setReviseError(null);
    try {
      await reviseGate(gate, revision.trim());
      setReviseOpen(false);
      setRevision('');
    } catch (err) {
      setReviseError(err instanceof Error ? err.message : 'Failed to revise the answer');
    } finally {
      setRevising(false);
    }
  };

  return (
    <div
      id={`question-${gate.humanTaskId}`}
      className="scroll-mt-4 rounded-md border bg-card px-3 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                'px-1.5 py-0 text-[10px]',
                superseded
                  ? 'bg-muted text-muted-foreground'
                  : answered
                    ? 'bg-agent-success/10 text-agent-success border-agent-success/30'
                    : 'bg-agent-waiting/10 text-agent-waiting border-agent-waiting/30',
              )}
            >
              {superseded ? 'superseded' : answered ? 'answered' : 'pending'}
            </Badge>
            {gate.revisedAt && (
              <Badge
                variant="outline"
                className="border-agent-waiting/30 bg-agent-waiting/10 px-1.5 py-0 text-[10px] text-agent-waiting"
              >
                revised
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              {gate.stageInstanceId || 'agent question'}
            </span>
          </div>
          {(gate.answeredByName || gate.answeredBy || gate.answeredAt) && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {gate.answeredByName || gate.answeredBy
                ? `answered by ${gate.answeredByName || gate.answeredBy}`
                : ''}
              {gate.answeredAt ? ` · ${new Date(gate.answeredAt).toLocaleString()}` : ''}
            </p>
          )}
        </div>
        <DiscussButton
          entityType="question"
          entityId={gate.humanTaskId}
          entityTitle={questions[0]?.text || 'Question'}
          className="shrink-0"
        />
      </div>

      <div className="mt-3 space-y-2">
        {questions.length > 0 ? (
          questions.map((q, idx) => (
            <div key={idx} className="rounded border bg-muted/20 px-2 py-2">
              <p className="text-sm font-medium">{q.text || `Question ${idx + 1}`}</p>
              {Array.isArray(q.options) && q.options.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Options:{' '}
                  {q.options
                    .map((o) => o.label)
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Question details unavailable.</p>
        )}

        {answered ? (
          <div className="rounded border border-agent-success/20 bg-agent-success/[0.04] px-2 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Answer
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{answer || 'Answered'}</p>
          </div>
        ) : superseded ? (
          <p className="text-xs text-muted-foreground">
            Retired unanswered when the run was cancelled or rewound.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This question is still open. Use the Open questions section above to answer it.
          </p>
        )}

        {/* An existing revision: the correction layered on the original answer. */}
        {revisionSteer && (
          <div className="rounded border border-agent-waiting/30 bg-agent-waiting/[0.05] px-2 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Correction{' '}
              {revisionSteer.status === 'consumed'
                ? '(delivered to the agent)'
                : '(queued — delivered at the next stage boundary)'}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{revisionSteer.message}</p>
          </div>
        )}

        {canRevise && !reviseOpen && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => setReviseOpen(true)}
          >
            <Compass className="h-3 w-3" />
            Revise answer
          </Button>
        )}
        {canRevise && reviseOpen && (
          <div className="space-y-2 rounded-md border border-agent-waiting/40 bg-agent-waiting/[0.04] p-2">
            <p className="text-[11px] text-muted-foreground">
              The original answer stays on record; your correction reaches the agent at its next
              deterministic point (question resume or stage start) and overrides the old answer.
            </p>
            <Textarea
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="What should the agent do differently?"
              rows={2}
              className="text-xs"
            />
            {reviseError && <p className="text-[11px] text-agent-error">{reviseError}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={!revision.trim() || revising}
                onClick={handleRevise}
              >
                {revising ? 'Sending…' : 'Send correction'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                disabled={revising}
                onClick={() => {
                  setReviseOpen(false);
                  setReviseError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {influencedArtifacts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">Influenced artifacts:</span>
            {influencedArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  document
                    .getElementById(`artifact-${artifact.id}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {artifact.title || artifact.id}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function parseGateQuestions(raw: string | null): Question['questions'] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatGateAnswer(answer: unknown, questions: Question['questions']): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer !== 'object') return String(answer);
  // Engine-gate answers (WP5 construction gates): a single decision word.
  const decision = (answer as { decision?: unknown }).decision;
  if (typeof decision === 'string') return decision;
  const structured = answer as { answers?: { selectedOptions?: unknown[]; freeText?: string }[] };
  if (Array.isArray(structured.answers)) {
    return structured.answers
      .map((a, idx) => {
        const selected = Array.isArray(a.selectedOptions)
          ? a.selectedOptions
              .map((opt) => {
                const optionIndex = typeof opt === 'number' ? opt : Number(opt);
                return Number.isInteger(optionIndex)
                  ? (questions[idx]?.options?.[optionIndex]?.label ?? String(opt))
                  : String(opt);
              })
              .join(', ')
          : '';
        const free = a.freeText?.trim() ?? '';
        const response = [selected, free].filter(Boolean).join(' · ');
        return response ? `Q${idx + 1}: ${response}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(answer);
}
