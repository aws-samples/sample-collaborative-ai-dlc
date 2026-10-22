import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { MoreHorizontal, Settings2 } from 'lucide-react';
import { IntentWorkspaceHeader } from '@/components/intent/IntentWorkspaceHeader';
import { NativeIntentConfigurationDialog } from '@/components/intent/IntentConfigurationDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { nativeIntentStatusLabel, nativeIntentTitle } from '@/lib/intentDiscovery';
import { nativeExecutionFailureMessage } from '@/lib/nativeExecutionFailure';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { NativeIntentContent } from '@/components/intent/NativeIntentContent';
import { NativePromptEditor } from '@/components/intent/NativePromptEditor';
import { currentSessionEpoch } from '@/services/sessionExpiry';
import { useNativeListingVersion } from '@/hooks/useNativeIntents';
import type { useNativeActivity } from '@/contexts/adapters/nativeActivity';
import {
  useNativeIntentAdapter,
  type NativeIntentAdapter,
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

export function NativeWorkspaceView({
  adapter,
  activity,
  onViewActivity,
}: {
  adapter: NativeIntentAdapter;
  activity?: ReturnType<typeof useNativeActivity>;
  onViewActivity?: () => void;
}) {
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [resumeEpisode, setResumeEpisode] = useState<string | null>(null);
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
    <div className="space-y-6">
      <IntentWorkspaceHeader
        title={intent ? nativeIntentTitle(intent) : 'Native intent'}
        badges={
          intent && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              Native
            </Badge>
          )
        }
        actions={
          intent && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Intent actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setConfigurationOpen(true)}>
                  <Settings2 className="mr-2 h-4 w-4" />
                  Intent configuration
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={`/space/${encodeURIComponent(projectId)}`}>Back to space</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
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
          <section aria-label="Native execution status" className="space-y-3 rounded-md border p-4">
            <p role="status" className="font-medium">
              {nativeIntentStatusLabel(intent)}
            </p>
            <p className="text-sm">
              {intent.execution
                ? intent.execution.status === 'RECOVERING'
                  ? intent.execution.recoveryMode === 'efs-workspace-v1'
                    ? 'Opening a fresh CLI session on the surviving workspace. AI-DLC will reconcile its work and required questions.'
                    : 'Restoring the saved AI-DLC session. You can leave this page and return to the same link.'
                  : intent.execution.status === 'RECOVERY_REQUIRED'
                    ? intent.execution.recoveryMode === 'efs-workspace-v1' &&
                      intent.execution.recovery?.canRecover
                      ? 'The previous runtime is stopped. Confirm a fresh session to resume AI-DLC on the surviving workspace. Earlier answers remain in history and will not be sent again.'
                      : intent.execution.recovery
                        ? recoveryMessages[intent.execution.recovery.reason]
                        : 'Session recovery is required. Refresh status to check whether recovery is available.'
                    : intent.execution.status === 'WAITING_FOR_INPUT'
                      ? 'The workflow is waiting. Published files and its question appear below once available.'
                      : intent.execution.status === 'AWAITING_USER'
                        ? 'AI-DLC is waiting for your reply.'
                        : intent.execution.status === 'STOPPED'
                          ? 'The agent turn stopped. This does not establish that the workflow is complete.'
                          : intent.execution.status === 'CANCELLED'
                            ? 'Cancellation handling finished. Inspect work to check retained stop evidence and committed revisions.'
                            : intent.execution.status === 'FAILED'
                              ? `${nativeExecutionFailureMessage(intent.execution.failureCode)} Any committed revision remains available below.`
                              : 'This run uses its own runtime and workspace. You can leave this page and return to the same link.'
                : intent.status === 'READY'
                  ? 'This run has its own verified workspace. The agent has not started.'
                  : intent.status === 'PREPARING'
                    ? 'Preparing and verifying a separate runtime and workspace for this run. You can leave this page and return to the same link.'
                    : intent.status === 'FAILED'
                      ? 'Preparation stopped with an error. The run identity and any created resources are retained for diagnosis and retry.'
                      : 'Prepare the workspace, then start the agent with your saved prompt.'}
            </p>
            {imageBlocked(intent) && (
              <p role="status" className="text-sm text-muted-foreground">
                Execution is unavailable for this runtime image. Committed results remain readable.
              </p>
            )}
            {(intent.execution?.failureCode || intent.failureCode) && (
              <p className="text-sm text-destructive">
                Failure: {intent.execution?.failureCode ?? intent.failureCode}
              </p>
            )}
            {!intent.execution && intent.executionAvailable !== true && (
              <p className="text-sm text-muted-foreground">
                Agent execution is not enabled for this draft.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!intent.execution && intent.status !== 'READY' && (
                <Button onClick={() => void prepare()} disabled={preparing}>
                  {preparing
                    ? 'Requesting preparation…'
                    : intent.status === 'DRAFT'
                      ? 'Prepare workspace'
                      : 'Retry preparation'}
                </Button>
              )}
              {canRecover(intent) && (
                <Button
                  onClick={() => {
                    if (intent.execution?.recoveryMode === 'efs-workspace-v1')
                      setResumeEpisode(intent.execution.recovery!.id);
                    else void execute('recover');
                  }}
                  disabled={acting !== null}
                >
                  {acting === 'recover'
                    ? 'Requesting recovery…'
                    : intent.execution?.recoveryMode === 'efs-workspace-v1'
                      ? 'Resume in fresh session'
                      : 'Recover session'}
                </Button>
              )}
              {!intent.execution && (
                <Button
                  onClick={() => void execute('start')}
                  disabled={
                    intent.status !== 'READY' ||
                    intent.executionAvailable !== true ||
                    !intent.prompt.trim() ||
                    adapter.promptDraft !== null ||
                    adapter.savingPrompt ||
                    adapter.startConflict ||
                    acting !== null
                  }
                >
                  {acting === 'start' ? 'Requesting start…' : 'Start agent'}
                </Button>
              )}
              {intent.execution &&
                (activeExecution.has(intent.execution.status) ||
                  intent.execution.status === 'WAITING_FOR_INPUT' ||
                  intent.execution.status === 'AWAITING_USER' ||
                  (['STOPPED', 'FAILED'].includes(intent.execution.status) &&
                    intent.execution.stopStatus?.state !== 'confirmed')) && (
                  <Button
                    variant="outline"
                    onClick={() => void execute('cancel')}
                    disabled={acting !== null || intent.execution.status === 'CANCEL_REQUESTED'}
                  >
                    {acting === 'cancel' ? 'Requesting cancellation…' : 'Cancel execution'}
                  </Button>
                )}
              <Button variant="outline" onClick={() => void refresh()}>
                Refresh status
              </Button>
            </div>
          </section>
          <NativePromptEditor adapter={adapter} />
          <NativeIntentContent
            intent={intent}
            onAccessFailure={publicationFailure}
            onRefresh={refresh}
            onAccepted={adapter.acceptExecution}
            activity={activity}
            onViewActivity={onViewActivity}
          />
          <NativeIntentConfigurationDialog
            intent={intent}
            open={configurationOpen}
            onOpenChange={setConfigurationOpen}
          />
          <AlertDialog
            open={resumeEpisode !== null}
            onOpenChange={(open) => {
              if (!open) setResumeEpisode(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Resume AI-DLC in a fresh session?</AlertDialogTitle>
                <AlertDialogDescription>
                  Use the same surviving workspace, including unfinished edits. AI-DLC will
                  reconcile its workflow and ask for any required decisions. This does not restore
                  an old publication or approve a workflow gate. Earlier answers and results remain
                  in history. No previous answer is sent again, including a saved answer that was
                  not delivered; review it against the resumed question before submitting a new
                  answer.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep stopped</AlertDialogCancel>
                <AlertDialogAction
                  disabled={
                    !canRecover(intent) ||
                    intent.execution?.recovery?.id !== resumeEpisode ||
                    acting !== null
                  }
                  onClick={() => {
                    if (resumeEpisode) void execute('recover', { recoveryId: resumeEpisode });
                    setResumeEpisode(null);
                  }}
                >
                  Confirm fresh session
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
