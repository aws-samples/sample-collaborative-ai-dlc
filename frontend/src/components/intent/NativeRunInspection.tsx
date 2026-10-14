import type { NativeIntent } from '@/services/nativeIntents';
import { NativeHistoryView } from './NativeHistoryView';
import { useMemo } from 'react';

export function NativeRunInspection({
  intent,
  onAccessFailure,
}: {
  intent: NativeIntent;
  onAccessFailure: (error: unknown) => void;
}) {
  const execution = intent.execution;
  const publicationId = execution?.publicationId;
  const sequence = execution?.publicationSequence;
  const selection = useMemo(
    () =>
      publicationId && sequence
        ? {
            mode: 'revision' as const,
            revision: { publicationId, publicationSequence: sequence },
          }
        : { mode: 'history' as const },
    [publicationId, sequence],
  );
  return (
    <div className="space-y-4">
      <section aria-label="Inspect native work" className="space-y-3 rounded-md border p-4">
        <h2 className="font-semibold">Inspect work and export</h2>
        <h3 className="font-medium">{execution ? 'Request admitted at Start' : 'Saved request'}</h3>
        <pre className="whitespace-pre-wrap break-words text-sm">
          {intent.prompt || 'No prompt has been saved.'}
        </pre>
        {execution ? (
          <>
            <p className="text-sm">
              {execution.stopStatus?.state === 'confirmed'
                ? `Runtime stop confirmed at ${new Date(execution.stopStatus.confirmedAt!).toLocaleString()}.`
                : execution.stopStatus?.state === 'pending' ||
                    execution.status === 'CANCEL_REQUESTED'
                  ? 'Cancellation is requested. Runtime stop is not yet confirmed.'
                  : 'Runtime stop is not established by the retained evidence.'}
            </p>
            <p className="text-sm">
              Stopping does not undo previous external effects. Accepted answers, delivery
              observations and resulting publications are separate evidence; unrecorded effects
              remain unknown.
            </p>
            {execution.recovery?.reason === 'DELIVERY_UNCERTAIN' && (
              <p role="status" className="text-sm">
                The last command may have executed. It cannot be replayed through recovery. Inspect
                its proposal and accepted answer below before deciding what to do next.
              </p>
            )}
            {!publicationId ? (
              <p>No publication has been admitted. No exact result export is available.</p>
            ) : !sequence ? (
              <p>
                This controller did not provide the last publication sequence. Select an exact
                publication from history to inspect or export it.
              </p>
            ) : (
              <p>Last admitted publication: {sequence}. Its exact history and results follow.</p>
            )}
          </>
        ) : (
          <p>No execution has been admitted. Preparation and any created resources are retained.</p>
        )}
        <p className="text-sm text-muted-foreground">
          Result exports contain published public files, not a complete runnable workspace. Private
          sessions and recovery checkpoints are not included. Creating a replacement run and
          archiving work are not available here.
        </p>
      </section>
      {execution && (
        <NativeHistoryView
          key={JSON.stringify([publicationId, sequence])}
          intent={intent}
          selection={selection}
          onAccessFailure={onAccessFailure}
        />
      )}
    </div>
  );
}
