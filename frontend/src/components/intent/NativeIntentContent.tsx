import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { nativeHistorySearch, parseNativeHistoryLocation } from '@/lib/nativeRevisionLinks';
import { NativeHistoryView } from './NativeHistoryView';
import { NativeRunInspection } from './NativeRunInspection';
import { NativeFileView, NativeFilesystemNotice } from './NativeFileView';
import { WorkProductsCard } from './WorkProductsCard';
import { NativeResultDownload } from './NativeResultDownload';
import {
  NativeWorkflowProgress,
  CompletionDetails,
  usePublicationCompletion,
} from './NativeCompletionEvidence';
import { NATIVE_INLINE_BYTES, type NativeRevisionFile } from '@/services/nativeHistory';
import { NativeInteractionPanel, useNativeReply } from './NativeInteractionPanel';
import { NativeExecutionProgress } from './NativeExecutionProgress';
import { NativeTurnObservations } from './NativeTurnObservations';
import type { useNativeActivity } from '@/contexts/adapters/nativeActivity';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { nativeGraphMatchesPublication, nativeGraphSourceLinks } from '@/lib/nativeTraceability';
import { IntentGraphSurface } from './IntentGraphSurface';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { intentSectionPath } from '@/lib/intentSectionPreference';
import { detectSection } from '@/components/layout/IntentPipelineBar';
import { IntentInitialPrompt } from './IntentInitialPrompt';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getNativeListing,
  nativeAccessDenied,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  isSessionActive,
  onSessionChanged,
} from '@/services/sessionExpiry';
import {
  nativeIntentsService,
  type NativeFileContent,
  type NativeGraph,
  type NativeIntent,
  type NativeExecution,
  type NativeInteractionView,
  type NativePublication,
} from '@/services/nativeIntents';

interface NativeContentProps {
  intent: NativeIntent;
  onAccessFailure: (error: unknown) => void;
  onRefresh: () => Promise<void>;
  onAccepted?: (execution: NativeExecution) => void;
  activity?: ReturnType<typeof useNativeActivity>;
  onViewActivity?: () => void;
}

export function NativeIntentContent({
  intent,
  onAccessFailure,
  onRefresh,
  onAccepted,
  activity,
  onViewActivity,
}: NativeContentProps) {
  const location = useLocation();
  const session = useSyncExternalStore(onSessionChanged, currentSessionEpoch);
  useNativeListingVersion();
  const auth = useOptionalAuth();
  const selection = useMemo(() => parseNativeHistoryLocation(location.search), [location.search]);
  const discussions = useDiscussions();
  const close = discussions?.close;
  useEffect(() => {
    close?.();
  }, [location.search, close]);
  const listing = getNativeListing(intent.projectId);
  const workPath = intentSectionPath(intent.projectId, intent.id, 'work', 'native');
  const graphPage = detectSection(location.pathname) === 'graph' && selection.mode === 'current';
  const identity = [
    intent.projectId,
    intent.id,
    auth?.user?.userId,
    session,
    listing.accessRevision ?? 0,
  ];
  if (!isSessionActive()) return null;
  return (
    <div className={graphPage ? 'h-full min-w-0' : 'space-y-4'}>
      {selection.mode === 'current' ? (
        <CurrentTurnContent
          key={JSON.stringify([...identity, intent.execution?.attemptId])}
          intent={intent}
          onAccessFailure={onAccessFailure}
          onRefresh={onRefresh}
          onAccepted={onAccepted}
          activity={activity}
          onViewActivity={onViewActivity}
        />
      ) : selection.mode === 'inspection' ? (
        <NativeRunInspection
          key={JSON.stringify([...identity, location.search])}
          intent={intent}
          onAccessFailure={onAccessFailure}
        />
      ) : (
        <NativeHistoryView
          key={JSON.stringify([...identity, location.search])}
          intent={intent}
          selection={selection}
          activity={activity}
          onAccessFailure={onAccessFailure}
        />
      )}
      {!graphPage && (
        <nav
          aria-label="Native revision navigation"
          className="flex flex-wrap gap-4 border-t pt-3 text-xs text-muted-foreground"
        >
          <Link
            className="underline"
            to={{ pathname: workPath, search: nativeHistorySearch(location.search) }}
            aria-current={selection.mode === 'current' ? 'page' : undefined}
          >
            Current
          </Link>
          <Link
            className="underline"
            to={{
              pathname: workPath,
              search: nativeHistorySearch(location.search, { history: true }),
            }}
            aria-current={['history', 'revision'].includes(selection.mode) ? 'page' : undefined}
          >
            History
          </Link>
          <Link
            className="underline"
            to={{
              pathname: workPath,
              search: nativeHistorySearch(location.search, { inspection: true }),
            }}
            aria-current={selection.mode === 'inspection' ? 'page' : undefined}
          >
            Inspect work and export
          </Link>
        </nav>
      )}
    </div>
  );
}

