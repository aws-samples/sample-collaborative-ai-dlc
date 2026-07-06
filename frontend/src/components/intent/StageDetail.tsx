import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import { stageDurations, useTick } from '@/components/intent/stageStyle';
import {
  SensorChips,
  latestSensorRuns,
  sensorNeedsAttention,
  summarizeSensorDetail,
} from '@/components/intent/SensorChips';
import { FileText, Loader2, RotateCcw, ScrollText } from 'lucide-react';
import { aggregateMetrics, summarizeCost } from '@/lib/metricAggregation';
import { UsageMetrics } from '@/components/intent/UsageMetrics';

// Steering (docs/v2-steering.md): the run states a rewind may start from. A
// RUNNING stage cannot be interrupted — the API 409s; the button hides.
const REWINDABLE_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'WAITING', 'CANCELLED']);

// Drill-down for one stage, shared by the list (inline expansion) and the
// graph (below-canvas panel): timing, dependencies (derived from the compiled
// edges — the DTO has no dependencyStageIds), sensors, metrics, artifacts
// produced and the jump to its streamed output in the sidebar.
export function StageDetail({ row }: { row: IntentStageRow }) {
  const {
    detail,
    stageEdges,
    gates,
    sensorsByStage,
    artifactsByStage,
    outputBuffers,
    setSelectedStageId,
    focusOutput,
    rewindIntent,
  } = useIntent();
  useTick(row.state === 'RUNNING' || row.state === 'WAITING_FOR_HUMAN');

  // Rewind form state: guidance is OPTIONAL — with it this is a corrective
  // rewind (steering), without it a plain re-run of this stage + everything
  // after it.
  const [rewindOpen, setRewindOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const canRewind =
    row.planned &&
    REWINDABLE_STATUSES.has(detail?.intent.status ?? '') &&
    row.state !== 'PENDING' &&
    row.state !== 'SKIPPED';
  // One-click retry for a FAILED stage: same reset + relaunch as a rewind,
  // no guidance — the fastest path out of a transient failure.
  const canRetry = canRewind && row.state === 'FAILED';
  const [retrying, setRetrying] = useState(false);

  const handleRewind = async () => {
    setRewinding(true);
    setRewindError(null);
    try {
      await rewindIntent(row.stageId, guidance.trim() || undefined);
      setRewindOpen(false);
      setGuidance('');
    } catch (err) {
      setRewindError(err instanceof Error ? err.message : 'Failed to rewind');
    } finally {
      setRewinding(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    setRewindError(null);
    try {
      await rewindIntent(row.stageId);
    } catch (err) {
      setRewindError(err instanceof Error ? err.message : 'Failed to retry');
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

  const instanceId = row.stageInstanceId;
  const sensors = instanceId ? (sensorsByStage.get(instanceId) ?? []) : [];
  // Non-PASS latest verdicts with a terse explanation — surfaced inline (not
  // just in the chip tooltip) so an advisory miss like an intent-statement
  // "missing" is visible without hovering.
  const sensorFlags = latestSensorRuns(sensors)
    .filter(sensorNeedsAttention)
    .map((r) => ({ run: r, explain: summarizeSensorDetail(r.detail) }));
  const artifacts = instanceId ? (artifactsByStage.get(instanceId) ?? []) : [];
  const stageGates = instanceId ? gates.filter((g) => g.stageInstanceId === instanceId) : [];
  const hasOutput = !!instanceId && !!outputBuffers.get(instanceId)?.trim();

  // Aggregate this stage's samples with correct per-key semantics: tokens sum,
  // contextWindowPct is a gauge (peak, not a sum) — see metricAggregation. Cost
  // sums across the stage's samples via summarizeCost (the shared verdict:
  // unavailable if a spend lacked a price, "~" when Kiro credit-estimated).
  const { stageMetrics, stageCost } = useMemo(() => {
    if (!instanceId) return { stageMetrics: {} as Record<string, number>, stageCost: null };
    const samples = (detail?.metrics ?? []).filter((m) => m.stageInstanceId === instanceId);
    return { stageMetrics: aggregateMetrics(samples), stageCost: summarizeCost(samples) };
  }, [detail, instanceId]);

  // Total wall-clock (incl. human waits — startedAt survives park/resume) plus
  // the agent-active/waiting breakdown when the stage ever waited on a human.
  const durations = stageDurations(row);

  return (
    <div className="space-y-3 rounded-b-md border border-t-0 bg-muted/20 px-3 py-3 text-sm">
      {/* Meta line */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {durations && (
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
                (<span className="font-medium text-foreground">{durations.active}</span> active,{' '}
                <span className="font-medium text-foreground">{durations.waiting}</span> waiting on
                answers)
              </>
            )}
          </span>
        )}
        {row.attempt > 1 && <span>Attempt {row.attempt}</span>}
        {row.cli && (
          <Badge variant="secondary" className="px-1 py-0 text-[9px]">
            {row.cli}
          </Badge>
        )}
        {!row.planned && <span className="italic">not in the compiled plan</span>}
      </div>

      {row.runtimeError && (
        <p className="break-words rounded border border-agent-error/30 bg-agent-error/10 px-2 py-1.5 font-mono text-[11px] text-agent-error">
          {row.runtimeError}
        </p>
      )}

      {/* Wiring */}
      {(dependsOn.length > 0 || produces.length > 0) && (
        <div className="space-y-1.5">
          {dependsOn.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Depends on</span>
              {dependsOn.map((e, i) => (
                <button
                  key={`${e.from}-${i}`}
                  type="button"
                  onClick={() => setSelectedStageId(e.from)}
                  title={e.kind === 'data' ? `reads ${e.artifact}` : e.kind}
                  className={cn(
                    'rounded border px-1.5 py-0.5 font-medium hover:bg-muted',
                    e.kind !== 'data' && 'border-dashed',
                  )}
                >
                  {e.from}
                  {e.kind === 'data' && e.artifact && (
                    <span className="ml-1 font-normal text-muted-foreground">{e.artifact}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {produces.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Produces</span>
              {produces.map((a) => (
                <span key={a} className="rounded border px-1.5 py-0.5">
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sensor runs (full history, incl. superseded attempts) */}
      {sensors.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Sensors</p>
          <SensorChips runs={sensors} />
          {/* Explain each non-PASS verdict inline. Advisory misses (INCONCLUSIVE)
              don't hold the stage but still signal a gap worth seeing. */}
          {sensorFlags.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {sensorFlags.map(({ run, explain }) => (
                <li
                  key={run.sensorRunId}
                  className={cn(
                    'text-[11px]',
                    run.held ? 'text-agent-error' : 'text-muted-foreground',
                  )}
                >
                  <span className="font-medium">{run.sensorId}</span>{' '}
                  <span className="uppercase">{run.result}</span>
                  {run.held && <span className="font-semibold"> · blocking</span>}
                  {explain && <span> — {explain}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Per-stage metrics */}
      {Object.keys(stageMetrics).length > 0 && (
        <UsageMetrics metrics={stageMetrics} cost={stageCost} />
      )}

      {/* Gates raised by this stage */}
      {stageGates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-muted-foreground">Gates</span>
          {stageGates.map((g) => (
            <Badge
              key={g.humanTaskId}
              variant="outline"
              className={cn(
                'px-1 py-0 text-[9px]',
                g.status === 'pending' &&
                  'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
              )}
            >
              {g.kind} · {g.status}
            </Badge>
          ))}
        </div>
      )}

      {/* Jumps */}
      <div className="flex flex-wrap items-center gap-2">
        {hasOutput && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => focusOutput(instanceId)}
          >
            <ScrollText className="h-3 w-3" />
            View output
          </Button>
        )}
        {artifacts.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() =>
              document
                .getElementById(`artifact-${a.id}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            <FileText className="h-3 w-3" />
            {a.title || a.artifactType || a.id}
          </Button>
        ))}
        {canRetry && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={retrying || rewinding}
            onClick={handleRetry}
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            {retrying ? 'Retrying…' : 'Retry stage'}
          </Button>
        )}
        {canRewind && !rewindOpen && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={retrying}
            onClick={() => setRewindOpen(true)}
          >
            <RotateCcw className="h-3 w-3" />
            Restart from this stage
          </Button>
        )}
      </div>

      {/* Retry error, when the inline retry (no form) failed */}
      {canRetry && !rewindOpen && rewindError && (
        <p className="text-[11px] text-agent-error">{rewindError}</p>
      )}

      {/* Rewind (steering): re-run this stage + everything after it. Optional
          corrective guidance; prior artifacts are kept as superseded lineage;
          the agent reverts/redoes conflicting commits on the branch. */}
      {canRewind && rewindOpen && (
        <div className="space-y-2 rounded-md border border-agent-waiting/40 bg-agent-waiting/[0.04] p-2">
          <p className="text-[11px] font-medium">
            Restart from <span className="font-mono">{row.stageId}</span> — this stage and every
            stage after it will re-run. Optionally tell the agent what went wrong and what to do
            instead:
          </p>
          <Textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. The design took a REST approach but we need event-driven messaging. Redo the design around the existing SQS queues and revert the REST scaffolding commits."
            rows={3}
            className="text-xs"
          />
          {rewindError && <p className="text-[11px] text-agent-error">{rewindError}</p>}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={rewinding}
              onClick={handleRewind}
            >
              {rewinding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              {rewinding ? 'Restarting…' : guidance.trim() ? 'Rewind & restart' : 'Restart'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={rewinding}
              onClick={() => {
                setRewindOpen(false);
                setRewindError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
