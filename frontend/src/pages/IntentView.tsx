import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  intentsService,
  type GateAnswer,
  type IntentArtifact,
  type IntentDetail,
  type IntentGate,
  type IntentSteering,
} from '@/services/intents';
import { INTENT_OUTPUT_KEY, useIntent } from '@/contexts/IntentContext';
import { useAuth } from '@/contexts/AuthContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import QuestionEditor from '@/components/QuestionEditor';
import type { Question } from '@/services/questions';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { ArtifactViewer } from '@/components/intent/ArtifactViewer';
import { artifactAccent } from '@/components/intent/artifactAccent';
import { formatDuration, useTick } from '@/components/intent/stageStyle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getTimeAgo } from '@/lib/timeAgo';
import {
  AlertTriangle,
  ChevronRight,
  Compass,
  FileText,
  Loader2,
  MoreHorizontal,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';

// The v2 intent page — main-pane content only. All fetch/realtime/output state
// lives in IntentProvider (mounted by AppShell, shared with the right-hand
// IntentActivityPanel where output/timeline/discussions render).
export default function IntentView() {
  const {
    projectId,
    intentId,
    detail,
    loading,
    error: loadError,
    gates,
    pendingGates,
    reload,
    answerGate,
    cancelIntent,
    deleteIntent,
  } = useIntent();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  // Role gate for the destructive delete (owner/admin — the API enforces it
  // too; hiding the button just avoids a guaranteed 403).
  const { project } = useProjectCache(projectId ?? null);
  const canDelete = project?.userRole === 'owner' || project?.userRole === 'admin';

  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Start (DRAFT) and restart (FAILED / stranded CREATED) share the /start
  // endpoint, which re-enters the pipeline and clears a prior failureReason.
  const handleStart = async () => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setActionError(null);
    try {
      await intentsService.start(projectId, intentId);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  // Cancel (steering): retire a parked (WAITING), stranded (CREATED) or FAILED
  // run — supersedes pending gates and flips the run to CANCELLED. RUNNING
  // cannot be cancelled mid-turn (the API 409s); the button hides for it.
  const handleCancel = async () => {
    if (!window.confirm('Cancel this run? Pending questions are retired and the run stops.')) {
      return;
    }
    setCancelling(true);
    setActionError(null);
    try {
      await cancelIntent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel intent');
    } finally {
      setCancelling(false);
    }
  };

  // Permanent delete (owner/admin): removes the intent's graph data, run
  // history and realtime docs, then returns to the project page. Refused by
  // the API while RUNNING — the button hides for it.
  const handleDelete = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await deleteIntent();
      navigate(`/project/${projectId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete intent');
      setConfirmDelete(false);
      setDeleting(false);
    }
  };

  if (!projectId || !intentId) return <div className="p-6">Intent not found</div>;
  if (loading && !detail) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (!detail) return <div className="p-6">Intent not found</div>;

  const intent = detail.intent;
  const error = actionError ?? loadError;
  const isDraft = intent.status === 'DRAFT';
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';
  const isFailed = intent.status === 'FAILED';
  // Cancellable (steering): parked, stranded, or failed — never mid-RUNNING.
  const isCancellable = ['WAITING', 'CREATED', 'FAILED'].includes(intent.status);
  // Deletable (destructive): owner/admin, any status except mid-RUNNING.
  const isDeletable = canDelete && intent.status !== 'RUNNING';
  // Pre-stage progress: before any stage row exists, init-ws lifecycle events
  // are the only signal the run is doing something (they stream into the
  // sidebar Timeline); this strip keeps the main pane from looking dead.
  const noStageRowsYet = detail.stages.length === 0;
  // Stalled detection: a CREATED run whose hand-off never reached a live
  // orchestrator strands here (init-ws should flip it to RUNNING within
  // seconds). After >2 min untouched, offer a restart instead of spinning.
  const lastTouch = intent.updatedAt ?? intent.createdAt;
  const isStalled =
    intent.status === 'CREATED' &&
    !!lastTouch &&
    Date.now() - new Date(lastTouch).getTime() > 120_000;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-lg font-bold tracking-tight truncate">{intent.title || 'Intent'}</h1>
          <Badge variant="outline" className="text-[10px]">
            {intent.status}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {intent.scope}
          </Badge>
          {isActive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse"
              aria-label="live"
            />
          )}
          <DiscussButton entityType="intent" entityTitle={intent.title || 'Intent'} />
        </div>
        <div className="flex items-center gap-2">
          {intent.source && (
            <span className="text-xs text-muted-foreground">
              {intent.source.resourceUrl ? (
                <a
                  href={intent.source.resourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  from {intent.source.resourceId}
                </a>
              ) : (
                <>from {intent.source.resourceId}</>
              )}
            </span>
          )}
          {(isCancellable || isDeletable) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Intent actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isCancellable && (
                  <DropdownMenuItem disabled={cancelling} onClick={handleCancel}>
                    <XCircle className="mr-2 h-4 w-4" />
                    {cancelling ? 'Cancelling…' : 'Cancel run'}
                  </DropdownMenuItem>
                )}
                {isDeletable && (
                  <DropdownMenuItem
                    disabled={deleting}
                    onClick={() => setConfirmDelete(true)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {deleting ? 'Deleting…' : 'Delete'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Degraded-scope note: the plan resolved with non-fatal scope-shortcut
          warnings at create (required inputs whose producer stage is out of this
          scope; per-unit sections downgraded to once-per-workflow). Informational
          only — the run proceeds; details expand on demand. */}
      {intent.planWarnings && intent.planWarnings.length > 0 && (
        <details className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Scope “{intent.scope}” runs degraded — {intent.planWarnings.length} declared input
            {intent.planWarnings.length === 1 ? '' : 's'} will not be produced in this scope
          </summary>
          <ul className="mt-2 space-y-1 pl-6 text-[12px] text-muted-foreground">
            {intent.planWarnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="list-disc">
                {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* FAILED (or a stalled CREATED hand-off): show the reason + offer a restart
          (re-runs init-ws + the plan; the /start endpoint accepts both states). */}
      {(isFailed || isStalled) && (
        <div className="rounded border border-agent-error/30 bg-agent-error/10 px-3 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-agent-error">
                <XCircle className="h-4 w-4" />
                {isFailed ? 'Run failed' : 'Run stalled — never started'}
              </div>
              {isFailed && intent.failureReason && (
                <p className="mt-1 break-words font-mono text-[12px] text-agent-error/90">
                  {intent.failureReason}
                </p>
              )}
              {isStalled && (
                <p className="mt-1 text-[12px] text-agent-error/90">
                  Workspace setup never completed. Restart to re-run it.
                </p>
              )}
            </div>
            <Button
              onClick={handleStart}
              disabled={starting}
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {starting ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        </div>
      )}

      {/* DRAFT: review + Start. The prompt is read-only — there is no update
          endpoint, so an editable field would silently discard changes. */}
      {isDraft ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Review & start</CardTitle>
            <p className="text-sm text-muted-foreground">
              Review the prompt and kick off the run. Stages execute per the workflow's plan.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Prompt</Label>
              <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {intent.prompt || '—'}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Set when the intent was created — create a new intent to change it.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="intent-branch">Branch</Label>
                <Input
                  id="intent-branch"
                  value={intent.branch ?? ''}
                  disabled
                  className="mt-1.5 font-mono text-sm"
                />
              </div>
              <div>
                <Label>Repositories</Label>
                <p className="mt-2 text-sm text-muted-foreground truncate">
                  {(intent.repos ?? []).join(', ') || '—'}
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleStart} disabled={starting} className="gap-1.5">
                {starting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {starting ? 'Starting…' : 'Start'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pending human gates (D3: one editor per pending gate) */}
          {pendingGates.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">Open questions ({pendingGates.length})</h2>
              {pendingGates.map((gate) => (
                <GateCard
                  key={gate.humanTaskId}
                  gate={gate}
                  isActiveGate={gate.humanTaskId === intent.pendingHumanTaskId}
                  projectId={projectId}
                  intentId={intentId}
                  userName={userName}
                  onAnswer={answerGate}
                />
              ))}
            </div>
          )}

          {pendingGates.length === 0 && !noStageRowsYet && isActive && <AgentProgressCard />}

          {/* Workspace setup indicator — init-ws creates no stage row, so without
              this the screen looks idle while repos clone + the anchor is created. */}
          {noStageRowsYet && isActive && (
            <div className="flex items-center gap-2 rounded-md border border-agent-running/30 bg-agent-running/[0.06] px-3 py-2 text-sm text-agent-running">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Setting up workspace (cloning repositories, preparing the run)…
            </div>
          )}

          <WorkProductsPanel detail={detail} gates={gates} />
        </>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => !deleting && setConfirmDelete(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Intent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete “{intent.title || 'this intent'}”? All of its
              artifacts, questions, discussions and run history will be permanently removed. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete Intent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live progress card — calm "agent working" presence while running with no
// pending questions. Replaces itself when questions arrive (mutually exclusive).
// ---------------------------------------------------------------------------

function AgentProgressCard() {
  const {
    detail,
    stageRows,
    stageNameOf,
    phaseNameOf,
    outputBuffers,
    outputVersion,
    ensureOutputs,
    focusOutput,
  } = useIntent();
  const intent = detail?.intent;
  const isRunning = intent?.status === 'RUNNING';
  const isWaiting = intent?.status === 'WAITING';

  const runningRow = stageRows.findLast((s) => s.state === 'RUNNING' && s.stageInstanceId);
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

  if (isWaiting) {
    return (
      <div className="rounded-lg border border-agent-waiting/30 bg-agent-waiting/[0.05] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-agent-waiting animate-pulse-subtle" />
          <span className="text-sm font-medium text-agent-waiting">Waiting</span>
          {stageName && <span className="text-xs text-muted-foreground">{stageName}</span>}
        </div>
      </div>
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
            <span className="text-sm font-medium">Agent working</span>
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

// Document heuristic: long-form markdown content (opened in the preview panel
// instead of expanded inline).
const DOCUMENT_TYPE_RE = /markdown|document|statement|research|report|notes?/i;
const MD_HEADING_RE = /^#{1,3}\s/m;

function isDocumentArtifact(a: IntentArtifact): boolean {
  if (a.artifactType && DOCUMENT_TYPE_RE.test(a.artifactType)) return true;
  const content = a.content ?? '';
  return content.length > 600 && MD_HEADING_RE.test(content);
}

interface ArtifactGroup {
  type: string;
  label: string;
  items: IntentArtifact[];
}

function humanizeType(type: string, count: number): string {
  const label = type.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (count > 1 && !label.endsWith('s')) return `${label}s`;
  return label;
}

function groupArtifacts(artifacts: IntentArtifact[]): {
  itemizedGroups: ArtifactGroup[];
  documents: IntentArtifact[];
} {
  const documents: IntentArtifact[] = [];
  const groupMap = new Map<string, IntentArtifact[]>();
  const groupOrder: string[] = [];

  for (const a of artifacts) {
    if (isDocumentArtifact(a)) {
      documents.push(a);
      continue;
    }
    const type = a.artifactType ?? 'other';
    if (!groupMap.has(type)) {
      groupMap.set(type, []);
      groupOrder.push(type);
    }
    groupMap.get(type)!.push(a);
  }

  const itemizedGroups: ArtifactGroup[] = groupOrder.map((type) => {
    const items = groupMap.get(type)!;
    return { type, label: humanizeType(type, items.length), items };
  });

  return { itemizedGroups, documents };
}

function WorkProductsPanel({ detail, gates }: { detail: IntentDetail; gates: IntentGate[] }) {
  const { openArtifactPreview } = useIntent();
  const questionGates = gates.filter((g) => g.kind === 'question');
  const steering = detail.steering ?? [];
  if (detail.artifacts.length === 0 && questionGates.length === 0 && steering.length === 0) {
    return null;
  }

  const influencedArtifactsByQuestion = new Map(
    detail.events
      .filter((ev) => ev.type === 'v2.question.answered' && ev.humanTaskId)
      .map((ev) => [ev.humanTaskId as string, ev.artifacts ?? []]),
  );

  const activeArtifacts = detail.artifacts.filter((a) => !a.supersededAt);
  const { itemizedGroups, documents } = groupArtifacts(activeArtifacts);

  const defaultValue = [
    ...itemizedGroups.map((g) => `artifact-${g.type}`),
    documents.length > 0 ? 'documents' : null,
    questionGates.length > 0 ? 'questions' : null,
  ].filter((v): v is string => Boolean(v));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Work products</CardTitle>
        <p className="text-xs text-muted-foreground">
          Artifacts, human questions and course corrections captured during this intent.
        </p>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" defaultValue={defaultValue} className="space-y-2">
          {itemizedGroups.map((group) => {
            const accent = artifactAccent(group.type);
            return (
              <AccordionItem
                key={group.type}
                value={`artifact-${group.type}`}
                className="rounded-md border px-3"
              >
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', accent.dot)} />
                    <span className="text-sm font-medium">{group.label}</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {group.items.length}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-3 pb-3">
                  {group.items.map((a) => (
                    <ArtifactViewer key={a.id} artifact={a} />
                  ))}
                </AccordionContent>
              </AccordionItem>
            );
          })}

          {documents.length > 0 && (
            <AccordionItem value="documents" className="rounded-md border px-3">
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    Document{documents.length > 1 ? 's' : ''} ({documents.length})
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-1 pb-3">
                {documents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="group/doc flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 transition-colors"
                    onClick={() => openArtifactPreview(a.id)}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{a.title || a.id}</span>
                    {a.createdAt && (
                      <span className="shrink-0 text-[11px] text-muted-foreground/60">
                        {getTimeAgo(a.createdAt)}
                      </span>
                    )}
                    <DiscussButton
                      entityType="artifact"
                      entityId={a.id}
                      entityTitle={a.title || a.id}
                      className="opacity-0 group-hover/doc:opacity-100 transition-opacity"
                    />
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 group-hover/doc:opacity-100 transition-opacity"
                    />
                  </button>
                ))}
              </AccordionContent>
            </AccordionItem>
          )}

          {questionGates.length > 0 && (
            <AccordionItem value="questions" className="rounded-md border px-3">
              <AccordionTrigger className="py-3 hover:no-underline">
                <span className="text-sm font-medium">Questions ({questionGates.length})</span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pb-3">
                {questionGates.map((gate) => (
                  <QuestionHistoryCard
                    key={gate.humanTaskId}
                    gate={gate}
                    influencedArtifacts={influencedArtifactsByQuestion.get(gate.humanTaskId) ?? []}
                  />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}

          {steering.length > 0 && (
            <AccordionItem value="steering" className="rounded-md border px-3">
              <AccordionTrigger className="py-3 hover:no-underline">
                <span className="text-sm font-medium">Course corrections ({steering.length})</span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pb-3">
                {steering.map((s) => (
                  <SteeringCard key={s.steerId} steer={s} />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </CardContent>
    </Card>
  );
}

const STEERING_KIND_LABEL: Record<IntentSteering['kind'], string> = {
  'gate-steer': 'with an answer',
  revision: 'revised answer',
  rewind: 'rewind guidance',
};

function SteeringCard({ steer }: { steer: IntentSteering }) {
  return (
    <div className="rounded-md border bg-card px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Compass className="h-3.5 w-3.5 text-agent-waiting" />
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {STEERING_KIND_LABEL[steer.kind] ?? steer.kind}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            'px-1.5 py-0 text-[10px]',
            steer.status === 'consumed'
              ? 'bg-agent-success/10 text-agent-success border-agent-success/30'
              : steer.status === 'pending'
                ? 'bg-agent-waiting/10 text-agent-waiting border-agent-waiting/30'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {steer.status === 'consumed'
            ? 'delivered'
            : steer.status === 'pending'
              ? 'queued'
              : 'superseded'}
        </Badge>
        {steer.targetStageId && (
          <span className="text-[11px] text-muted-foreground">→ {steer.targetStageId}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {steer.createdByName ? `${steer.createdByName} · ` : ''}
          {steer.createdAt ? new Date(steer.createdAt).toLocaleString() : ''}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{steer.message}</p>
    </div>
  );
}

// Map a v2 HUMAN# gate to the right editor, keyed by the intent collaboration
// scope. `question` gates render the structured QuestionEditor; approval and
// review-verdict gates render prompt + options. NOTE: the runtime currently
// only emits `question` gates — the other branches are forward-compat for the
// schema-valid kinds (lambda/shared/v2-process-keys.js HUMAN_TASK_KINDS).
// Engine-gate option → answer status (WP5 construction gates): reject-flavored
// options retire the gate as 'rejected'; approve-flavored as 'approved'; the
// rest (retry/skip/abort/autonomous/gated) are plain answers.
const engineGateStatusFor = (opt: string): GateAnswer['status'] =>
  /^reject/i.test(opt) ? 'rejected' : /^approve/i.test(opt) ? 'approved' : 'answered';

function GateCard({
  gate,
  isActiveGate,
  projectId,
  intentId,
  userName,
  onAnswer,
}: {
  gate: IntentGate;
  isActiveGate: boolean;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
}) {
  // Steering (docs/v2-steering.md): an optional course correction riding the
  // answer — injected into the resumed agent conversation right after it, so
  // the human can redirect the agent's direction while answering.
  const [steering, setSteering] = useState('');
  const question = useMemo<Question | null>(() => {
    let parsed: Question['questions'] = [];
    try {
      parsed = gate.questions ? JSON.parse(gate.questions) : [];
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return {
      id: gate.humanTaskId,
      agent: gate.stageInstanceId ?? 'agent',
      questions: parsed,
      sprintId: '',
      createdAt: gate.createdAt ?? '',
    };
  }, [gate]);

  if (gate.kind === 'review-verdict') {
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-2 py-3">
          <p className="text-sm font-medium">{gate.prompt || 'Review verdict required'}</p>
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onAnswer(gate, {
                      answer: opt,
                      status: /reject/i.test(opt) ? 'rejected' : 'answered',
                    })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => onAnswer(gate, { answer: 'approve', status: 'approved' })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAnswer(gate, { answer: 'reject', status: 'rejected' })}
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!question) {
    // A non-structured gate — the engine's construction gates (fan-out /
    // walking-skeleton / autonomy ladder / batch / halt-and-ask,
    // docs/v2-parallel.md WP5) arrive as kind 'approval' with a prompt and an
    // options array; each option submits `{ decision }` (the shape the
    // orchestrator's parseChoice consumes). Reject-flavored options retire
    // the gate as 'rejected'; approve-flavored as 'approved'.
    const options = Array.isArray(gate.options)
      ? gate.options.filter((o): o is string => typeof o === 'string')
      : [];
    return (
      <Card className={cn(isActiveGate && 'border-agent-waiting/40')}>
        <CardContent className="space-y-2 py-3">
          {gate.unitSlug && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-normal">
              unit {gate.unitSlug}
            </Badge>
          )}
          <p className="whitespace-pre-line text-sm">{gate.prompt || 'Approval required'}</p>
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              options.map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant={engineGateStatusFor(opt) === 'rejected' ? 'outline' : 'default'}
                  onClick={() =>
                    onAnswer(gate, { answer: { decision: opt }, status: engineGateStatusFor(opt) })
                  }
                >
                  {opt}
                </Button>
              ))
            ) : (
              <Button
                size="sm"
                onClick={() => onAnswer(gate, { answer: { approved: true }, status: 'approved' })}
              >
                Approve
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={cn(isActiveGate && 'ring-1 ring-agent-waiting/40 rounded-lg')}>
      <QuestionEditor
        question={question}
        scope={{ kind: 'intent', id: intentId, projectId }}
        userName={userName}
        onAnswer={(structuredAnswer) =>
          onAnswer(gate, {
            answer: structuredAnswer,
            ...(steering.trim() ? { steering: steering.trim() } : {}),
          })
        }
      />
      {/* Optional course correction delivered WITH the answer. */}
      <div className="mt-1.5 space-y-1 rounded-md border border-dashed px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Compass className="h-3 w-3" />
          Course correction (optional)
        </div>
        <Textarea
          value={steering}
          onChange={(e) => setSteering(e.target.value)}
          placeholder="Redirect the agent if it is heading the wrong way — e.g. 'Stop building the REST layer; integrate with the existing event bus instead.' Sent with your answer and overrides the agent's current plan."
          rows={2}
          className="text-xs"
        />
      </div>
    </div>
  );
}

function QuestionHistoryCard({
  gate,
  influencedArtifacts,
}: {
  gate: IntentGate;
  influencedArtifacts: { id: string; title: string }[];
}) {
  const { detail, steering, reviseGate } = useIntent();
  const questions = parseGateQuestions(gate.questions);
  const answer = formatGateAnswer(gate.answer, questions);
  const superseded = gate.status === 'superseded';
  const answered = !superseded && (gate.status !== 'pending' || Boolean(gate.answeredAt));

  // Steering revision (docs/v2-steering.md): correct an already-given answer.
  // The original stays; the correction is delivered at the next injection point.
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const revisionSteer = gate.revisionSteerId
    ? (steering.find((s) => s.steerId === gate.revisionSteerId) ?? null)
    : null;
  const intentStatus = detail?.intent.status ?? '';
  const canRevise = answered && !['SUCCEEDED', 'CANCELLED'].includes(intentStatus);

  const handleRevise = async () => {
    if (!revision.trim()) return;
    setRevising(true);
    setReviseError(null);
    try {
      await reviseGate(gate, revision.trim());
      setReviseOpen(false);
      setRevision('');
    } catch (err) {
      setReviseError(err instanceof Error ? err.message : 'Failed to revise the answer');
    } finally {
      setRevising(false);
    }
  };

  return (
    <div
      id={`question-${gate.humanTaskId}`}
      className="scroll-mt-4 rounded-md border bg-card px-3 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                'px-1.5 py-0 text-[10px]',
                superseded
                  ? 'bg-muted text-muted-foreground'
                  : answered
                    ? 'bg-agent-success/10 text-agent-success border-agent-success/30'
                    : 'bg-agent-waiting/10 text-agent-waiting border-agent-waiting/30',
              )}
            >
              {superseded ? 'superseded' : answered ? 'answered' : 'pending'}
            </Badge>
            {gate.revisedAt && (
              <Badge
                variant="outline"
                className="border-agent-waiting/30 bg-agent-waiting/10 px-1.5 py-0 text-[10px] text-agent-waiting"
              >
                revised
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              {gate.stageInstanceId || 'agent question'}
            </span>
          </div>
          {(gate.answeredByName || gate.answeredBy || gate.answeredAt) && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {gate.answeredByName || gate.answeredBy
                ? `answered by ${gate.answeredByName || gate.answeredBy}`
                : ''}
              {gate.answeredAt ? ` · ${new Date(gate.answeredAt).toLocaleString()}` : ''}
            </p>
          )}
        </div>
        <DiscussButton
          entityType="question"
          entityId={gate.humanTaskId}
          entityTitle={questions[0]?.text || 'Question'}
          className="shrink-0"
        />
      </div>

      <div className="mt-3 space-y-2">
        {questions.length > 0 ? (
          questions.map((q, idx) => (
            <div key={idx} className="rounded border bg-muted/20 px-2 py-2">
              <p className="text-sm font-medium">{q.text || `Question ${idx + 1}`}</p>
              {Array.isArray(q.options) && q.options.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Options:{' '}
                  {q.options
                    .map((o) => o.label)
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Question details unavailable.</p>
        )}

        {answered ? (
          <div className="rounded border border-agent-success/20 bg-agent-success/[0.04] px-2 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Answer
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{answer || 'Answered'}</p>
          </div>
        ) : superseded ? (
          <p className="text-xs text-muted-foreground">
            Retired unanswered when the run was cancelled or rewound.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This question is still open. Use the Open questions section above to answer it.
          </p>
        )}

        {/* An existing revision: the correction layered on the original answer. */}
        {revisionSteer && (
          <div className="rounded border border-agent-waiting/30 bg-agent-waiting/[0.05] px-2 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Correction{' '}
              {revisionSteer.status === 'consumed'
                ? '(delivered to the agent)'
                : '(queued — delivered at the next stage boundary)'}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{revisionSteer.message}</p>
          </div>
        )}

        {canRevise && !reviseOpen && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => setReviseOpen(true)}
          >
            <Compass className="h-3 w-3" />
            Revise answer
          </Button>
        )}
        {canRevise && reviseOpen && (
          <div className="space-y-2 rounded-md border border-agent-waiting/40 bg-agent-waiting/[0.04] p-2">
            <p className="text-[11px] text-muted-foreground">
              The original answer stays on record; your correction reaches the agent at its next
              deterministic point (question resume or stage start) and overrides the old answer.
            </p>
            <Textarea
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="What should the agent do differently?"
              rows={2}
              className="text-xs"
            />
            {reviseError && <p className="text-[11px] text-agent-error">{reviseError}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={!revision.trim() || revising}
                onClick={handleRevise}
              >
                {revising ? 'Sending…' : 'Send correction'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                disabled={revising}
                onClick={() => {
                  setReviseOpen(false);
                  setReviseError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {influencedArtifacts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">Influenced artifacts:</span>
            {influencedArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  document
                    .getElementById(`artifact-${artifact.id}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {artifact.title || artifact.id}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function parseGateQuestions(raw: string | null): Question['questions'] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatGateAnswer(answer: unknown, questions: Question['questions']): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer !== 'object') return String(answer);
  // Engine-gate answers (WP5 construction gates): a single decision word.
  const decision = (answer as { decision?: unknown }).decision;
  if (typeof decision === 'string') return decision;
  const structured = answer as { answers?: { selectedOptions?: unknown[]; freeText?: string }[] };
  if (Array.isArray(structured.answers)) {
    return structured.answers
      .map((a, idx) => {
        const selected = Array.isArray(a.selectedOptions)
          ? a.selectedOptions
              .map((opt) => {
                const optionIndex = typeof opt === 'number' ? opt : Number(opt);
                return Number.isInteger(optionIndex)
                  ? (questions[idx]?.options?.[optionIndex]?.label ?? String(opt))
                  : String(opt);
              })
              .join(', ')
          : '';
        const free = a.freeText?.trim() ?? '';
        const response = [selected, free].filter(Boolean).join(' · ');
        return response ? `Q${idx + 1}: ${response}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(answer);
}
