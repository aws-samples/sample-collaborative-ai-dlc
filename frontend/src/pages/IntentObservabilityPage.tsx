import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useIntent } from '@/contexts/IntentContext';
import {
  intentsService,
  type Intent,
  type IntentDetail,
  type IntentGate,
} from '@/services/intents';
import { aidlcReleasesService } from '@/services/aidlcReleases';
import { aggregateMetrics, summarizeCost } from '@/lib/metricAggregation';
import { displayStageName } from '@/lib/displayNames';
import { formatDuration } from '@/components/intent/stageStyle';
import { deriveIntentStatus } from '@/lib/statusModel';
import { UsageMetrics } from '@/components/intent/UsageMetrics';
import { IntentStageList } from '@/components/intent/IntentStageList';
import { IntentOutcomeCallout } from '@/components/intent/IntentOutcomeCallout';
import { IntentPageHeader } from '@/components/intent/IntentPageHeader';
import {
  reshapeDisabledReason,
  resumeOrExplain,
  VIEW_ONLY_REASON,
  type ResumeNotice,
} from '@/lib/intentActions';
import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { IntentActionsMenu } from '@/components/intent/IntentActionsMenu';
import { IntentConfigurationDialog } from '@/components/intent/IntentConfigurationDialog';
import { RecomposePanel } from '@/components/intent/RecomposePanel';
import { useWorkspaceExport } from '@/components/intent/useWorkspaceExport';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { getCachedIntentSummary, useProjectCache } from '@/hooks/useProjectsCache';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { IntentNotFoundState } from '@/components/intent/IntentNotFoundState';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Check, Copy, Milestone } from 'lucide-react';

// Two clamped lines are the summary; the toggle appears only when they clip.
// Without layout (jsdom) the length decides.
const PROMPT_SUMMARY_CHARS = 200;

