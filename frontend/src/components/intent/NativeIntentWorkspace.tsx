import { IntentInitialPrompt } from './IntentInitialPrompt';
import { detectSection } from '@/components/layout/IntentPipelineBar';
import { parseNativeHistoryLocation } from '@/lib/nativeRevisionLinks';
import { canRecover, imageBlocked } from '@/lib/executionCapabilities';
import { useEffect, useEffectEvent, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { MoreHorizontal, Settings2, RefreshCw, XCircle } from 'lucide-react';
import { IntentWorkspace } from '@/components/intent/IntentWorkspace';
import { NativeIntentConfigurationDialog } from '@/components/intent/IntentConfigurationDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { nativeDetailStatusLabel, nativeIntentTitle } from '@/lib/intentDiscovery';
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
import { NativeIntentInputs } from '@/components/intent/NativeIntentInputs';
import { nativeStartUnavailableMessages } from '@/services/nativeIntents';
import type { useNativeActivity } from '@/contexts/adapters/nativeActivity';
import {
  type NativeIntentAdapter,
  activeExecution,
  recoveryMessages,
} from '@/contexts/adapters/nativeIntent';

export function NativeIntentWorkspace({
  adapter,
  activity,
  onViewActivity,
}: {
  adapter: NativeIntentAdapter;
  activity?: ReturnType<typeof useNativeActivity>;
  onViewActivity?: () => void;
}) {
  const location = useLocation();
  const section = detectSection(location.pathname);
  const current = parseNativeHistoryLocation(location.search).mode === 'current';
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [inputsBusy, setInputsBusy] = useState(false);
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
    refreshAfterChange,
    publicationFailure,
  } = adapter;
  const eventRevision = activity?.events.at(-1)?.revision;
  const observeEvent = useEffectEvent((revision: number) => {
    const confirmed = intent?.execution?.revision;
    if (confirmed !== undefined && revision > confirmed) void refreshAfterChange(revision);
  });
  useEffect(() => {
    if (eventRevision !== undefined) observeEvent(eventRevision);
  }, [eventRevision]);
  useEffect(() => {
    setInputsBusy(false);
  }, [intent?.id]);
  return (
    <IntentWorkspace
      graph={section === 'graph' && current && !!intent}
      title={intent ? nativeIntentTitle(intent) : 'Intent'}
      badges={
        intent && (
          <Badge
            role="status"
            aria-label="Intent status"
            variant="outline"
            className="text-[10px] shrink-0"
          >
            {nativeDetailStatusLabel(intent)}
          </Badge>
        )
      }
      actions={
        intent && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Refresh status"
              title="Refresh status"
              onClick={() => void refresh()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {intent.execution &&
              (activeExecution.has(intent.execution.status) ||
                intent.execution.status === 'WAITING_FOR_INPUT' ||
                intent.execution.status === 'AWAITING_USER' ||
                (['STOPPED', 'FAILED'].includes(intent.execution.status) &&
                  intent.execution.stopStatus?.state !== 'confirmed')) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Cancel execution"
                  title="Cancel execution"
                  onClick={() => void execute('cancel')}
                  disabled={acting !== null || intent.execution.status === 'CANCEL_REQUESTED'}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              )}
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
          </>
        )
      }
    >
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
          {current && section === 'work' && (
            <>
              <NativePromptEditor adapter={adapter} />
              {!intent.execution && intent.promptRevision === undefined && (
                <IntentInitialPrompt prompt={intent.prompt} />
              )}
              <div className="space-y-2">
                {intent.execution?.status === 'FAILED' && (
                  <div>
                    <p role="alert" className="text-sm text-destructive">
                      {nativeExecutionFailureMessage(intent.execution.failureCode)}
                    </p>
                    {intent.execution.failureCode && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Error details</summary>Failure:{' '}
                        {intent.execution.failureCode}
                      </details>
                    )}
                  </div>
                )}
                {intent.execution?.status === 'RECOVERY_REQUIRED' && (
                  <p className="text-sm text-muted-foreground">
                    {canRecover(intent)
                      ? 'Resume to continue from the work already saved.'
                      : intent.execution.recovery
                        ? recoveryMessages[intent.execution.recovery.reason]
                        : 'Check the run details before resuming.'}
                  </p>
                )}
                {imageBlocked(intent) && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Execution is unavailable for this runtime image. Committed results remain
                    readable.
                  </p>
                )}
                {!intent.execution && intent.executionAvailable !== true && (
                  <p className="text-sm text-muted-foreground">
                    {intent.startUnavailableReason
                      ? nativeStartUnavailableMessages[intent.startUnavailableReason]
                      : 'Agent execution is not enabled for this draft.'}
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
                        setResumeEpisode(intent.execution!.recovery!.id);
                      }}
                      disabled={acting !== null}
                    >
                      {acting === 'recover' ? 'Requesting recovery…' : 'Resume in fresh session'}
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
                        inputsBusy ||
                        Boolean(
                          intent.inputs?.pendingUploads.length || intent.inputs?.imports.length,
                        ) ||
                        acting !== null
                      }
                    >
                      {acting === 'start' ? 'Requesting start…' : 'Start agent'}
                    </Button>
                  )}
                </div>
              </div>
              {!intent.execution && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">
                    Inputs and application source
                  </summary>
                  <NativeIntentInputs
                    key={`${projectId}:${intent.id}`}
                    intent={intent}
                    disabled={acting !== null || inputsBusy}
                    onBusyChange={setInputsBusy}
                    onRefresh={refreshAfterChange}
                    onAccessFailure={publicationFailure}
                  />
                </details>
              )}
            </>
          )}
          <NativeIntentContent
            intent={intent}
            onAccessFailure={publicationFailure}
            onRefresh={refreshAfterChange}
            onAccepted={adapter.acceptExecution}
            activity={activity}
            onViewActivity={onViewActivity}
          />
          {current && section === 'work' && intent.execution && intent.prompt && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Original request</summary>
              <p className="mt-2 whitespace-pre-wrap">{intent.prompt}</p>
            </details>
          )}
          {!current &&
            parseNativeHistoryLocation(location.search).mode === 'inspection' &&
            (intent.execution?.failureCode || intent.failureCode) && (
              <p className="text-sm">
                Failure: {intent.execution?.failureCode ?? intent.failureCode}
              </p>
            )}
          {intent.execution &&
            !current &&
            parseNativeHistoryLocation(location.search).mode === 'inspection' && (
              <NativeIntentInputs
                intent={intent}
                disabled
                onBusyChange={setInputsBusy}
                onRefresh={refreshAfterChange}
                onAccessFailure={publicationFailure}
              />
            )}
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
    </IntentWorkspace>
  );
}
