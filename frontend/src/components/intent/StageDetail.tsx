import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { StatusPill } from '@/components/ui/status-pill';
import { TechnicalDetails } from '@/components/ui/technical-details';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useIntent, stageRowKey, type IntentStageRow } from '@/contexts/IntentContext';
import { stageDurations, useTick } from '@/components/intent/stageStyle';
import {
  SensorChips,
  latestSensorRuns,
  sensorNeedsAttention,
  summarizeSensorDetail,
} from '@/components/intent/SensorChips';
import { SensorDiagnostics } from '@/components/intent/SensorDiagnostics';
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Loader2,
  RotateCcw,
  ScrollText,
} from 'lucide-react';
import { aggregateMetrics, summarizeCost, type CostSummary } from '@/lib/metricAggregation';
import { displayCli, displayStageName, humanizeSlug, stripCommonSuffix } from '@/lib/displayNames';
import { StageUsage } from '@/components/intent/UsageMetrics';
import { useReturnFocus } from '@/components/intent/useReturnFocus';
import { deriveSensorStatus, getStatus } from '@/lib/statusModel';
import { describeFailure } from '@/lib/failureReasons';
import type { IntentArtifact, IntentMetric } from '@/services/intents';

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const PRIMARY_ARTIFACT_COUNT = 6;

// Steering (docs/v2-steering.md): the run states a rewind may start from. A
// RUNNING stage cannot be interrupted — the API 409s; the button hides.
const REWINDABLE_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'WAITING', 'CANCELLED']);

export interface StageExecution {
  runtimeSamples: IntentMetric[];
  stageMetrics: Record<string, number>;
  stageCost: CostSummary | null;
  usedModels: string[];
  artifacts: IntentArtifact[];
  currentArtifacts: IntentArtifact[];
  supersededArtifacts: IntentArtifact[];
}

// What one stage instance recorded: its metric samples (tokens sum, gauges
// peak — see metricAggregation), the cost verdict, the models that actually
// ran (falling back to the planned one) and the documents it produced.
export function useStageExecution(row: IntentStageRow): StageExecution {
  const { detail, artifactsByStage } = useIntent();
  const instanceId = row.stageInstanceId;
  const runtimeSamples = useMemo(
    () =>
      instanceId
        ? (detail?.metrics ?? []).filter((sample) => sample.stageInstanceId === instanceId)
        : [],
    [detail?.metrics, instanceId],
  );
  const { stageMetrics, stageCost } = useMemo(
    () => ({
      stageMetrics: aggregateMetrics(runtimeSamples),
      stageCost: summarizeCost(runtimeSamples),
    }),
    [runtimeSamples],
  );
  const usedModels = useMemo(() => {
    const sampled = [
      ...new Set(
        runtimeSamples
          .map((sample) => sample.model ?? sample.cost?.model)
          .filter((model): model is string => !!model),
      ),
    ];
    return sampled.length > 0 ? sampled : row.resolvedModel ? [row.resolvedModel] : [];
  }, [row.resolvedModel, runtimeSamples]);
  const artifacts = useMemo(
    () => (instanceId ? (artifactsByStage.get(instanceId) ?? []) : []),
    [artifactsByStage, instanceId],
  );
  return {
    runtimeSamples,
    stageMetrics,
    stageCost,
    usedModels,
    artifacts,
    currentArtifacts: artifacts.filter((artifact) => !artifact.supersededAt),
    supersededArtifacts: artifacts.filter((artifact) => artifact.supersededAt),
  };
}

