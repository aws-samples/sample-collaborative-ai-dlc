import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NativeIntentContent } from '@/components/intent/NativeIntentContent';
import { NativePromptEditor } from '@/components/intent/NativePromptEditor';
import { currentSessionEpoch } from '@/services/sessionExpiry';
import { useNativeListingVersion } from '@/hooks/useNativeIntents';
import {
  useNativeIntentAdapter,
  type NativeIntentAdapter,
  labels,
  harnesses,
  executionLabels,
  activeExecution,
  recoveryMessages,
  canRecover,
  imageBlocked,
} from '@/contexts/adapters/nativeIntent';

export default function NativeIntentPage() {
  const { projectId = '', intentId = '' } = useParams();
  useNativeListingVersion();
  return (
    <NativeWorkspace
      key={JSON.stringify([projectId, intentId, currentSessionEpoch()])}
      projectId={projectId}
      intentId={intentId}
    />
  );
}

function NativeWorkspace({ projectId, intentId }: { projectId: string; intentId: string }) {
  return <NativeWorkspaceView adapter={useNativeIntentAdapter(projectId, intentId)} />;
}

export function NativeWorkspaceView({ adapter }: { adapter: NativeIntentAdapter }) {
  const {
    projectId,
    intent,
    error,
    preparing,
    acting,
    prepare,
    execute,
    refresh,
    publicationFailure,
  } = adapter;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-6xl space-y-5">
        <Link className="text-sm underline" to={`/space/${projectId}`}>
          Back to space
        </Link>
        <h1 className="text-xl font-semibold">{intent?.title || 'Native intent'}</h1>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!intent ? (
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh status
          </Button>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant="outline">Native</Badge>
              <p role="status" className="font-medium">
                {intent.execution
                  ? intent.execution.status === 'DISPATCHING' &&
                    (intent.execution.responsePending === true ||
                      (intent.execution.turnSequence ?? 1) > 1)
                    ? 'Continuing agent'
                    : executionLabels[intent.execution.status]
                  : labels[intent.status]}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {harnesses[intent.harness]} · {intent.package.source.repository} ·{' '}
              {intent.package.source.release}
            </p>
            {intent.execution && (
              <div className="space-y-1 text-sm text-muted-foreground">
                {intent.execution.model && <p>Model: {intent.execution.model}</p>}
                {intent.execution.repository.repository && (
                  <p className="break-all">
                    Repository: {intent.execution.repository.provider} ·{' '}
                    {intent.execution.repository.repository}
                    {intent.execution.repository.branch &&
                      ` · ${intent.execution.repository.branch}`}
                    {intent.execution.repository.commit &&
                      ` · ${intent.execution.repository.commit}`}
                  </p>
                )}
                <p>Started {new Date(intent.execution.startedAt).toLocaleString()}</p>
                {intent.execution.failureCode && <p>Failure: {intent.execution.failureCode}</p>}
              </div>
            )}
            <p className="text-sm">
              {intent.execution
                ? intent.execution.status === 'RECOVERING'
                  ? 'Restoring the saved AI-DLC session. You can leave this page and return to the same link.'
                  : intent.execution.status === 'RECOVERY_REQUIRED'
                    ? intent.execution.recovery
                      ? recoveryMessages[intent.execution.recovery.reason]
                      : 'Session recovery is required. Refresh status to check whether recovery is available.'
                    : intent.execution.status === 'WAITING_FOR_INPUT'
                      ? 'The workflow is waiting. Published files and its question appear below once available.'
                      : intent.execution.status === 'AWAITING_USER'
                        ? 'AI-DLC is waiting for your reply.'
                        : intent.execution.status === 'STOPPED'
                          ? 'The agent turn stopped. This does not establish that the workflow is complete.'
                          : intent.execution.status === 'CANCELLED'
                            ? 'Cancellation is confirmed. Any committed revision remains available below.'
                            : intent.execution.status === 'FAILED'
                              ? 'Execution reported an error. Any committed revision remains available below.'
                              : 'This run uses its own runtime and workspace. You can leave this page and return to the same link.'
                : intent.status === 'READY'
                  ? 'This run has its own verified workspace. The agent has not started.'
                  : intent.status === 'PREPARING'
                    ? 'Preparing and verifying a separate runtime and workspace for this run. You can leave this page and return to the same link.'
                    : intent.status === 'FAILED'
                      ? 'Preparation stopped with an error. The run identity and any created resources are retained for diagnosis and retry.'
                      : 'Prepare a separate workspace for this native intent before agent execution is enabled.'}
            </p>
            {imageBlocked(intent) && (
              <p role="status" className="text-sm text-muted-foreground">
                Execution is unavailable for this runtime image. Committed results remain readable.
              </p>
            )}
            <NativePromptEditor adapter={adapter} />
            <div className="flex flex-wrap gap-2">
              {intent.status !== 'READY' && (
                <Button onClick={() => void prepare()} disabled={preparing}>
                  {preparing
                    ? 'Requesting preparation…'
                    : intent.status === 'DRAFT'
                      ? 'Prepare workspace'
                      : 'Retry preparation'}
                </Button>
              )}
              <Button variant="outline" onClick={() => void refresh()}>
                Refresh status
              </Button>
              {canRecover(intent) && (
                <Button onClick={() => void execute('recover')} disabled={acting !== null}>
                  {acting === 'recover' ? 'Requesting recovery…' : 'Recover session'}
                </Button>
              )}
              <Button
                onClick={() => void execute('start')}
                disabled={
                  intent.status !== 'READY' ||
                  intent.executionAvailable !== true ||
                  Boolean(intent.execution) ||
                  !intent.prompt.trim() ||
                  adapter.promptDraft !== null ||
                  adapter.savingPrompt ||
                  adapter.startConflict ||
                  acting !== null
                }
              >
                {acting === 'start' ? 'Requesting start…' : 'Start agent'}
              </Button>
              {intent.execution &&
                (activeExecution.has(intent.execution.status) ||
                  intent.execution.status === 'WAITING_FOR_INPUT' ||
                  intent.execution.status === 'AWAITING_USER') && (
                  <Button
                    variant="outline"
                    onClick={() => void execute('cancel')}
                    disabled={acting !== null || intent.execution.status === 'CANCEL_REQUESTED'}
                  >
                    {acting === 'cancel' ? 'Requesting cancellation…' : 'Cancel execution'}
                  </Button>
                )}
            </div>
            <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm text-muted-foreground">
                Questions and approvals are answered below when AI-DLC asks for them. Artifact
                editing, unit pull requests and deletion are not enabled yet.
                {!intent.execution &&
                  intent.executionAvailable !== true &&
                  ' Agent execution is not enabled for this draft.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {['Edit artifacts', 'Create unit PR', 'Delete intent'].map((action) => (
                  <Button key={action} variant="outline" disabled>
                    {action}
                  </Button>
                ))}
              </div>
            </div>
            <NativeIntentContent
              intent={intent}
              onAccessFailure={publicationFailure}
              onRefresh={refresh}
            />
          </>
        )}
      </div>
    </div>
  );
}
