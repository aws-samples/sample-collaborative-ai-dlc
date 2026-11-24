import { IntentProgressCard } from './AgentProgressCard';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { formatDuration } from './stageStyle';
import type { useNativeReply } from './NativeInteractionPanel';
import type { useNativeActivity } from '@/contexts/adapters/nativeActivity';
import type { NativeExecution } from '@/services/nativeIntents';
import { NativeTurnObservations } from './NativeTurnObservations';

type Reply = ReturnType<typeof useNativeReply>;

// Receipts establish acceptance/delivery. Execution establishes whether work
// can continue. Activity is only an observation; it never admits a question,
// proves approval/completion, or changes which actions are enabled.
function replyStatus(execution: NativeExecution, reply: Reply): string {
  if (execution.recovery?.reason === 'DELIVERY_UNCERTAIN')
    return 'Delivery is uncertain. The command may have executed. Inspect work before taking further action.';
  if (['RECOVERY_REQUIRED', 'RECOVERING'].includes(execution.status))
    return reply.receipt
      ? 'The accepted reply remains in history. Fresh-session recovery will not send it again.'
      : 'Replying is paused while this session needs recovery.';
  if (['CANCELLED', 'STOPPED', 'FAILED'].includes(execution.status))
    return reply.receipt
      ? 'Reply accepted. Execution is no longer continuing.'
      : 'Execution is no longer continuing.';
  if (execution.status === 'CANCEL_REQUESTED')
    return reply.receipt ? 'Reply accepted. Cancellation requested.' : 'Cancellation requested.';
  if (reply.receipt) {
    switch (reply.receipt.deliveryStatus) {
      case 'pending':
        return 'Reply accepted. Delivery pending.';
      case 'delivered':
        return 'Reply delivered. Waiting for the next AI-DLC response.';
      case 'unknown':
        return 'Reply accepted. Historical delivery confirmation is unavailable.';
    }
  }
  if (reply.state === 'sending') return 'Sending reply…';
  if (reply.state === 'uncertain') return 'Reply acceptance could not be confirmed.';
  if (reply.state === 'conflict')
    return 'This interaction changed. Refresh status to see the current reply.';
  if (reply.awaitingReply) return 'A member reply is needed.';
  if (execution.status === 'AWAITING_USER')
    return reply.interactionReady
      ? 'Replying is unavailable for this turn.'
      : 'Loading the published question…';
  if (execution.status === 'RUNNING')
    return 'Agent session is running. Waiting for the next published response.';
  if (execution.status === 'WAITING_FOR_INPUT')
    return 'The workflow is waiting for input. Review the published files.';
  return 'Waiting for the agent session.';
}

const activityLabels: Record<string, string> = {
  tool: 'Tool activity',
  edit: 'File editing activity',
  batch_read: 'File reading activity',
  artifact: 'Artifact activity',
  question: 'Question activity',
  message: 'Agent output',
  system: 'Runtime update',
};

