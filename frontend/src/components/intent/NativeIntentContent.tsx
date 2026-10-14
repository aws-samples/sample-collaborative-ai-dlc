import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router';
import { nativeHistorySearch, parseNativeHistoryLocation } from '@/lib/nativeRevisionLinks';
import { NativeHistoryView } from './NativeHistoryView';
import { NativeRunInspection } from './NativeRunInspection';
import { NativeFileView } from './NativeFileView';
import { WorkProductsCard } from './WorkProductsCard';
import { NativeResultDownload } from './NativeResultDownload';
import { NativeCompletionEvidence } from './NativeCompletionEvidence';
import { NATIVE_INLINE_BYTES, type NativeRevisionFile } from '@/services/nativeHistory';
import { NativeInteractionPanel, useNativeReply } from './NativeInteractionPanel';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { nativeGraphMatchesPublication } from '@/lib/nativeTraceability';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  type NativeInteractionView,
  type NativePublication,
} from '@/services/nativeIntents';

export function NativeIntentContent({
  intent,
  onAccessFailure,
  onRefresh,
}: {
  intent: NativeIntent;
  onAccessFailure: (error: unknown) => void;
  onRefresh: () => Promise<void>;
}) {
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
  const identity = [
    intent.projectId,
    intent.id,
    auth?.user?.userId,
    session,
    listing.accessRevision ?? 0,
  ];
  if (!isSessionActive()) return null;
  return (
    <div className="space-y-4">
      <nav aria-label="Native revision navigation" className="flex gap-4 text-sm">
        <Link
          className="underline"
          to={{ search: nativeHistorySearch(location.search) }}
          aria-current={selection.mode === 'current' ? 'page' : undefined}
        >
          Current
        </Link>
        <Link
          className="underline"
          to={{ search: nativeHistorySearch(location.search, { history: true }) }}
          aria-current={['history', 'revision'].includes(selection.mode) ? 'page' : undefined}
        >
          History
        </Link>
        <Link
          className="underline"
          to={{ search: nativeHistorySearch(location.search, { inspection: true }) }}
          aria-current={selection.mode === 'inspection' ? 'page' : undefined}
        >
          Inspect work and export
        </Link>
      </nav>
      {selection.mode === 'current' ? (
        <NativePublicationContent
          key={JSON.stringify([
            ...identity,
            intent.execution?.publicationId,
            intent.execution?.interactionId,
          ])}
          intent={intent}
          onAccessFailure={onAccessFailure}
          onRefresh={onRefresh}
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
          onAccessFailure={onAccessFailure}
        />
      )}
    </div>
  );
}

function NativePublicationContent({
  intent,
  onAccessFailure,
  onRefresh,
}: {
  intent: NativeIntent;
  onAccessFailure: (error: unknown) => void;
  onRefresh: () => Promise<void>;
}) {
  const { projectId, id: intentId } = intent;
  const publicationId = intent.execution?.publicationId ?? null;
  const interactionId = intent.execution?.interactionId ?? null;
  const [tab, setTab] = useState('overview');
  const [publication, setPublication] = useState<NativePublication | null>(null);
  const [files, setFiles] = useState<Record<string, NativeFileContent | NativeRevisionFile>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graph, setGraph] = useState<NativeGraph | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<NativeInteractionView | null>(null);
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
        if (value.id !== publicationId) {
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
  }, [projectId, intentId, publicationId, reloadRevision, current, failed]);

  const turnSequence = intent.execution?.turnSequence;
  const executionStatus = intent.execution?.status;
  const responsePending = intent.execution?.responsePending;
  useEffect(() => {
    if (!publication || !interactionId || error) return;
    const requestGeneration = generation.current;
    let active = true;
    nativeIntentsService
      .interaction(projectId, intentId)
      .then((value) => {
        if (!active || !current(requestGeneration)) return;
        if (
          value.id !== interactionId ||
          value.publicationId !== publication.id ||
          value.sequence !== publication.sequence ||
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
    publication,
    interactionId,
    turnSequence,
    executionStatus,
    responsePending,
    intent.harness,
    error,
    current,
    failed,
  ]);

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
    if (tab !== 'graph' || !publication || !projectionComplete || error) return;
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
        setGraph(value);
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
    tab,
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
    setTab('files');
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

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList aria-label="Native intent views">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="graph">Graph</TabsTrigger>
      </TabsList>
      {error && (
        <div className="space-y-2 rounded-md border p-4">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" onClick={reloadPublication}>
            Reload publication
          </Button>
        </div>
      )}
      {publication && (
        <p className="text-xs text-muted-foreground">
          Current committed revision {publication.sequence} ·{' '}
          {new Date(publication.createdAt).toLocaleString()} · {publication.files.length} files
          {!projectionComplete && ' · Graph projection pending'}
        </p>
      )}
      <TabsContent value="overview" className="space-y-4">
        {!error && publication && intent.execution && (
          <NativeCompletionEvidence
            projectId={projectId}
            executionId={intentId}
            attemptId={intent.execution.attemptId}
            target={{ publicationId: publication.id, publicationSequence: publication.sequence }}
            onAccessFailure={onAccessFailure}
          />
        )}
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
              <p className="text-sm text-muted-foreground">
                This legacy question file is read-only. Replies require a supported AI-DLC response.
              </p>
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
        {!error && !publication?.question && !interactionId && (
          <p className="text-sm text-muted-foreground">
            {publication ? 'No question is included in this committed revision.' : noPublication}
          </p>
        )}
        {intent.prompt && (intent.execution || intent.promptRevision === undefined) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Request</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{intent.prompt}</p>
            </CardContent>
          </Card>
        )}
      </TabsContent>
      <TabsContent value="files">
        <WorkProductsCard
          actions={
            !error &&
            publication && (
              <NativeResultDownload
                projectId={intent.projectId}
                executionId={intent.id}
                target={{
                  publicationId: publication.id,
                  publicationSequence: publication.sequence,
                }}
                onAccessFailure={onAccessFailure}
              />
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
                      <span className="text-xs text-muted-foreground">
                        {file.role} · {file.bytes} bytes
                      </span>
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
      </TabsContent>
      <TabsContent value="graph">
        {graphError && (
          <p role="alert" className="text-sm text-destructive">
            {graphError}
          </p>
        )}
        {graph?.traceability && (
          <p className="mb-2 text-xs text-muted-foreground">
            Derived from published content. Phase and stage links describe file locations; item
            claims do not verify completion or approval.
            {(graph.traceability.relationships === 'structure_limit' ||
              graph.traceability.files.some((file) =>
                ['incompatible', 'byte_limit', 'structure_limit'].includes(file.status),
              )) &&
              ' Some files have generic or limited structure; their original content remains available in Files.'}
          </p>
        )}
        {!error &&
          !graphError &&
          (publication ? (
            projectionComplete ? (
              <div className="h-[36rem] min-h-80 overflow-hidden rounded-md border">
                <TooltipProvider>
                  <GraphCanvas
                    nodes={graph?.nodes ?? []}
                    edges={graph?.edges ?? []}
                    title="Native intent graph"
                    loading={!graph}
                    emptyState={<p>No graph nodes are included in this revision.</p>}
                    onOpenArtifact={openFile}
                    onOpenInteraction={(id) => {
                      if (interactionId === id) setTab('overview');
                    }}
                  />
                </TooltipProvider>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Files are available. Graph projection is still pending.
              </p>
            )
          ) : (
            <p className="text-sm text-muted-foreground">{noPublication}</p>
          ))}
      </TabsContent>
    </Tabs>
  );
}