// Retain observations across polls/reloads within this member's open Current
// view. A late open or a return from History cannot recreate the original display.
function CurrentTurnContent(props: NativeContentProps) {
  const execution = props.intent.execution;
  const pending = useRef<number | null>(null);
  const [display, setDisplay] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (
      execution?.turnSequence &&
      (execution.publicationId === null ||
        (execution.publicationSequence != null &&
          execution.turnSequence > execution.publicationSequence))
    )
      pending.current = execution.turnSequence;
  }, [execution?.turnSequence, execution?.publicationSequence, execution?.publicationId]);
  const displayed = useCallback((id: string, sequence: number) => {
    if (pending.current !== sequence) return;
    pending.current = null;
    setDisplay({ id, at: Date.now() });
  }, []);
  return (
    <NativePublicationContent
      key={JSON.stringify([
        execution?.publicationId,
        execution?.publicationSequence,
        execution?.interactionId,
      ])}
      {...props}
      displayed={displayed}
      displayedAt={display && display.id === execution?.publicationId ? display.at : undefined}
    />
  );
}

function NativePublicationContent({
  intent,
  onAccessFailure,
  onRefresh,
  onAccepted,
  activity,
  onViewActivity,
  displayed,
  displayedAt,
}: NativeContentProps & {
  displayed: (id: string, sequence: number) => void;
  displayedAt?: number;
}) {
  const { projectId, id: intentId } = intent;
  const publicationId = intent.execution?.publicationId ?? null;
  const publicationSequence = intent.execution?.publicationSequence;
  const interactionId = intent.execution?.interactionId ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const section = detectSection(location.pathname);
  const workPath = intentSectionPath(projectId, intentId, 'work', 'native');
  const [publication, setPublication] = useState<NativePublication | null>(null);
  const publicationLabel = useRef<HTMLParagraphElement>(null);
  const [files, setFiles] = useState<Record<string, NativeFileContent | NativeRevisionFile>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acceptedGraph, setGraph] = useState<{
    graph: NativeGraph;
    publication: NativePublication;
  } | null>(null);
  const graph = acceptedGraph?.publication === publication ? acceptedGraph.graph : null;
  const { search } = useLocation();
  const sourceLinks = useMemo(() => {
    if (!graph || !publication) return undefined;
    const links = nativeGraphSourceLinks(graph, publication, search);
    return new Map([...links].map(([id, query]) => [id, `${workPath}${query}`]));
  }, [graph, publication, search, workPath]);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [loadedInteraction, setInteraction] = useState<NativeInteractionView | null>(null);
  const interaction =
    publication && loadedInteraction?.sequence === publication.sequence ? loadedInteraction : null;
  const [error, setError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const epoch = useRef(currentSessionEpoch());
  const accessRevision = useRef(getNativeListing(projectId).accessRevision ?? 0);
  const fileRequests = useRef(new Set<string>());

  const scopeCurrent = useCallback(
    () =>
      alive.current &&
      epoch.current === currentSessionEpoch() &&
      !isSessionExpiryNotified() &&
      accessRevision.current === (getNativeListing(projectId).accessRevision ?? 0),
    [projectId],
  );
  const current = useCallback(
    (requestGeneration: number) => generation.current === requestGeneration && scopeCurrent(),
    [scopeCurrent],
  );

  // Observe the rendered revision label in the viewport of a visible tab.
  // A background fetch, a collapsed view and history replay aren't displays.
  useEffect(() => {
    const label = publicationLabel.current;
    if (!publication || !label || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (
        active &&
        document.visibilityState === 'visible' &&
        scopeCurrent() &&
        entries.some(
          (entry) => entry.target === label && entry.isIntersecting && entry.intersectionRatio > 0,
        )
      ) {
        displayed(publication.id, publication.sequence);
        observer.disconnect();
      }
    });
    const visible = () => {
      observer.disconnect();
      if (document.visibilityState === 'visible') observer.observe(label);
    };
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [publication, displayed, scopeCurrent]);

  useEffect(() => {
    alive.current = true;
    const requests = fileRequests.current;
    return () => {
      alive.current = false;
      generation.current += 1;
      requests.clear();
    };
  }, []);

  const failed = useCallback(
    (err: unknown, requestGeneration: number) => {
      if (!current(requestGeneration) && !(nativeAccessDenied(err) && scopeCurrent())) return;
      generation.current += 1;
      setPublication(null);
      setFiles({});
      setGraph(null);
      setInteraction(null);
      setSelectedId(null);
      setError(
        'Published content could not be verified or loaded. Refresh status and reload the publication.',
      );
      if (nativeAccessDenied(err)) onAccessFailure(err);
    },
    [current, scopeCurrent, onAccessFailure],
  );

  useEffect(() => {
    if (!publicationId) return;
    const requestGeneration = generation.current;
    let active = true;
    nativeIntentsService
      .publication(projectId, intentId)
      .then((value) => {
        if (!active || !current(requestGeneration)) return;
        if (
          value.id !== publicationId ||
          (publicationSequence != null && value.sequence !== publicationSequence)
        ) {
          throw new Error('The committed revision changed. Refresh status to load its files.');
        }
        setPublication(value);
      })
      .catch((err) => {
        if (active || nativeAccessDenied(err)) failed(err, requestGeneration);
      });
    return () => {
      active = false;
    };
  }, [projectId, intentId, publicationId, publicationSequence, reloadRevision, current, failed]);

  const turnSequence = intent.execution?.turnSequence;
  const executionStatus = intent.execution?.status;
  const responsePending = intent.execution?.responsePending;
  useEffect(() => {
    if (!publicationId || !interactionId || error) return;
    const requestGeneration = generation.current;
    let active = true;
    nativeIntentsService
      .interaction(projectId, intentId)
      .then((value) => {
        if (!active || !current(requestGeneration)) return;
        if (
          value.id !== interactionId ||
          value.publicationId !== publicationId ||
          value.harness !== intent.harness ||
          turnSequence === undefined ||
          value.sequence > turnSequence ||
          (executionStatus === 'AWAITING_USER' && value.sequence !== turnSequence)
        )
          throw new Error('Interaction does not match the current publication');
        setInteraction(value);
      })
      .catch((err) => {
        if (active || nativeAccessDenied(err)) failed(err, requestGeneration);
      });
    return () => {
      active = false;
    };
  }, [
    projectId,
    intentId,
    publicationId,
    interactionId,
    turnSequence,
    executionStatus,
    responsePending,
    intent.harness,
    error,
    current,
    failed,
    reloadRevision,
  ]);
  // Publication and interaction reads are independent. Neither text nor an
  // answer form is exposed until both verify the same admitted revision.
  useEffect(() => {
    if (publication && loadedInteraction && publication.sequence !== loadedInteraction.sequence)
      failed(new Error('Interaction does not match the current publication'), generation.current);
  }, [publication, loadedInteraction, failed]);

  const replyFailure = useCallback((err: unknown) => failed(err, generation.current), [failed]);
  const auth = useOptionalAuth();
  // Native threads have no pinned platform CLI; Quorum defaults to this run's
  // harness CLI, resolved with the requesting member's own credential.
  const discussions = useDiscussions();
  const setAssistAgentCli = discussions?.setAssistAgentCli;
  const assistAgentCli = discussions?.assistAgentCli ?? null;
  const nativeDiscussions = discussions?.scope?.kind === 'native';
  useEffect(() => {
    if (nativeDiscussions && !assistAgentCli) setAssistAgentCli?.(intent.harness);
  }, [nativeDiscussions, assistAgentCli, setAssistAgentCli, intent.harness]);
  const reply = useNativeReply({
    intent,
    interaction,
    scopeCurrent,
    onAccessFailure: replyFailure,
    onRefresh,
    onAccepted,
    userName: auth?.user?.displayName || auth?.user?.email || '',
  });

  // Resolve the question from the committed manifest before showing any text.
  // File requests are shared by Overview and Files, and stay within this head.
  useEffect(() => {
    if (!publication || error) return;
    const ids = new Set(
      [publication.question?.fileId, selectedId].filter((id): id is string => Boolean(id)),
    );
    for (const id of ids) {
      if (files[id] || fileRequests.current.has(id)) continue;
      const descriptor = publication.files.find((file) => file.id === id);
      if (!descriptor) continue;
      fileRequests.current.add(id);
      if (descriptor.bytes > NATIVE_INLINE_BYTES) {
        setFiles((previous) => ({
          ...previous,
          [id]: {
            ...descriptor,
            fileId: descriptor.id,
            publicationId: publication.id,
            publicationSequence: publication.sequence,
            encoding: 'too_large',
            content: null,
            truncated: false,
          },
        }));
        continue;
      }
      const requestGeneration = generation.current;
      nativeIntentsService
        .file(projectId, intentId, id)
        .then((value) => {
          if (!current(requestGeneration)) return;
          if (
            value.publicationId !== publication.id ||
            value.id !== descriptor.id ||
            value.path !== descriptor.path ||
            value.sha256 !== descriptor.sha256 ||
            value.bytes !== descriptor.bytes ||
            value.mediaType !== descriptor.mediaType
          ) {
            throw new Error('The file does not match the committed revision. Refresh status.');
          }
          setFiles((previous) => ({ ...previous, [id]: value }));
        })
        .catch((err) => failed(err, requestGeneration));
    }
  }, [publication, selectedId, files, error, projectId, intentId, current, failed]);

  const projectionComplete =
    publication?.projectionStatus === 'complete' ||
    intent.execution?.projectionStatus === 'complete';
  useEffect(() => {
    if (section !== 'graph' || !publication || !projectionComplete || error) return;
    const requestGeneration = generation.current;
    let active = true;
    nativeIntentsService
      .graph(projectId, intentId)
      .then((value) => {
        if (!active || !current(requestGeneration)) return;
        if (
          !nativeGraphMatchesPublication(value, publication, projectId, intentId, interactionId)
        ) {
          throw new Error('The graph does not match the committed revision. Refresh status.');
        }
        setGraphError(null);
        setGraph({ graph: value, publication });
      })
      .catch((err) => {
        if (nativeAccessDenied(err)) failed(err, requestGeneration);
        else if (active && current(requestGeneration)) {
          setGraph(null);
          setGraphError(
            'The graph could not be verified or loaded. Files and replies remain available. Reopen Graph to retry.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [
    section,
    publication,
    projectionComplete,
    error,
    projectId,
    intentId,
    interactionId,
    current,
    failed,
  ]);

  const openFile = (id: string) => {
    if (!publication?.files.some((file) => file.id === id)) return;
    setSelectedId(id);
    document.getElementById('intent-work-products')?.scrollIntoView?.({ block: 'nearest' });
  };
  const reloadPublication = () => {
    generation.current += 1;
    fileRequests.current.clear();
    setPublication(null);
    setInteraction(null);
    setFiles({});
    setGraph(null);
    setGraphError(null);
    setSelectedId(null);
    setError(null);
    setReloadRevision((value) => value + 1);
  };
  const questionFile = publication?.question ? files[publication.question.fileId] : null;
  const selectedFile = selectedId ? files[selectedId] : null;
  const descriptor = publication?.files.find((file) => file.id === selectedId);
  const noPublication = publicationId
    ? 'Loading the committed revision…'
    : 'No files have been published by this run.';

  const target =
    !error && publication && intent.execution
      ? { publicationId: publication.id, publicationSequence: publication.sequence }
      : null;
  const observation = usePublicationCompletion(
    projectId,
    intentId,
    intent.execution?.attemptId,
    target,
    onAccessFailure,
  );
  const evidenceDetails = target && (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Workflow details</summary>
      <CompletionDetails target={target} observation={observation} />
    </details>
  );
  const failure = error && (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      {error}
      <Button variant="outline" onClick={reloadPublication}>
        Reload publication
      </Button>
    </div>
  );
  if (section === 'graph') {
    if (failure || graphError)
      return (
        <section aria-label="Knowledge graph" className="p-6">
          {failure}
          {graphError && (
            <p role="alert" className="text-sm text-destructive">
              {graphError}
            </p>
          )}
        </section>
      );
    return (
      <TooltipProvider>
        <IntentGraphSurface
          nodes={graph?.nodes ?? []}
          edges={graph?.edges ?? []}
          sourceLinks={sourceLinks}
          loading={!!publicationId && (!publication || (projectionComplete && !graph))}
          emptyState={
            <p>
              {!publication
                ? noPublication
                : !projectionComplete
                  ? 'Files are available. Graph projection is still pending.'
                  : 'No graph nodes are included in this revision.'}
            </p>
          }
          onOpenInteraction={(id) => {
            if (interactionId === id) navigate(workPath);
          }}
        />
      </TooltipProvider>
    );
  }
  const workflow = target && (
    <NativeWorkflowProgress presentation={section} observation={observation} />
  );
  if (section === 'overview')
    return (
      <div className="space-y-6">
        <IntentInitialPrompt prompt={intent.prompt} />
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Execution progress</CardTitle>
          </CardHeader>
          <CardContent>
            {failure}
            {workflow || (
              <p className="text-sm text-muted-foreground">
                {intent.execution
                  ? 'The workflow has not published a plan yet.'
                  : 'The agent has not started.'}
              </p>
            )}
            {evidenceDetails}
            <Button size="sm" variant="ghost" onClick={() => navigate(workPath)}>
              Open work
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  const progress = intent.execution && (
    <NativeExecutionProgress
      execution={intent.execution}
      reply={reply}
      activity={activity}
      onViewActivity={onViewActivity}
    />
  );
  return (
    <div className="space-y-4">
      {failure}
      {workflow}
      {progress}
      {!error && interaction && intent.execution && (
        <NativeInteractionPanel
          interaction={interaction}
          reply={reply}
          executionStatus={intent.execution.status}
        />
      )}
      {!error && interactionId && !interaction && (
        <p className="text-sm text-muted-foreground">Loading the published AI-DLC response…</p>
      )}
      {!error &&
        publication?.question &&
        (questionFile ? (
          <section aria-label="Published question" className="space-y-2">
            <h2 className="font-semibold">Workflow question</h2>
            <p className="text-sm text-muted-foreground">This question is read-only.</p>
            <NativeFileView
              file={questionFile}
              descriptor={publication.files.find((file) => file.id === questionFile.id)!}
              createdAt={publication.createdAt}
              publicationSequence={publication.sequence}
              resultScope={{
                projectId: intent.projectId,
                executionId: intent.id,
                onAccessFailure,
              }}
            />
            <Button variant="outline" onClick={() => openFile(questionFile.id)}>
              View question file
            </Button>
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">Loading the published question file…</p>
        ))}

      {intent.execution && (
        <section id="intent-work-products" aria-label="Work products">
          <WorkProductsCard
            actions={
              !error &&
              publication && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">Download work</summary>
                  <NativeResultDownload
                    projectId={intent.projectId}
                    executionId={intent.id}
                    target={{
                      publicationId: publication.id,
                      publicationSequence: publication.sequence,
                    }}
                    git={intent.execution ? { source: intent.execution.repository } : undefined}
                    onAccessFailure={onAccessFailure}
                  />
                </details>
              )
            }
          >
            {!error &&
              (publication ? (
                <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
                  <nav aria-label="Published files" className="space-y-1">
                    {publication.files.length === 0 && (
                      <p className="text-sm">This revision contains no files.</p>
                    )}
                    {publication.files.map((file) => (
                      <button
                        key={file.id}
                        type="button"
                        aria-current={file.id === selectedId ? 'true' : undefined}
                        className="w-full rounded-md border p-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                        onClick={() => setSelectedId(file.id)}
                      >
                        <span className="block break-all">{file.path}</span>
                      </button>
                    ))}
                  </nav>
                  <div className="min-w-0">
                    {selectedId ? (
                      selectedFile && descriptor ? (
                        <NativeFileView
                          key={selectedId}
                          file={selectedFile}
                          descriptor={descriptor}
                          createdAt={publication.createdAt}
                          publicationSequence={publication.sequence}
                          resultScope={{
                            projectId: intent.projectId,
                            executionId: intent.id,
                            onAccessFailure,
                          }}
                        />
                      ) : (
                        <p className="text-sm">Loading file…</p>
                      )
                    ) : (
                      <p className="text-sm text-muted-foreground">Select a published file.</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{noPublication}</p>
              ))}
          </WorkProductsCard>
        </section>
      )}
      {publication && (
        <p ref={publicationLabel} className="text-xs text-muted-foreground">
          Published revision {publication.sequence} ·{' '}
          {new Date(publication.createdAt).toLocaleString()} · {publication.files.length}{' '}
          {publication.files.length === 1 ? 'file' : 'files'}
        </p>
      )}
      {publication && intent.execution && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Revision details</summary>
          <NativeFilesystemNotice policy={publication.filesystemPolicy} />
          <NativeTurnObservations
            events={activity?.events}
            attemptId={intent.execution.attemptId}
            sequence={publication.sequence}
            publicationId={publication.id}
            displayedAt={displayedAt}
          />
        </details>
      )}
      {evidenceDetails}
    </div>
  );
}