export function stageTokenTotal(metrics: Record<string, number>): number | null {
  const parts = [
    metrics.tokensInput,
    metrics.tokensOutput,
    metrics.tokensCacheRead,
    metrics.tokensCacheWrite,
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return parts.length ? parts.reduce((sum, n) => sum + n, 0) : null;
}

function artifactLabel(artifact: IntentArtifact): string {
  return artifact.title || humanizeSlug(artifact.artifactType ?? '') || artifact.id;
}

function DocumentList({
  artifacts,
  labels,
  onOpen,
  superseded = false,
}: {
  artifacts: IntentArtifact[];
  labels: string[];
  onOpen: (id: string) => void;
  superseded?: boolean;
}) {
  return (
    <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {artifacts.map((artifact, index) => (
        <li key={artifact.id} className="min-w-0">
          <button
            type="button"
            onClick={() => onOpen(artifact.id)}
            className={cn(
              'flex min-h-8 w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-accent',
              superseded
                ? 'border-dashed bg-muted/30 text-muted-foreground'
                : 'bg-background/70 font-medium',
            )}
          >
            <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{labels[index]}</span>
            {superseded && (
              <span className="shrink-0 text-2xs font-normal text-muted-foreground">
                superseded
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RestartDialog({
  row,
  open,
  onOpenChange,
}: {
  row: IntentStageRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rewindIntent } = useIntent();
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const returnFocus = useReturnFocus(open);
  const [error, setError] = useState<string | null>(null);
  const stageName = displayStageName(row.stageId);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setGuidance('');
      setError(null);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await rewindIntent(row.stageId, guidance.trim() || undefined);
      setGuidance('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The restart was refused.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart from {stageName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {stageName} and every stage after it will run again. Documents those stages produced are
            kept as history and replaced by the new run.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`restart-guidance-${row.stageId}`} className="text-xs">
            What should change this time? (optional)
          </Label>
          <Textarea
            id={`restart-guidance-${row.stageId}`}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. The design took a REST approach but we need event-driven messaging. Redo it around the existing SQS queues."
            rows={3}
            className="text-sm"
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            Without a note, the stage simply runs again with the same inputs.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs text-agent-error-fg">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep current run</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Restarting…
              </span>
            ) : (
              'Restart'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Drill-down for one stage, shared by the list (inline expansion) and the
// graph (below-canvas panel): timing, recorded documents, execution usage,
// checks needing attention, gates, actions (output, retry, restart) and — one
// action away — runtime, planned wiring and the full check history.
export function StageDetail({
  row,
  durationInHeading = false,
}: {
  row: IntentStageRow;
  durationInHeading?: boolean;
}) {
  const {
    detail,
    stageEdges,
    stageRows,
    gates,
    sensorsByStage,
    outputBuffers,
    setSelectedStageId,
    focusOutput,
    openArtifactPreview,
    rewindIntent,
    mayControlStage,
  } = useIntent();
  useTick(row.state === 'RUNNING' || row.state === 'WAITING_FOR_HUMAN');

  const [restartOpen, setRestartOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expandedArtifactInstance, setExpandedArtifactInstance] = useState<string | null>(null);
  const canRewind =
    mayControlStage(row.stageId) &&
    row.planned &&
    REWINDABLE_STATUSES.has(detail?.intent.status ?? '') &&
    row.state !== 'PENDING' &&
    row.state !== 'SKIPPED';
  // One-click retry for a FAILED stage: same reset + relaunch as a rewind,
  // no guidance — the fastest path out of a transient failure.
  const canRetry = canRewind && row.state === 'FAILED';

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await rewindIntent(row.stageId);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Failed to retry');
    } finally {
      setRetrying(false);
    }
  };

  const dependsOn = useMemo(
    () => stageEdges.filter((e) => e.to === row.stageId),
    [stageEdges, row.stageId],
  );
  const produces = useMemo(
    () => [
      ...new Set(
        stageEdges
          .filter((e) => e.from === row.stageId && e.kind === 'data' && e.artifact)
          .map((e) => e.artifact as string),
      ),
    ],
    [stageEdges, row.stageId],
  );
  const groupedDeps = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of dependsOn) {
      if (!map.has(e.from)) map.set(e.from, []);
      if (e.kind === 'data' && e.artifact) map.get(e.from)!.push(e.artifact);
    }
    return map;
  }, [dependsOn]);

  const instanceId = row.stageInstanceId;
  const sensors = instanceId ? (sensorsByStage.get(instanceId) ?? []) : [];
  // Non-PASS latest verdicts with a terse explanation — surfaced inline (not
  // just in the chip tooltip) so an advisory miss like an intent-statement
  // "missing" is visible without hovering.
  const sensorFlags = latestSensorRuns(sensors)
    .filter(sensorNeedsAttention)
    .map((r) => ({ run: r, explain: summarizeSensorDetail(r.detail, r.result) }));
  const {
    runtimeSamples,
    stageMetrics,
    stageCost,
    usedModels,
    currentArtifacts,
    supersededArtifacts,
  } = useStageExecution(row);
  const currentLabels = useMemo(
    () => stripCommonSuffix(currentArtifacts.map(artifactLabel)),
    [currentArtifacts],
  );
  const commonSuffixNote = useMemo(() => {
    const raw = currentArtifacts.map(artifactLabel);
    const stripped = raw.findIndex((label, index) => label !== currentLabels[index]);
    if (stripped < 0) return null;
    return raw[stripped].slice(currentLabels[stripped].length).replace(/^\s*[—–:-]\s*/, '');
  }, [currentArtifacts, currentLabels]);
  const artifactsExpanded = expandedArtifactInstance === instanceId;
  const visibleCount = artifactsExpanded
    ? currentArtifacts.length
    : Math.min(currentArtifacts.length, PRIMARY_ARTIFACT_COUNT);
  const hiddenArtifactCount = Math.max(0, currentArtifacts.length - PRIMARY_ARTIFACT_COUNT);
  const stageGates = instanceId ? gates.filter((g) => g.stageInstanceId === instanceId) : [];
  const hasOutput = !!instanceId && !!outputBuffers.get(instanceId)?.trim();
  const durations = stageDurations(row);
  const hasDiagnostics =
    groupedDeps.size > 0 ||
    produces.length > 0 ||
    sensors.length > 0 ||
    !!row.cli ||
    supersededArtifacts.length > 0;
  const diagnosticsSummary = [
    row.cli ? 'Runtime' : null,
    groupedDeps.size > 0 ? plural(groupedDeps.size, 'planned input') : null,
    produces.length > 0 ? plural(produces.length, 'output') : null,
    sensors.length > 0 ? plural(sensors.length, 'check run') : null,
    supersededArtifacts.length > 0 ? plural(supersededArtifacts.length, 'earlier version') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const failure = row.runtimeError ? describeFailure(undefined, row.runtimeError) : null;
  const attemptRan = row.attempt > 1 && (row.startedAt !== null || row.state !== 'PENDING');

  return (
    <div className="space-y-3 rounded-b-md border border-t-0 bg-muted/20 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {durations && (!durationInHeading || durations.waiting) && (
          <span>
            {row.state === 'RUNNING'
              ? 'Running for '
              : row.state === 'WAITING_FOR_HUMAN'
                ? 'Open for '
                : 'Took '}
            <span className="font-medium text-foreground">{durations.total}</span>
            {durations.waiting && (
              <>
                {' '}
                (<span className="font-medium text-foreground">
                  {durations.active}
                </span> active,{' '}
                <span className="font-medium text-foreground">{durations.waiting}</span> waiting on
                answers)
              </>
            )}
          </span>
        )}
        {attemptRan && <span>Attempt {row.attempt}</span>}
        {!row.planned && <span className="italic">not in the compiled plan</span>}
        {stageGates.map((g) => (
          <span key={g.humanTaskId} className="inline-flex items-center gap-1.5">
            {humanizeSlug(g.kind)}
            <StatusPill kind="gate" status={g.status} />
          </span>
        ))}
      </div>

      {failure && (
        <div className="space-y-1 rounded border border-agent-error/30 bg-agent-error/10 px-2.5 py-2 text-xs">
          <p className="font-medium text-agent-error-fg">{failure.sentence}</p>
          <TechnicalDetails
            items={[
              { label: 'Error', value: failure.technical, copy: true },
              ...(failure.code ? [{ label: 'Code', value: failure.code }] : []),
            ]}
          />
        </div>
      )}

      {currentArtifacts.length > 0 && (
        <section aria-label="Recorded documents" className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Recorded documents
            {commonSuffixNote && (
              <span className="font-normal"> · all about {commonSuffixNote}</span>
            )}
          </p>
          <DocumentList
            artifacts={currentArtifacts.slice(0, visibleCount)}
            labels={currentLabels.slice(0, visibleCount)}
            onOpen={openArtifactPreview}
          />
          {hiddenArtifactCount > 0 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              aria-expanded={artifactsExpanded}
              onClick={() => setExpandedArtifactInstance(artifactsExpanded ? null : instanceId)}
            >
              {artifactsExpanded
                ? 'Show fewer documents'
                : `Show ${hiddenArtifactCount} more ${hiddenArtifactCount === 1 ? 'document' : 'documents'}`}
            </Button>
          )}
        </section>
      )}

      {(runtimeSamples.length > 0 || usedModels.length > 0) && (
        <section aria-label="Recorded execution" className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Recorded execution</p>
          <StageUsage models={usedModels} metrics={stageMetrics} cost={stageCost} />
        </section>
      )}

      {sensorFlags.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Checks needing attention</p>
          <ul className="space-y-1 pt-0.5">
            {sensorFlags.map(({ run, explain }) => {
              const entry = getStatus('sensor', deriveSensorStatus(run));
              return (
                <li
                  key={run.sensorRunId}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                >
                  <span className="font-medium">{humanizeSlug(run.sensorId)}</span>
                  <StatusPill kind="sensor" status={deriveSensorStatus(run)} hint />
                  {explain ? (
                    <span className="text-muted-foreground">{explain}</span>
                  ) : (
                    <span className="text-muted-foreground">{entry.help}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(hasOutput || canRetry || canRewind) && (
        <div className="flex flex-wrap items-center gap-2">
          {hasOutput && (
            <Button size="xs" variant="outline" onClick={() => focusOutput(instanceId)}>
              <ScrollText aria-hidden="true" />
              View output
            </Button>
          )}
          {canRetry && (
            <Button
              size="xs"
              variant="outline"
              disabled={retrying}
              loading={retrying}
              onClick={handleRetry}
            >
              {!retrying && <RotateCcw aria-hidden="true" />}
              {retrying ? 'Retrying…' : 'Retry stage'}
            </Button>
          )}
          {canRewind && (
            <Button
              size="xs"
              variant={canRetry ? 'ghost' : 'outline'}
              disabled={retrying}
              onClick={() => setRestartOpen(true)}
            >
              <RotateCcw aria-hidden="true" />
              Restart from this stage
            </Button>
          )}
        </div>
      )}

      {retryError && (
        <p role="alert" className="text-xs text-agent-error-fg">
          {retryError}
        </p>
      )}

      {canRewind && <RestartDialog row={row} open={restartOpen} onOpenChange={setRestartOpen} />}

      {hasDiagnostics && (
        <Disclosure
          title="Diagnostics"
          summary={<span className="hidden sm:inline">{diagnosticsSummary}</span>}
          variant="row"
          className="rounded-md border"
          contentClassName="space-y-3"
        >
          {row.cli && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Runtime</p>
              <p className="break-words text-xs">{displayCli(row.cli)}</p>
            </div>
          )}

          {(groupedDeps.size > 0 || produces.length > 0) && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {groupedDeps.size > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <ArrowDownLeft aria-hidden="true" className="h-3 w-3" />
                    Planned inputs
                  </div>
                  <ul className="space-y-1.5">
                    {[...groupedDeps.entries()].map(([stageFrom, artifactNames]) => (
                      <li key={stageFrom} className="text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            const matchingRow = stageRows.find((r) => r.stageId === stageFrom);
                            setSelectedStageId(matchingRow ? stageRowKey(matchingRow) : stageFrom);
                          }}
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {displayStageName(stageFrom)}
                        </button>
                        {artifactNames.length > 0 && (
                          <span className="text-muted-foreground">
                            {' — '}
                            {artifactNames.map(humanizeSlug).join(', ')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {produces.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
                    Planned outputs
                  </div>
                  <ul className="space-y-1">
                    {produces.map((artifactName) => (
                      <li key={artifactName} className="text-xs text-muted-foreground">
                        {humanizeSlug(artifactName)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {sensors.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Check history · recorded sensor runs
              </p>
              <SensorChips runs={sensors} />
              {sensors.map((run) => (
                <SensorDiagnostics
                  key={run.sensorRunId}
                  detail={run.detail}
                  sensorId={run.sensorId}
                />
              ))}
            </div>
          )}

          {supersededArtifacts.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Superseded document history
              </p>
              <DocumentList
                artifacts={supersededArtifacts}
                labels={stripCommonSuffix(supersededArtifacts.map(artifactLabel))}
                onOpen={openArtifactPreview}
                superseded
              />
            </div>
          )}
        </Disclosure>
      )}
    </div>
  );
}
