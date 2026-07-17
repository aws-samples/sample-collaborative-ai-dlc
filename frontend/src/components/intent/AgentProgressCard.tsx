import { useEffect } from 'react';
import { INTENT_OUTPUT_KEY, useIntent } from '@/contexts/IntentContext';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import { WaitingCard } from '@/components/intent/WaitingCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// Live progress card — calm "agent working" presence while running with no
// pending questions. Replaces itself when questions arrive (mutually exclusive).
// ---------------------------------------------------------------------------

export function AgentProgressCard() {
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