export function NativeExecutionProgress({
  execution,
  reply,
  activity,
  onViewActivity,
}: {
  execution: NativeExecution;
  reply: Reply;
  activity?: ReturnType<typeof useNativeActivity>;
  onViewActivity?: () => void;
}) {
  const now = new Date(Math.max(activity?.now ?? 0, Date.now())).toISOString();
  const continuing = ['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING'].includes(
    execution.status,
  );
  const waiting = continuing && reply.receipt;
  const unpublished =
    execution.publicationId === null ||
    (execution.publicationSequence != null &&
      execution.publicationSequence !== execution.turnSequence);
  const since = Date.parse(reply.receipt?.acceptedAt ?? execution.startedAt);
  // Only categorical, public observation metadata is surfaced here. Tool
  // arguments, transcript text and implementation diagnostics stay out.
  const { writer, lastAt, lastLabel, firstUseful, runtimeUpdate } = useMemo(() => {
    const sameTurn = (row: { attemptId?: string; turnSequence?: number }) =>
      row.attemptId === execution.attemptId && row.turnSequence === execution.turnSequence;
    const writer = Math.max(
      activity?.events.findLast(sameTurn)?.writerGeneration ?? 0,
      activity?.rows.findLast(sameTurn)?.writerGeneration ?? 0,
    );
    const inTurn = (row: {
      attemptId?: string;
      turnSequence?: number;
      writerGeneration?: number;
      timestamp: string;
    }) =>
      !writer && row.attemptId === undefined
        ? Date.parse(row.timestamp) >= since
        : sameTurn(row) && row.writerGeneration === writer;
    const output = activity?.rows.findLast((row) => !row.display?.hiddenByDefault && inTurn(row));
    const event = activity?.events.findLast(inTurn);
    const eventIsLatest =
      event && (!output || Date.parse(event.timestamp) >= Date.parse(output.timestamp));
    return {
      writer,
      firstUseful: activity?.rows.find(
        (row) =>
          row.attemptId &&
          inTurn(row) &&
          row.kind === 'stdout' &&
          row.display &&
          row.display.type !== 'system',
      ),
      lastAt: eventIsLatest ? event.timestamp : output?.timestamp,
      lastLabel: eventIsLatest
        ? 'Execution update'
        : (activityLabels[output?.display?.type ?? ''] ?? 'Agent activity'),
      runtimeUpdate: activity?.rows.findLast(
        (row) =>
          row.kind === 'lifecycle' &&
          row.display?.type === 'system' &&
          !row.display.hiddenByDefault &&
          row.display.title &&
          inTurn(row),
      ),
    };
  }, [activity?.rows, activity?.events, since, execution.attemptId, execution.turnSequence]);
  const stale = activity?.observedAt != null && Date.parse(now) - activity.observedAt > 10_000;
  return (
    <section aria-label="Reply progress" className="space-y-2">
      {continuing ? (
        <IntentProgressCard
          statusLabel={execution.status === 'RUNNING' ? 'Running' : 'Starting agent'}
          statusSummary={
            reply.receipt
              ? replyStatus(execution, reply)
              : (runtimeUpdate?.display?.title ?? (lastAt ? lastLabel : null))
          }
          onOutput={onViewActivity}
        />
      ) : (
        <p
          role="status"
          className={
            reply.awaitingReply && reply.state === 'idle' ? 'sr-only' : 'text-sm font-medium'
          }
        >
          {replyStatus(execution, reply)}
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Activity details</summary>
        <div className="mt-2 space-y-2">
          {execution.turnSequence != null && (
            <p className="text-xs">
              Turn {execution.turnSequence} · attempt {execution.attemptId}
              {writer > 0 && ` · latest observed writer ${writer}`}
              {unpublished && ' · no committed publication for this turn'}
            </p>
          )}
          {execution.turnSequence != null && unpublished && (
            <NativeTurnObservations
              attemptId={execution.attemptId}
              sequence={execution.turnSequence}
              events={activity?.events}
            />
          )}
          {execution.recovery?.reason === 'DELIVERY_UNCERTAIN' && reply.receipt && (
            <p className="text-sm">The reply is saved.</p>
          )}
          {waiting && (
            <p className="text-sm text-muted-foreground">
              Waiting since reply acceptance: {formatDuration(reply.receipt!.acceptedAt, now)}. You
              can leave this page and return to this intent.
            </p>
          )}
          {reply.state === 'sending' && !reply.receipt && (
            <p className="text-sm text-muted-foreground">
              Waiting for the server to confirm acceptance.
            </p>
          )}
          {continuing && activity && (
            <p className="text-xs text-muted-foreground">
              {lastAt
                ? `${lastLabel} last observed ${formatDuration(lastAt, now)} ago.`
                : 'No activity has been observed for this turn yet.'}{' '}
              Quiet intervals do not confirm that the agent has stopped.
            </p>
          )}
          {firstUseful && (
            <p className="text-xs text-muted-foreground">
              First useful output from this writer: {firstUseful.timestamp} (runtime capture).
            </p>
          )}
          {continuing && runtimeUpdate && (
            <p className="break-words text-sm text-muted-foreground">
              Last runtime update: {runtimeUpdate.display!.title}{' '}
              <span className="text-xs">({formatDuration(runtimeUpdate.timestamp, now)} ago)</span>
            </p>
          )}
          {activity && (
            <p className="text-xs text-muted-foreground">
              {activity.error
                ? 'Activity updates are unavailable. The last observations may be incomplete.'
                : stale
                  ? 'Activity has not refreshed recently. The last observations may be outdated.'
                  : activity.observedAt === null
                    ? 'Activity has not been confirmed yet.'
                    : 'Activity checked'}
              {activity.observedAt !== null && (
                <>
                  {' '}
                  {activity.error || stale ? 'Last activity check: ' : ''}
                  {formatDuration(new Date(activity.observedAt).toISOString(), now)} ago.
                </>
              )}
            </p>
          )}
          {!continuing && onViewActivity && (
            <Button variant="ghost" size="sm" onClick={onViewActivity}>
              View activity
            </Button>
          )}
        </div>
      </details>
    </section>
  );
}
