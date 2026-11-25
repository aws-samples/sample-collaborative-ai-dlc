import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import {
  intentsService,
  type IntentDetail,
  type NativeExportHarness,
  type NativeWorkflowExport,
} from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useAuth } from '@/contexts/AuthContext';
import { getCachedIntentSummary, useProjectCache } from '@/hooks/useProjectsCache';
import { DeliveryStatus } from '@/components/intent/DeliveryStatus';
import { RecomposePanel } from '@/components/intent/RecomposePanel';
import { IntentConfigurationDialog } from '@/components/intent/IntentConfigurationDialog';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { deriveLaneWaits } from '@/lib/intentRecovery';
import { completionExplanation } from '@/lib/completionExplanation';
import { resumeOrExplain, type ResumeNotice } from '@/lib/intentActions';
import {
  PendingQuestionsTabs,
  gateCardId,
  gateQuestionCount,
} from '@/components/intent/PendingQuestionsTabs';
import { IntentPhaseBreadcrumb } from '@/components/layout/IntentPipelineBar';
import { QuorumEditPanel } from '@/components/intent/QuorumEditPanel';
import { UnitLaneBoard, isFanoutActive } from '@/components/intent/UnitLaneBoard';
import { AgentProgressCard } from '@/components/intent/AgentProgressCard';
import { IntentOutcomeCallout, openDecisions } from '@/components/intent/IntentOutcomeCallout';
import { IntentPageHeader } from '@/components/intent/IntentPageHeader';
import { reshapeDisabledReason, VIEW_ONLY_REASON } from '@/lib/intentActions';
import { IntentActionsMenu } from '@/components/intent/IntentActionsMenu';
import { aidlcReleasesService } from '@/services/aidlcReleases';
import { GateCard } from '@/components/intent/GateCard';
import { StageReviewPanel } from '@/components/intent/StageReviewPanel';
import { WorkProductsSection } from '@/components/intent/WorkProductsSection';
import { NativeExportSetupDialog } from '@/components/intent/NativeExportSetupDialog';
import { nativeExportErrorMessage } from '@/components/intent/nativeExportError';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/empty-state';
import { IntentNotFoundState } from '@/components/intent/IntentNotFoundState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TechnicalDetails } from '@/components/ui/technical-details';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { displayStageName } from '@/lib/displayNames';
import { useReturnFocus } from '@/components/intent/useReturnFocus';
import { deriveIntentStatus } from '@/lib/statusModel';
import { cn } from '@/lib/utils';
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
  KeyRound,
  Loader2,
  Milestone,
  Play,
  TriangleAlert,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';

// The v2 intent page — main-pane content only. All fetch/realtime/output state
// lives in IntentProvider (mounted by AppShell, shared with the right-hand
// IntentActivityPanel where output/timeline/discussions render).

const CREDENTIAL_FAILURE_CODES = new Set([
  'credential_unavailable',
  'credential_invalid',
  'credential_quota_exhausted',
]);
const NON_EXPORTABLE_STATUSES = new Set(['DRAFT', 'CREATED']);
const EXPORT_HARNESSES: Array<{ value: NativeExportHarness; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'kiro', label: 'Kiro CLI' },
  { value: 'kiro-ide', label: 'Kiro IDE' },
  { value: 'opencode', label: 'OpenCode' },
];

// Review-route title ("Feasibility — questions") and the one-line reason. No
// count: the card below numbers its questions ("Q1 / 2").
const GATE_REVIEW_INTRO: Record<string, { noun: (count: number) => string; needs: string }> = {
  question: {
    noun: (count) => (count === 1 ? 'question' : 'questions'),
    needs: 'The agent needs an answer before this stage can continue.',
  },
  approval: { noun: () => 'approval', needs: 'This stage needs your approval to continue.' },
  'review-verdict': {
    noun: () => 'reviewer verdict',
    needs: 'A reviewer verdict is needed before this stage can continue.',
  },
};

const COMPLETION_NOTICE = {
  incomplete: {
    title: 'Incomplete work',
    body: 'The recorded success has unfinished current-plan work. Review the remaining units before publishing.',
  },
  unknown: {
    title: 'Completion unverified',
    body: 'Completion could not be verified. Review the recorded work and available evidence before publishing.',
  },
  partial: {
    title: 'Partial delivery',
    body: 'Partial delivery was explicitly accepted. Integrated work and the recorded omissions are preserved.',
  },
} as const;