function usePromptClipped(prompt: string, expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () => {
      if (node.clientHeight === 0) return setClipped(null);
      setClipped(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [prompt, expanded]);
  return {
    ref,
    clipped: clipped ?? (prompt.length > PROMPT_SUMMARY_CHARS || prompt.includes('\n')),
  };
}

// Display-only rewrite of `prompt`: the Overview announces the decision, the
// review screen carries the gate's full text and artifact list.
function summarizeReviewGates(detail: IntentDetail, gates: IntentGate[]): IntentGate[] {
  let changed = false;
  const next = gates.map((gate) => {
    if (gate.kind !== 'validation' || gate.status !== 'pending') return gate;
    const stage = detail.stages.find((s) => s.stageInstanceId === gate.stageInstanceId);
    const artifacts = gate.stageInstanceId
      ? detail.artifacts.filter(
          (a) => a.createdByStageInstanceId === gate.stageInstanceId && !a.supersededAt,
        ).length
      : 0;
    const summary = [
      stage?.stageId ? `Review ${displayStageName(stage.stageId)}` : 'Review required',
      artifacts > 0 ? `${artifacts} artifact${artifacts === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    changed = true;
    return { ...gate, prompt: summary };
  });
  return changed ? next : gates;
}

// Legacy `failureReason` ("stage_failed: <stage>: <code>: <detail>") is the only
// place some runs name the failed stage; `failure.message` alone loses it.
function withStageFailure(detail: IntentDetail): IntentDetail {
  const { failure, failureReason } = detail.intent;
  if (!failureReason?.startsWith('stage_failed: ')) return detail;
  if (failure?.message?.startsWith('stage_failed: ')) return detail;
  return {
    ...detail,
    intent: {
      ...detail.intent,
      failure: { code: failure?.code ?? 'stage_failed', message: failureReason },
    },
  };
}

const TERMINAL: ReadonlySet<Intent['status']> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function InitialPromptCard({
  prompt,
  expanded,
  onToggle,
  copied,
  onCopy,
}: {
  prompt: string;
  expanded: boolean;
  onToggle: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  const { ref, clipped } = usePromptClipped(prompt, expanded);
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
            aria-label={copied ? 'Initial prompt copied' : 'Copy initial prompt'}
            title={copied ? 'Copied' : 'Copy initial prompt'}
            disabled={!prompt}
            onClick={onCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-agent-success-fg" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {prompt ? (
          <>
            <div
              ref={ref}
              className={cn(
                'break-words text-sm leading-6 text-foreground select-text',
                expanded ? 'max-h-72 overflow-y-auto whitespace-pre-wrap' : 'line-clamp-2',
              )}
            >
              {prompt}
            </div>
            {(clipped || expanded) && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-2 h-auto min-h-6 px-0"
                aria-expanded={expanded}
                onClick={onToggle}
              >
                {expanded ? 'Show less' : 'Show full request'}
              </Button>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No initial prompt recorded</span>
        )}
      </CardContent>
    </Card>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton label="Loading intent" className="h-28 rounded-lg" />
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}

// The route element survives a switch to another intent: keyed by intentId, the
// page starts clean, and a pending action or error of the previous intent never
// lands on the next one.
export default function IntentObservabilityPage() {
  const { intentId } = useIntent();
  return <IntentOverview key={intentId} />;
}

function IntentOverview() {
  const {
    projectId,
    intentId,
    detail,
    stageRows,
    gates,
    loading,
    error,
    notFound,
    reload,
    cancelIntent,
    deleteIntent,
    rewindIntent,
    resumeIntent,
    lastActivityAt,
    initializationPhasePaths,
    gateAccess,
    mayControlStage,
  } = useIntent();
  const navigate = useNavigate();
  const [retryingLoad, setRetryingLoad] = useState(false);
  const { project } = useProjectCache(projectId);
  const { readOnly } = useSpacePermissions();

  const canDelete = project?.userRole === 'owner';
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [reshapeOpen, setReshapeOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'restart' | 'resume' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptExpansion, setPromptExpansion] = useState<{
    intentId: string;
    expanded: boolean;
  } | null>(null);

  const spacePath = `/space/${projectId}`;
  const workPath = `/space/${projectId}/intent/${intentId}`;
  const newVersionPath = `/space/${projectId}/intent/new?fromIntent=${encodeURIComponent(intentId)}`;
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

  const workspaceExport = useWorkspaceExport({
    projectId,
    intentId,
    intent: detail?.intent ?? { status: 'CREATED', agentCli: null },
    projectName: project?.name,
    onError: setActionError,
  });

  const retryLoad = async () => {
    setRetryingLoad(true);
    try {
      await reload();
    } finally {
      setRetryingLoad(false);
    }
  };

  useEffect(() => {
    if (!promptCopied) return;
    const timeout = window.setTimeout(() => setPromptCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [promptCopied]);

  const handleCopyPrompt = async () => {
    const prompt = detail?.intent.prompt;
    if (!prompt?.trim()) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
    } catch {
      setActionError('Failed to copy initial prompt');
    }
  };

  const reportFailure = (err: unknown, fallback: string) => {
    setActionError(err instanceof Error ? err.message : fallback);
  };

  const handleCancel = async () => {
    setActionError(null);
    try {
      await cancelIntent();
    } catch (err) {
      reportFailure(err, 'Failed to cancel intent');
      throw err;
    }
  };

  const handleDelete = async () => {
    setActionError(null);
    try {
      await deleteIntent();
      navigate(spacePath);
    } catch (err) {
      reportFailure(err, 'Failed to delete intent');
      throw err;
    }
  };

  const runAction = async (kind: 'restart' | 'resume', action: () => Promise<void>) => {
    setPendingAction(kind);
    setActionError(null);
    setResumeNotice(null);
    try {
      await action();
    } catch (err) {
      reportFailure(err, kind === 'resume' ? 'Failed to resume the run' : 'Failed to restart');
    } finally {
      setPendingAction(null);
    }
  };

  const failedStage = useMemo(
    () =>
      detail?.intent.status === 'FAILED'
        ? (stageRows.find((row) => row.planned && row.state === 'FAILED') ?? null)
        : null,
    [detail?.intent.status, stageRows],
  );

  const calloutDetail = useMemo(() => {
    if (!detail) return null;
    const shown = summarizeReviewGates(detail, gates);
    const base = shown === detail.gates ? detail : { ...detail, gates: shown };
    return detail.intent.status === 'FAILED' ? withStageFailure(base) : base;
  }, [detail, gates]);

  const { totals, cost, stageTokens } = useMemo(() => {
    if (!detail || detail.metrics.length === 0) {
      return { totals: {}, cost: null, stageTokens: null };
    }
    const perStage = aggregateMetrics(detail.metrics.filter((m) => m.stageInstanceId));
    const attributed = ['tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheWrite']
      .map((key) => perStage[key])
      .filter((value): value is number => typeof value === 'number');
    return {
      totals: aggregateMetrics(detail.metrics),
      cost: summarizeCost(detail.metrics),
      stageTokens: attributed.length ? attributed.reduce((sum, v) => sum + v, 0) : null,
    };
  }, [detail]);

  const wallTime = useMemo(() => {
    if (!detail) return null;
    const started = detail.intent.orchestratorStartedAt ?? detail.stages[0]?.startedAt ?? null;
    const ended = TERMINAL.has(detail.intent.status) ? detail.intent.completedAt : null;
    return formatDuration(started, ended);
  }, [detail]);

  const stagesRun = useMemo(() => {
    // A skipped stage did not run: it counts in neither figure.
    const planned = stageRows.filter(
      (row) =>
        row.planned && row.state !== 'SKIPPED' && !initializationPhasePaths.has(row.phase ?? ''),
    );
    if (planned.length === 0) return null;
    const done = planned.filter((row) => row.state === 'SUCCEEDED');
    return { done: done.length, total: planned.length };
  }, [initializationPhasePaths, stageRows]);

  if (loading && !detail) {
    const cached = getCachedIntentSummary(projectId, intentId);
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col gap-6">
          {cached ? (
            <IntentPageHeader intent={cached} />
          ) : (
            <Skeleton label="Loading intent" className="h-9 w-72 rounded-md" />
          )}
          <BodySkeleton />
        </div>
      </div>
    );
  }

  if (notFound && !detail) {
    return <IntentNotFoundState spacePath={spacePath} />;
  }

  const backToSpace = (
    <Button asChild variant="outline" size="sm">
      <Link to={spacePath}>Back to space</Link>
    </Button>
  );

  if (error && !detail) {
    return (
      <ErrorState
        headingLevel={1}
        className="mx-auto mt-8 w-full max-w-lg"
        title="Couldn't load this intent"
        description="The intent could not be retrieved. Check your connection and try again."
        onRetry={() => void retryLoad()}
        retrying={retryingLoad}
        secondaryAction={backToSpace}
      />
    );
  }

  if (!detail || !calloutDetail) {
    return (
      <EmptyState
        headingLevel={1}
        className="mx-auto mt-8 w-full max-w-lg"
        title="Intent not found"
        description="This intent may have been removed, or you may no longer have access to it."
        action={backToSpace}
      />
    );
  }

  const intent = detail.intent;
  const prompt = intent.prompt?.trim() ?? '';
  const promptExpanded = promptExpansion?.intentId === intentId && promptExpansion.expanded;
  // "What waits for me?" beats "what did I ask?" while someone has to act or
  // look: the decision callout leads and the prompt follows, summarized.
  const derived = deriveIntentStatus(intent, { lastActivityAt, gates });
  const answerFirst = intent.status === 'WAITING' || intent.status === 'FAILED' || derived.stalled;
  const reshapeBlockedReason = readOnly ? VIEW_ONLY_REASON : reshapeDisabledReason(intent);
  const canReshape = reshapeBlockedReason === undefined;
  const promptCard = (
    <InitialPromptCard
      prompt={prompt}
      expanded={promptExpanded}
      onToggle={() => setPromptExpansion({ intentId, expanded: !promptExpanded })}
      copied={promptCopied}
      onCopy={() => void handleCopyPrompt()}
    />
  );

  // The same checks as the Work page's recovery and resume controls (viewer,
  // stage permissions): disable what the backend would refuse.
  const recoveryStageId = failedStage?.stageId ?? intent.currentStage;
  const mayRecover = !recoveryStageId || mayControlStage(recoveryStageId);
  const canResume =
    canDelete || gates.some((gate) => gate.resumeAvailable && gateAccess(gate).access?.decide);
  const outcomeActions = {
    restartFromStage: failedStage
      ? {
          stageId: failedStage.stageId,
          pending: pendingAction === 'restart',
          disabled: readOnly || pendingAction !== null || !mayRecover,
          onClick: () => void runAction('restart', () => rewindIntent(failedStage.stageId)),
        }
      : undefined,
    startAgain:
      intent.status === 'FAILED' && !failedStage
        ? {
            pending: pendingAction === 'restart',
            disabled: readOnly || pendingAction !== null || !mayRecover,
            onClick: () =>
              void runAction('restart', async () => {
                await intentsService.start(projectId, intentId);
                await reload();
              }),
          }
        : undefined,
    resume: {
      pending: pendingAction === 'resume',
      disabled: readOnly || pendingAction !== null || !canResume,
      onClick: () =>
        void runAction('resume', async () =>
          setResumeNotice(await resumeOrExplain(resumeIntent, reload)),
        ),
    },
    checkDelivery: { onClick: () => navigate(workPath) },
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-6">
        {error && (
          <Alert
            tone="danger"
            live
            title="Couldn't refresh this intent"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void retryLoad()}
                loading={retryingLoad}
              >
                Retry
              </Button>
            }
          >
            <AlertDescription>The information shown may be out of date.</AlertDescription>
          </Alert>
        )}

        <IntentPageHeader
          intent={intent}
          lastActivityAt={lastActivityAt}
          gates={gates}
          stages={detail.stages}
          actions={
            // Same arrangement and items as the Work header.
            <>
              <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
              <IntentActionsMenu
                intent={intent}
                onConfiguration={() => setConfigurationOpen(true)}
                onReshape={() => setReshapeOpen(true)}
                reshapeDisabledReason={reshapeBlockedReason}
                onExport={workspaceExport.open}
                exportDisabledReason={workspaceExport.disabledReason}
                onAudit={() => navigate(`${workPath}/audit`)}
                onCancel={readOnly ? undefined : handleCancel}
                onDelete={canDelete ? handleDelete : undefined}
                extraItems={
                  // Same opt-in item as the Work header: opens the create page
                  // prefilled from this intent; nothing is migrated.
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

        {actionError && <Alert tone="danger" live title={actionError} />}
        {resumeNotice && (
          <Alert
            tone={resumeNotice.kind === 'expired' ? 'danger' : 'warning'}
            live
            title={resumeNotice.title}
          >
            <AlertDescription>{resumeNotice.message}</AlertDescription>
          </Alert>
        )}

        {answerFirst ? null : promptCard}

        <IntentOutcomeCallout
          detail={calloutDetail}
          lastActivityAt={lastActivityAt}
          links={{
            details: workPath,
            compose: `${workPath}/compose`,
            // The Work page's review route shows this very gate, whatever its kind.
            gate: (gate) => `${workPath}/review/${gate.humanTaskId}`,
          }}
          // GateCard's rule: a viewer or a member without the decision cannot answer.
          canAnswer={(gate) => !readOnly && gateAccess(gate).access?.decide === true}
          actions={outcomeActions}
        />

        {answerFirst ? promptCard : null}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Execution progress</CardTitle>
          </CardHeader>
          <CardContent>
            <IntentStageList />
          </CardContent>
        </Card>

        {detail.metrics.length > 0 && (
          <Card className="w-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Run cost and usage</CardTitle>
            </CardHeader>
            <CardContent className="w-full">
              <UsageMetrics
                key={intentId}
                metrics={totals}
                cost={cost}
                wallTime={wallTime}
                stagesRun={stagesRun}
                stageTokens={stageTokens}
                compact
              />
            </CardContent>
          </Card>
        )}

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
        {workspaceExport.dialogs}
      </div>
    </div>
  );
}
