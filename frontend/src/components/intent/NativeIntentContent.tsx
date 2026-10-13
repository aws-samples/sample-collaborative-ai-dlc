import { useCallback, useEffect, useRef, useState } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { WorkProductsCard } from './WorkProductsCard';
import { NativeInteractionPanel, useNativeReply } from './NativeInteractionPanel';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { nativeArtifactRevisionId } from '@/lib/nativeCollaboration';
import { nativeGraphMatchesPublication } from '@/lib/nativeTraceability';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getNativeListing, nativeAccessDenied } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import {
  nativeIntentsService,
  type NativeFileContent,
  type NativeGraph,
  type NativeIntent,
  type NativeInteractionView,
  type NativePublication,
  type NativePublishedFile,
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
  // Each head owns its requests and memory. A newer publication cannot inherit
  // a file, graph, selection or late response from the previous revision.
  return (
    <NativePublicationContent
      key={JSON.stringify([
        intent.projectId,
        intent.id,
        intent.execution?.publicationId,
        intent.execution?.interactionId,
      ])}
      intent={intent}
      onAccessFailure={onAccessFailure}
      onRefresh={onRefresh}
    />
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
  const [files, setFiles] = useState<Record<string, NativeFileContent>>({});
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
        <WorkProductsCard>
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

function NativeFileView({
  file,
  descriptor,
  createdAt,
  publicationSequence,
}: {
  file: NativeFileContent;
  descriptor: NativePublishedFile;
  createdAt: string;
  publicationSequence: number;
}) {
  const markdown = file.mediaType.split(';')[0] === 'text/markdown' || /\.md$/i.test(file.path);
  return (
    <section className="min-w-0 space-y-2" aria-label={`File ${file.path}`}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 break-all text-sm font-medium">{file.path}</h3>
        {/* Discussion and Quorum are bound to these exact verified bytes. */}
        <DiscussButton
          entityType="artifact"
          entityId={nativeArtifactRevisionId(file.id, file.sha256)}
          entityTitle={file.path}
          publicationId={file.publicationId}
          publicationSequence={publicationSequence}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{descriptor.role}</Badge>
        <span>
          {file.bytes} bytes · {file.mediaType}
        </span>
        <span title={file.sha256}>SHA-256 {file.sha256.slice(0, 12)}…</span>
      </div>
      {file.encoding === 'base64' ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          Binary file. Preview is not available. This file is preserved in the committed revision.
        </p>
      ) : markdown ? (
        <ArtifactViewer
          readOnly
          artifact={{
            id: file.id,
            title: file.path,
            artifactType: descriptor.role,
            content: file.content,
            createdAt,
            createdByExecutionId: null,
            createdByStageInstanceId: null,
          }}
        />
      ) : (
        <pre className="max-h-[36rem] overflow-auto rounded-md border bg-muted/30 p-4 text-xs">
          <code>{file.content}</code>
        </pre>
      )}
    </section>
  );
}