const completionNotice = (state: string) =>
  state === 'unknown' || state === 'partial'
    ? COMPLETION_NOTICE[state]
    : COMPLETION_NOTICE.incomplete;

// Legacy `failureReason` ("stage_failed: <stage>: <code>: <detail>") is the only
// place some runs name the failed stage; `failure.message` alone loses it. A
// message that says more than the reason is kept after it for the details.
function withStageFailure(detail: IntentDetail): IntentDetail {
  const { failure, failureReason } = detail.intent;
  if (detail.intent.status !== 'FAILED') return detail;
  if (!failureReason?.startsWith('stage_failed: ')) return detail;
  const message = failure?.message?.trim();
  if (message?.startsWith('stage_failed: ')) return detail;
  const merged =
    message && !failureReason.includes(message) ? `${failureReason} — ${message}` : failureReason;
  return {
    ...detail,
    intent: {
      ...detail.intent,
      failure: { code: failure?.code ?? 'stage_failed', message: merged },
    },
  };
}

const errorMessage = (value: string) => {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      if ('message' in parsed && typeof parsed.message === 'string') return parsed.message;
      if ('error' in parsed && typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    // Plain-text errors are already display-ready.
  }
  return value;
};

export default function IntentView() {
  const {
    projectId,
    intentId,
    detail,
    loading,
    error: loadError,
    notFound,
    gates,
    pendingGates,
    reload,
    answerGate,
    cancelIntent,
    deleteIntent,
    rewindIntent,
    resumeIntent,
    focusOutput,
    stageRows,
    gateAccess,
    mayControlStage,
    firstNonAutomaticStageId,
    stageNameOf,
    lastActivityAt,
  } = useIntent();
  const navigate = useNavigate();
  const { humanTaskId: reviewGateId } = useParams<{ humanTaskId?: string }>();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  // Role gate for the destructive delete (owner — the API enforces it
  // too; hiding the button just avoids a guaranteed 403).
  const { project } = useProjectCache(projectId ?? null);
  const { readOnly, canManage } = useSpacePermissions();
  const canDelete = canManage ?? project?.userRole === 'owner';
  const canRepair = canDelete;

  const [starting, setStarting] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [reshapeOpen, setReshapeOpen] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const returnFocusAfterExport = useReturnFocus(confirmExport);
  const returnFocusAfterRepair = useReturnFocus(confirmRepair);
  const [selectedExportHarness, setSelectedExportHarness] = useState<
    NativeExportHarness | undefined
  >();
  const [exporting, setExporting] = useState(false);
  const [focusedGateId, setFocusedGateId] = useState<string | null>(null);
  const [constructionExport, setConstructionExport] = useState<NativeWorkflowExport | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [pinningEnabled, setPinningEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    aidlcReleasesService
      .sharedChannels()
      .then((channels) => {
        if (!cancelled) setPinningEnabled(channels.pinningEnabled === true);
      })
      .catch(() => {
        if (!cancelled) setPinningEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A stage failure retries from the earliest failed stage, preserving all
  // completed upstream work. Failures before any stage row exists (init-ws,
  // plan setup, or a stranded CREATED hand-off) still require a full start.
  const failedStage =
    detail?.intent.status === 'FAILED'
      ? (stageRows.find((stage) => stage.planned && stage.state === 'FAILED') ?? null)
      : null;
  const recover = async (action: () => Promise<void>) => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setDismissedError(null);
      setActionError(err instanceof Error ? err.message : 'Failed to recover intent');
    } finally {
      setStarting(false);
    }
  };
  const handleRestartFromStage = () =>
    failedStage ? recover(() => rewindIntent(failedStage.stageId)) : Promise.resolve();
  const handleStartAgain = () =>
    recover(async () => {
      await intentsService.start(projectId, intentId);
      await reload();
    });

  // Cancel (steering): retire a parked (WAITING), stranded (CREATED) or FAILED
  // run — supersedes pending gates and flips the run to CANCELLED. RUNNING
  // cannot be cancelled mid-turn (the API 409s); the button hides for it.
  // Resume's expired (409) and retryable (503) outcomes: resumeOrExplain.
  const handleResume = async () => {
    setResuming(true);
    setActionError(null);
    setResumeNotice(null);
    try {
      const notice = await resumeOrExplain(resumeIntent, reload);
      if (notice) {
        setDismissedError(null);
        setResumeNotice(notice);
      }
    } catch (err) {
      setDismissedError(null);
      setActionError(err instanceof Error ? err.message : 'Failed to resume intent');
    } finally {
      setResuming(false);
    }
  };

  // Confirmed by IntentActionsMenu's AlertDialog; rethrow so the dialog
  // knows the action failed while this page reports the error.
  const handleCancel = async () => {
    setActionError(null);
    try {
      await cancelIntent();
    } catch (err) {
      setDismissedError(null);
      setActionError(err instanceof Error ? err.message : 'Failed to cancel intent');
      throw err;
    }
  };

  // Permanent delete (owner): removes the intent's graph data, run
  // history and realtime docs, then returns to the project page. Refused by
  // the API while RUNNING — the menu hides it for that status.
  const handleDelete = async () => {
    setActionError(null);
    try {
      await deleteIntent();
      navigate(`/space/${projectId}`);
    } catch (err) {
      setDismissedError(null);
      setActionError(err instanceof Error ? err.message : 'Failed to delete intent');
      throw err;
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
      setDismissedError(null);
      setActionError(err instanceof Error ? err.message : 'Failed to repair intent');
    } finally {
      setRepairing(false);
    }
  };

  const handleExport = async (harness?: NativeExportHarness) => {
    setConfirmExport(false);
    setExporting(true);
    setActionError(null);
    try {
      const result = await intentsService.exportWorkflow(projectId, intentId, harness);
      const download = document.createElement('a');
      download.href = result.downloadUrl;
      download.download = result.filename;
      download.rel = 'noopener';
      document.body.append(download);
      download.click();
      download.remove();
      if (result.setup.showWorkspaceSetup || result.warnings.length > 0) {
        setConstructionExport(result);
      }
    } catch (err) {
      setDismissedError(null);
      setActionError(nativeExportErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  if (!projectId || !intentId) return <IntentNotFoundState spacePath="/dashboard" />;
  const spacePath = `/space/${projectId}`;
  if (loading && !detail) {
    const cached = getCachedIntentSummary(projectId, intentId);
    return (
      <div className="space-y-6">
        {cached ? (
          <IntentPageHeader intent={cached} />
        ) : (
          <Skeleton label="Loading intent" className="h-9 w-72 rounded-md" />
        )}
        <Skeleton label={cached ? 'Loading intent' : 'Loading work'} className="h-28 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }
  if (!detail && notFound) {
    return <IntentNotFoundState spacePath={spacePath} />;
  }
  if (!detail) {
    return (
      <ErrorState
        className="mx-auto mt-8 w-full max-w-lg"
        title="Couldn't load this intent"
        description="The intent could not be retrieved. Check your connection and try again."
        headingLevel={1}
        onRetry={() => void reload()}
        secondaryAction={
          <Button variant="outline" size="sm" onClick={() => navigate(`/space/${projectId}`)}>
            Back to space
          </Button>
        }
      />
    );
  }

  const intent = detail.intent;
  const completion = detail.unitCompletion;
  const terminalCompletion = intent.status === 'SUCCEEDED' ? completion?.state : null;
  const laneWaits = deriveLaneWaits(detail.stages, gates);
  const recoveryWaits = Object.values(laneWaits).filter((wait) => wait.kind === 'recovery');
  // Repair stops the run, which would also cancel a sibling lane's resume, so
  // the server refuses it until every resuming lane has restarted.
  const lanesResuming = Object.values(laneWaits).some((wait) => wait.kind === 'resuming');
  const needsLaneRepair =
    recoveryWaits.length > 0 && ['RUNNING', 'WAITING', 'FAILED'].includes(intent.status);
  const error = actionError ?? loadError;
  const visibleError = error && error !== dismissedError ? errorMessage(error) : null;
  const isDraft = intent.status === 'DRAFT';
  // A DRAFT belongs on the collaborative compose page — one canonical draft
  // experience (shared prompt + projection selection) instead of two UIs.
  if (isDraft) {
    return <Navigate to={`/space/${projectId}/intent/${intentId}/compose`} replace />;
  }
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';
  const isFailed = intent.status === 'FAILED';
  const recoveryStageId = isFailed ? (failedStage?.stageId ?? intent.currentStage) : null;
  // The server decides whether a recorded answer still needs its callback
  // re-sent (`resumeAvailable`): the run is live and still parked on that gate,
  // through META for an engine gate or through the asking stage for a question,
  // which covers a unit lane while the intent keeps running.
  const resumeRequired = gates.some((gate) => gate.resumeAvailable === true);
  const canResume =
    canDelete || gates.some((gate) => gate.resumeAvailable && gateAccess(gate).access?.decide);
  const activeStages = detail.stages.filter((r) =>
    ['RUNNING', 'WAITING_FOR_HUMAN'].includes(r.state),
  );
  const canCancel = activeStages.length
    ? activeStages.every((r) => mayControlStage(r.stageId))
    : mayControlStage(intent.currentStage ?? firstNonAutomaticStageId);
  const mayRecover = !recoveryStageId || mayControlStage(recoveryStageId);
  // A Viewer reads the run but changes nothing (the API refuses it too).
  const viewOnlyReason = readOnly ? VIEW_ONLY_REASON : undefined;
  const reshapeBlockedReason = viewOnlyReason ?? reshapeDisabledReason(intent);
  const canReshape = reshapeBlockedReason === undefined;
  const isExportable = !NON_EXPORTABLE_STATUSES.has(intent.status);
  const exportUnavailableReason = 'Not available before the workflow starts';
  const exportDisabledReason =
    viewOnlyReason ??
    (!isExportable ? exportUnavailableReason : exporting ? 'Preparing workspace…' : undefined);
  const defaultExportHarness = intent.agentCli ?? undefined;
  const activeExportHarness = selectedExportHarness ?? defaultExportHarness;
  // Pre-stage progress: before any stage row exists, init-ws lifecycle events
  // are the only signal the run is doing something (they stream into the
  // sidebar Timeline); this strip keeps the main pane from looking dead.
  const noStageRowsYet = detail.stages.length === 0;
  // While parallel unit lanes are live, the units board owns the "what's
  // building" view — suppress the single-stage Running card (it would just echo
  // one lane's stream). The Running card returns after fan-in.
  const fanoutActive = isFanoutActive(detail);
  const reviewGate = reviewGateId ? gates.find((g) => g.humanTaskId === reviewGateId) : null;
  // One stall rule for every surface (statusModel): a CREATED hand-off nobody
  // picked up gets "Restart workflow"; a stalled RUNNING run cannot be restarted or
  // cancelled until the engine parks or fails it, so the callout offers nothing.
  const derived = deriveIntentStatus(intent, { lastActivityAt, gates });
  const canStartAgain = isFailed || (intent.status === 'CREATED' && derived.stalled);
  const isCredentialFailure =
    isFailed && Boolean(intent.failure?.code && CREDENTIAL_FAILURE_CODES.has(intent.failure.code));
  const credentialSettingsPath = isCredentialFailure
    ? intent.credentialSource === 'user'
      ? '/account/settings'
      : intent.credentialSource === 'space'
        ? `/space/${projectId}/settings?tab=agent`
        : null
    : null;
  const workPath = `/space/${projectId}/intent/${intentId}`;
  const newVersionPath = `/space/${projectId}/intent/new?fromIntent=${encodeURIComponent(intentId)}`;
  // Every decision the stage list paints yellow — pending gates AND stages
  // still parked without one. The callout lists them when there is more than
  // one, so a parked stage without a card is announced, never silently hidden.
  const openDecisionCount = openDecisions({ gates, stages: detail.stages }).length;
  const outcomeActions = {
    restartFromStage: failedStage
      ? {
          stageId: failedStage.stageId,
          pending: starting,
          disabled: readOnly || starting || !mayRecover,
          onClick: () => void handleRestartFromStage(),
        }
      : undefined,
    startAgain: canStartAgain
      ? {
          pending: starting,
          disabled: readOnly || starting || !mayRecover,
          onClick: () => void handleStartAgain(),
        }
      : undefined,
    resume: {
      pending: resuming,
      disabled: readOnly || resuming || !canResume,
      onClick: () => void handleResume(),
    },
  };
  // A validation gate has its own review screen; a question is answered in
  // the tabs below, so "Answer" selects that tab and brings it into view.
  const focusGate = (gateId: string) => {
    const gate = gates.find((g) => g.humanTaskId === gateId);
    if (gate?.kind === 'validation') {
      navigate(`${workPath}/review/${gateId}`);
      return;
    }
    setFocusedGateId(gateId);
    // The tabs re-seed on the next render; the card's anchor exists once it
    // is the selected one, so the scroll waits for that frame.
    requestAnimationFrame(() => {
      const anchor =
        document.getElementById(gateCardId(gateId)) ??
        document.getElementById('pending-human-gates');
      anchor?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <IntentPageHeader
        intent={intent}
        lastActivityAt={lastActivityAt}
        gates={gates}
        stages={detail.stages}
        actions={
          <>
            <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
            <IntentActionsMenu
              intent={intent}
              onConfiguration={() => setConfigurationOpen(true)}
              onReshape={() => setReshapeOpen(true)}
              reshapeDisabledReason={reshapeBlockedReason}
              onExport={() => setConfirmExport(true)}
              exportDisabledReason={exportDisabledReason}
              onAudit={() => navigate(`${workPath}/audit`)}
              onCancel={readOnly || !canCancel ? undefined : handleCancel}
              onDelete={canDelete ? handleDelete : undefined}
              extraItems={
                // Opt-in migration (issue #482): never migrates this intent —
                // it opens the create page prefilled from it, and the new
                // intent recomputes its plan on the version chosen there.
                pinningEnabled ? (
                  <IntentActionsMenu.Item onSelect={() => navigate(newVersionPath)}>
                    <Milestone aria-hidden="true" />
                    Start a new intent on another AI-DLC version
                  </IntentActionsMenu.Item>
                ) : null
              }
            />
          </>
        }
      />

      {!reviewGateId && (
        <IntentOutcomeCallout
          detail={withStageFailure(detail)}
          lastActivityAt={lastActivityAt}
          onAnswer={focusGate}
          actions={outcomeActions}
          // One open decision: its full card follows right below, so the
          // callout keeps only the headline. Several decisions: the list stays
          // on desktop — each gate row selects its card, a parked stage without
          // a card opens its output. On a phone the cards are the next thing
          // on screen, so the list is skipped there too.
          className={
            openDecisionCount === 1
              ? '[&_ul[aria-label]]:hidden'
              : '[&_ul[aria-label]]:max-md:hidden'
          }
        />
      )}

      {!reviewGateId && isCredentialFailure && credentialSettingsPath && (
        <Alert
          tone="neutral"
          icon={<KeyRound />}
          title="Fix the agent credential before restarting"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate(credentialSettingsPath)}
            >
              Credential settings
            </Button>
          }
        >
          <AlertDescription>
            {intent.credentialSource === 'user'
              ? 'This run used your personal credential.'
              : 'This run used the credential configured for this space.'}
          </AlertDescription>
        </Alert>
      )}

      {/* On a phone an open question outranks the pipeline: the bar moves below the work. */}
      <div className={cn('empty:hidden', pendingGates.length > 0 && 'max-md:order-last')}>
        <IntentPhaseBreadcrumb
          onOpenScopeDefinition={canReshape ? () => setReshapeOpen(true) : undefined}
        />
      </div>

      {visibleError && (
        <div
          className="flex items-center gap-2 rounded border border-destructive/20 bg-destructive/10 py-2 pl-3 pr-1 text-sm text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">{visibleError}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
            aria-label="Dismiss error"
            onClick={() => setDismissedError(error)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {terminalCompletion && terminalCompletion !== 'complete' && (
        <Alert tone="warning" title={completionNotice(terminalCompletion).title}>
          <AlertDescription>
            <p>
              {terminalCompletion === 'unknown'
                ? completionExplanation(completion?.reason)
                : terminalCompletion === 'incomplete'
                  ? `Unfinished units: ${completion?.unresolved.map((unit) => unit.slug).join(', ') || 'details unavailable'}.`
                  : completionNotice(terminalCompletion).body}
            </p>
            {terminalCompletion !== 'partial' && (
              <p>
                Automatic continuation of finished incomplete intents is not supported. Ordinary
                rewind reruns the affected work.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {intent.status === 'SUCCEEDED' && intent.repos?.length !== 0 && (
        <DeliveryStatus
          key={intentId}
          projectId={projectId}
          intentId={intentId}
          delivery={detail.delivery}
          canRetry={canRepair}
          reload={reload}
        />
      )}

      {needsLaneRepair && (
        <div className="rounded border border-agent-error/30 bg-agent-error/[0.06] px-3 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-agent-error">
                <TriangleAlert className="h-4 w-4" />
                {recoveryWaits.length === 1
                  ? 'One parallel unit is stuck'
                  : `${recoveryWaits.length} parallel units are stuck`}
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {recoveryWaits.length === 1
                  ? 'It stopped without a question you could answer. '
                  : 'They stopped without a question you could answer. '}
                Repairing keeps the units that already finished, discards the draft pull requests of
                the unfinished ones and restarts them.
                {lanesResuming &&
                  ' Another unit is restarting after an answer; repair is available once it is running again.'}
              </p>
              <TechnicalDetails
                className="mt-2"
                items={[
                  {
                    label: 'Engine state',
                    value: `${recoveryWaits.length} lane${recoveryWaits.length === 1 ? ' is' : 's are'} parked without an answerable question. Merged units are safe; active lanes must be replayed from the section boundary.`,
                  },
                  {
                    label: 'Units',
                    value: Object.entries(laneWaits)
                      .filter(([, wait]) => wait.kind === 'recovery')
                      .map(([slug]) => slug)
                      .join(', '),
                    copy: true,
                  },
                ]}
              />
            </div>
            {canRepair && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={repairing || lanesResuming}
                onClick={() => setConfirmRepair(true)}
              >
                {repairing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )}
                Repair units
              </Button>
            )}
          </div>
        </div>
      )}

      {/* The outcome callout carries the resume while the run is parked; a lane
          question whose callback failed while the intent keeps RUNNING is the
          one case it cannot show, so it gets its own notice here. */}
      {resumeRequired && intent.status !== 'WAITING' && (
        <Alert
          tone="warning"
          title="Your answer was saved but the run did not continue"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={resuming}
              disabled={readOnly || !canResume}
              onClick={() => void handleResume()}
            >
              <Play aria-hidden="true" />
              Resume run
            </Button>
          }
        >
          <AlertDescription>
            Resume re-sends the recorded answer. No decision is asked again.
          </AlertDescription>
        </Alert>
      )}

      {resumeNotice && (
        <Alert
          tone={resumeNotice.kind === 'expired' ? 'danger' : 'warning'}
          icon={resumeNotice.kind === 'expired' ? <XCircle /> : <TriangleAlert />}
          title={resumeNotice.title}
          action={
            <Button type="button" size="sm" variant="ghost" onClick={() => setResumeNotice(null)}>
              Dismiss
            </Button>
          }
        >
          <AlertDescription>{resumeNotice.message}</AlertDescription>
        </Alert>
      )}

      {/* DRAFT never renders here — it redirects to the compose page above. */}
      {reviewGate && reviewGate.status === 'pending' && reviewGate.kind !== 'validation' ? (
        // A question (or approval) gate reached through a /review link: the
        // stage is parked on a question, not on an approval, so it gets the
        // same gate card as the Work page — never the approve form.
        <Card className="border-agent-waiting/30">
          <CardContent className="space-y-3 py-4">
            <div>
              {/* The question text itself belongs to the card below, once. */}
              <h2 className="text-base font-semibold">
                {displayStageName(
                  reviewGate.stageInstanceId
                    ? stageNameOf(reviewGate.stageInstanceId)
                    : reviewGate.humanTaskId,
                )}
                {reviewGate.unitSlug ? ` · ${reviewGate.unitSlug}` : ''} —{' '}
                {(GATE_REVIEW_INTRO[reviewGate.kind] ?? GATE_REVIEW_INTRO.question).noun(
                  gateQuestionCount(reviewGate),
                )}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {(GATE_REVIEW_INTRO[reviewGate.kind] ?? GATE_REVIEW_INTRO.question).needs}
              </p>
            </div>
            <GateCard
              gate={reviewGate}
              projectId={projectId}
              intentId={intentId}
              userName={userName}
              onAnswer={answerGate}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/space/${projectId}/intent/${intentId}`)}
            >
              Back to intent
            </Button>
          </CardContent>
        </Card>
      ) : reviewGate && reviewGate.status === 'pending' ? (
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
        <ErrorState
          size="section"
          title="This review is no longer pending"
          description={
            reviewGate
              ? `It was answered${reviewGate.answeredByName || reviewGate.answeredBy ? ` by ${reviewGate.answeredByName || reviewGate.answeredBy}` : ''}. The intent page shows where the work stands now.`
              : 'It may have been retired by a cancel or rewind, or it belongs to another intent run.'
          }
          secondaryAction={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/space/${projectId}/intent/${intentId}`)}
            >
              Back to intent
            </Button>
          }
        />
      ) : (
        <>
          {/* Pending human gates — tabs: one GateCard at a time */}
          {pendingGates.length > 0 && (
            <div id="pending-human-gates">
              {/* The tabs keep their own selection once mounted; a new key
                  re-seeds it with the gate chosen in the outcome callout. */}
              <PendingQuestionsTabs
                key={focusedGateId ?? 'default'}
                gates={pendingGates}
                activeGateId={focusedGateId ?? intent.pendingHumanTaskId}
                gateContext={(gate) => {
                  // stageNameOf falls back to the raw instance id when the stage
                  // row is unknown — no prefix beats an opaque id on the tab.
                  const resolved = gate.stageInstanceId ? stageNameOf(gate.stageInstanceId) : null;
                  const stagePart =
                    resolved && resolved !== gate.stageInstanceId
                      ? humanizeStageId(resolved)
                      : null;
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
            </div>
          )}

          {/* A stalled run must not look live: the callout above already says
              what is known, so the pulsing progress card stays out. */}
          {pendingGates.length === 0 &&
            !noStageRowsYet &&
            isActive &&
            !fanoutActive &&
            !derived.stalled && <AgentProgressCard />}

          {/* Workspace setup indicator — init-ws creates no stage row, so without
              this the screen looks idle while repos clone + the anchor is created. */}
          {noStageRowsYet && isActive && !derived.stalled && (
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

          <div id="intent-work-products">
            <WorkProductsSection detail={detail} gates={gates} />
          </div>
        </>
      )}

      <AlertDialog
        open={confirmExport}
        onOpenChange={(open) => {
          if (exporting) return;
          setConfirmExport(open);
        }}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocusAfterExport}>
          <AlertDialogHeader>
            <AlertDialogTitle>Continue outside Collaborative AI-DLC?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {intent.status === 'RUNNING'
                ? 'This download uses the latest completed workflow checkpoint and excludes the stage currently in progress. '
                : 'This download creates a point-in-time workspace. '}
              Work completed locally, including decisions, approvals, artifacts, and code changes,
              will not be synchronized back to this intent or included in its traceability history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-export-harness">Agent tool for the workspace</Label>
            <Select
              value={activeExportHarness ?? ''}
              onValueChange={(value) => setSelectedExportHarness(value as NativeExportHarness)}
              disabled={exporting}
            >
              <SelectTrigger id="workspace-export-harness" className="w-full sm:w-64">
                <SelectValue placeholder="Choose an agent tool" />
              </SelectTrigger>
              <SelectContent>
                {EXPORT_HARNESSES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exporting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={exporting}
              onClick={(event) => {
                event.preventDefault();
                void handleExport(activeExportHarness);
              }}
            >
              {exporting ? 'Preparing workspace…' : 'Download workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NativeExportSetupDialog
        exportResult={constructionExport}
        projectName={project?.name}
        onClose={() => setConstructionExport(null)}
      />

      <AlertDialog
        open={confirmRepair}
        onOpenChange={(open) => !repairing && setConfirmRepair(open)}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocusAfterRepair}>
          <AlertDialogHeader>
            <AlertDialogTitle>Repair the stuck units?</AlertDialogTitle>
            <AlertDialogDescription>
              Finished units are kept. The unfinished units stop, their draft pull requests and
              in-progress documents are discarded, and they start again from the beginning of this
              round.
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
              {repairing ? 'Repairing…' : 'Repair units'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <IntentConfigurationDialog
        open={configurationOpen}
        onOpenChange={setConfigurationOpen}
        onOpenReshape={canReshape ? () => setReshapeOpen(true) : undefined}
      />

      {canReshape && (
        <RecomposePanel
          mayControlStage={mayControlStage}
          open={reshapeOpen}
          onOpenChange={setReshapeOpen}
          projectId={projectId}
          intentId={intentId}
          intent={intent}
          stageRows={detail.stages}
          workflowVersion={intent.workflowVersion ?? undefined}
          onRelaunched={reload}
        />
      )}
    </div>
  );
}
