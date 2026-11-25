import { useSpacePermissions } from '@/contexts/SpacePermissionsContext';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router';
import { usePanelsInline, spacesHomePath } from '@/hooks/usePanelsInline';
import { formatAbsolute } from '@/lib/timeAgo';
import { useProjectCache, useProjectSprintsCache, useSpaceIntents } from '@/hooks/useProjectsCache';
import { type Project as ProjectType } from '@/services/projects';
import { type Sprint } from '@/services/sprints';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { RelativeTime } from '@/components/ui/relative-time';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/empty-state';
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
  FolderGit2,
  ChevronRight,
  Plus,
  Settings,
  Archive,
  RotateCw,
  Sparkles,
} from 'lucide-react';
import { GitRepoLink } from '@/components/GitRepoLink';
import { effectiveSprintStatus } from '@/lib/sprintStatus';
import { intentsService, type Intent } from '@/services/intents';
import { displayPhase, humanizeSlug } from '@/lib/displayNames';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import { useQuery } from '@tanstack/react-query';
import { IntentList } from '@/components/space/IntentList';
import { SpaceActivityCost } from '@/components/space/SpaceActivityCost';
import { intentRowTitle } from '@/components/space/IntentRow';
import { cancelConfirmationCopy } from '@/components/intent/IntentActionsMenu';
import { SpaceIntentActions } from '@/components/space/SpaceIntentActions';
import { intentGroup, parseSpaceFilter, type SpaceFilter } from '@/components/space/intentGrouping';

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const navigate = useNavigate();
  const spacesHome = spacesHomePath(usePanelsInline());
  const {
    project,
    loading: projectLoading,
    error: projectError,
    refresh: refreshProject,
  } = useProjectCache(projectId ?? null);
  const { sprints, loading: historyLoading } = useProjectSprintsCache(
    project && project.kind !== 'v2' ? project.id : null,
  );

  const latestSprint = sprints[0] ?? null;
  if (!projectId) return <div className="p-6">Space not found</div>;

  if (!project && projectLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (!project && projectError) {
    return (
      <div className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Couldn't load this space</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          The space list could not be loaded. Check your connection and try again.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => void refreshProject()} className="gap-2">
            <RotateCw className="h-4 w-4" />
            Retry
          </Button>
          <Button asChild variant="outline">
            <Link to={spacesHome}>
              {spacesHome === '/dashboard' ? 'Back to My work' : 'Back to spaces'}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Space not found</h1>
        <p className="text-sm text-muted-foreground">
          This space may have been removed, or you may no longer have access to it.
        </p>
        <Button asChild variant="outline">
          <Link to={spacesHome}>
            {spacesHome === '/dashboard' ? 'Back to My work' : 'Back to spaces'}
          </Link>
        </Button>
      </div>
    );
  }

  // v2 projects run intents (dynamic phases/stages), not the fixed sprint
  // lifecycle — render the dedicated intents view.
  if (project.kind === 'v2') {
    return (
      <IntentsView key={projectId} project={project} projectId={projectId} onNavigate={navigate} />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <FolderGit2 className="h-5 w-5 text-primary shrink-0" />
          <h1 className="text-lg font-bold tracking-tight truncate">{project.name}</h1>
          <Badge variant="outline" className="gap-1 text-2xs shrink-0">
            <Archive className="h-2.5 w-2.5" />
            v1 · read-only
          </Badge>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        This is a v1 space. The v1 sprint lifecycle has been retired — existing sprints, artifacts,
        and agent history remain viewable, but nothing new can be created or executed here. New work
        happens in v2 spaces (intents).
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {project.gitRepo && (
          <GitRepoLink gitRepo={project.gitRepo} gitProvider={project.gitProvider} />
        )}
        {latestSprint?.branch && <span>Last recorded branch: {latestSprint.branch}</span>}
        {project.createdAt && <RelativeTime prefix="Created" value={project.createdAt} />}
      </div>
      <div className="grid gap-6">
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 min-h-7">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">Iterations</CardTitle>
                {sprints.length > 0 && (
                  <Badge variant="secondary" className="text-2xs h-5">
                    {sprints.length}
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 space-y-4 pt-0">
            {sprints.length > 0 && (
              <div className="space-y-2">
                {(expandedHistory === projectId ? sprints : sprints.slice(0, 10)).map((sprint) => (
                  <SprintRow key={sprint.id} sprint={sprint} projectId={projectId} />
                ))}
              </div>
            )}
            {sprints.length > 10 && (
              <Button
                variant="link"
                size="sm"
                aria-expanded={expandedHistory === projectId}
                onClick={() => setExpandedHistory(expandedHistory === projectId ? null : projectId)}
              >
                {expandedHistory === projectId
                  ? 'Show first 10 iterations'
                  : `Show all ${sprints.length} iterations`}
              </Button>
            )}
            {historyLoading && !sprints.length && (
              <p className="text-sm text-muted-foreground" role="status">
                Loading iteration history…
              </p>
            )}
            {!historyLoading && sprints.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center">
                <p className="text-sm text-muted-foreground">No iterations</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  This v1 space is read-only — sprints can no longer be created.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const SPRINT_STATUS_PILL: Record<
  Exclude<ReturnType<typeof effectiveSprintStatus>, 'idle'>,
  { kind: 'intent' | 'stage'; status: string }
> = {
  running: { kind: 'intent', status: 'RUNNING' },
  waiting: { kind: 'intent', status: 'WAITING' },
  completed: { kind: 'stage', status: 'SUCCEEDED' },
  passed: { kind: 'intent', status: 'SUCCEEDED' },
  failed: { kind: 'intent', status: 'FAILED' },
};

function SprintRow({ sprint, projectId }: { sprint: Sprint; projectId: string }) {
  const status = effectiveSprintStatus(sprint);
  const phaseRoute =
    sprint.phase === 'CONSTRUCTION' ? '/construction' : sprint.phase === 'REVIEW' ? '/review' : '';
  return (
    <Link
      to={`/space/${projectId}/sprint/${sprint.id}${phaseRoute}`}
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 hover:bg-accent/50 focus-visible:outline-ring"
    >
      <span className="min-w-0">
        <span className="block break-words text-sm font-medium">{sprint.name}</span>
        <span className="text-xs text-muted-foreground">
          {sprint.createdAt ? (
            <time dateTime={sprint.createdAt}>
              Created {formatAbsolute(sprint.createdAt, { includeTime: false })}
            </time>
          ) : null}
          {sprint.prUrl && ' · Pull request recorded'}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
        <span>{displayPhase(sprint.phase.toLowerCase())}</span>
        {status !== 'idle' && (
          <span className="inline-flex items-center gap-1">
            <span className="sr-only">Last status: </span>
            <StatusPill
              kind={SPRINT_STATUS_PILL[status].kind}
              status={SPRINT_STATUS_PILL[status].status}
            />
          </span>
        )}
      </span>
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

// ── v2 projects: intents list + create ──

const API_INTENT_CAP = 100;

function IntentsView({
  project,
  projectId,
  onNavigate,
}: {
  project: ProjectType;
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const { intents, loading, error, updatedAt, refresh } = useSpaceIntents(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseSpaceFilter(searchParams.get('filter'));
  const setFilter = useCallback(
    (next: SpaceFilter) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (next === 'all') params.delete('filter');
          else params.set('filter', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // The list endpoint caps at 100 rows grouped by status, so a busy space may
  // omit older pending decisions: fetch WAITING separately only in that case.
  const capped = (intents?.length ?? 0) >= API_INTENT_CAP;
  const waiting = useQuery<Intent[]>({
    queryKey: [...qk.projectIntents(projectId), 'status', 'WAITING'],
    gcTime: 5 * 60_000,
    queryFn: ({ signal }) => intentsService.list(projectId, 'WAITING', { signal }),
    enabled: capped,
  });
  // Keep the supplement as fresh as the main list: whenever the main list is
  // re-read (portfolio poll, invalidation), re-read WAITING too. The first
  // version seen is covered by the query's own mount fetch.
  const refetchWaiting = waiting.refetch;
  const syncedListVersion = useRef<number | null>(null);
  useEffect(() => {
    if (!capped || updatedAt === null || syncedListVersion.current === updatedAt) return;
    const firstSeen = syncedListVersion.current === null;
    syncedListVersion.current = updatedAt;
    if (!firstSeen) void refetchWaiting();
  }, [capped, updatedAt, refetchWaiting]);
  const allIntents = useMemo(() => {
    if (!intents) return undefined;
    if (!capped || !waiting.data) return intents;
    const byId = new Map(intents.map((intent) => [intent.id, intent]));
    for (const intent of waiting.data) if (!byId.has(intent.id)) byId.set(intent.id, intent);
    return [...byId.values()];
  }, [intents, capped, waiting.data]);

  const [retrying, setRetrying] = useState(false);
  const retryIntents = async () => {
    setRetrying(true);
    try {
      await Promise.all([refresh(), capped ? refetchWaiting() : undefined]);
    } finally {
      setRetrying(false);
    }
  };

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDeleteIntent, setConfirmDeleteIntent] = useState<Intent | null>(null);
  const [deletingIntent, setDeletingIntent] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmCancelIntent, setConfirmCancelIntent] = useState<Intent | null>(null);
  const [cancellingIntent, setCancellingIntent] = useState<string | null>(null);
  const { readOnly, canManage } = useSpacePermissions();
  const isOwner = canManage ?? project.userRole === 'owner';
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;

  const handleDeleteIntent = async () => {
    if (!confirmDeleteIntent) return;
    const target = confirmDeleteIntent;
    setDeletingIntent(target.id);
    setDeleteError(null);
    try {
      await intentsService.delete(projectId, target.id);
      setConfirmDeleteIntent(null);
      queryClient.removeQueries({ queryKey: ['intent', projectId, target.id] });
      void queryClient.invalidateQueries({ queryKey: qk.projectIntents(projectId) });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete intent');
    } finally {
      setDeletingIntent(null);
    }
  };

  const handleCancelIntent = async () => {
    if (!confirmCancelIntent) return;
    const target = confirmCancelIntent;
    setCancellingIntent(target.id);
    setCancelError(null);
    try {
      await intentsService.cancel(projectId, target.id);
      setConfirmCancelIntent(null);
      void queryClient.invalidateQueries({ queryKey: qk.intentDetail(projectId, target.id) });
      void queryClient.invalidateQueries({ queryKey: qk.projectIntents(projectId) });
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Failed to cancel the run');
    } finally {
      setCancellingIntent(null);
    }
  };

  const newIntentPath = `/space/${projectId}/intent/new`;
  const settingsPath = `/space/${projectId}/settings`;
  const cancelCopy = cancelConfirmationCopy({
    status: confirmCancelIntent?.status ?? 'WAITING',
    title: confirmCancelIntent ? intentRowTitle(confirmCancelIntent) : null,
  });
  const rowActions = (intent: Intent) => (
    <SpaceIntentActions
      projectId={projectId}
      intent={intent}
      canDelete={isOwner}
      disabled={deletingIntent === intent.id || cancellingIntent === intent.id}
      onCancel={
        readOnly
          ? undefined
          : (target) => {
              setCancelError(null);
              setConfirmCancelIntent(target);
            }
      }
      onDelete={(target) => {
        setDeleteError(null);
        setConfirmDeleteIntent(target);
      }}
    />
  );
  // The primary action lives in the empty state when nothing is live, so the
  // page never shows two "New intent" buttons.
  const nothingLive =
    filter === 'all' &&
    allIntents !== undefined &&
    allIntents.every((intent) => intentGroup(intent) === 'finished');
  const newIntentButton = (
    <Button disabled={readOnly} onClick={() => onNavigate(newIntentPath)} className="gap-1.5">
      <Plus aria-hidden="true" />
      New intent
    </Button>
  );
  // The workflow's name, never "Default": the default workflow has one too.
  const workflowLabel =
    project.workflowId && project.workflowId !== 'aidlc-v2'
      ? humanizeSlug(project.workflowId)
      : 'AI-DLC v2';

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {project.gitRepo && (
              <GitRepoLink
                gitRepo={project.gitRepo}
                gitProvider={project.gitProvider}
                className="text-sm text-muted-foreground hover:text-foreground"
                iconClassName="h-3.5 w-3.5"
              />
            )}
            <span className="truncate" data-testid="space-workflow">
              Workflow <span aria-hidden="true">·</span> {workflowLabel}
              {project.workflowVersion != null && ` v${project.workflowVersion}`}
            </span>
          </span>
        }
        primaryAction={
          <>
            <Button asChild variant="outline" className="gap-1.5">
              <Link to={settingsPath}>
                <Settings aria-hidden="true" />
                {isOwner ? 'Settings' : 'View settings'}
              </Link>
            </Button>
            {nothingLive ? null : newIntentButton}
          </>
        }
      />

      <section aria-labelledby="space-intents-heading" className="space-y-3">
        <h2 id="space-intents-heading" className="sr-only">
          Intents
        </h2>
        {errorMessage && allIntents && (
          <Alert
            tone="danger"
            live
            title="Couldn't refresh intents"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void retryIntents()}
                loading={retrying}
              >
                <RotateCw aria-hidden="true" />
                Retry
              </Button>
            }
          >
            Showing the last loaded list. {errorMessage}
          </Alert>
        )}
        {allIntents === undefined && loading ? (
          <LoadingState label="Loading intents" lines={4} />
        ) : allIntents === undefined ? (
          <ErrorState
            live
            size="section"
            title="Couldn't load intents"
            description="The list could not be retrieved, so this space may not be empty."
            onRetry={() => void retryIntents()}
            retrying={retrying}
          />
        ) : allIntents.length === 0 ? (
          <EmptyState
            size="section"
            icon={Sparkles}
            title="No intents yet"
            description="Describe what you want to build; the AI-DLC workflow takes it from there."
            action={newIntentButton}
          />
        ) : (
          <>
            <IntentList
              projectId={projectId}
              intents={allIntents}
              filter={filter}
              onFilterChange={setFilter}
              rowActions={rowActions}
              deletingId={deletingIntent}
              idleAction={newIntentButton}
            />
            {capped && (
              <p
                className="text-center text-xs text-muted-foreground"
                data-testid="intent-api-cap-notice"
              >
                Showing the first {API_INTENT_CAP} intents returned by the space, plus any
                additional waiting intents loaded.
              </p>
            )}
          </>
        )}
      </section>

      {allIntents && allIntents.length > 0 && (
        <SpaceActivityCost projectId={projectId} intents={allIntents} canSeeCost={isOwner} />
      )}

      <AlertDialog
        open={!!confirmCancelIntent}
        onOpenChange={(open) => {
          if (!open && !cancellingIntent) setConfirmCancelIntent(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{cancelCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{cancelCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {cancelError && (
            <p role="alert" className="text-sm text-destructive">
              {cancelError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!cancellingIntent}>{cancelCopy.keep}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void handleCancelIntent();
              }}
              disabled={!!cancellingIntent}
            >
              {cancellingIntent ? 'Cancelling…' : cancelCopy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!confirmDeleteIntent}
        onOpenChange={(open) => {
          if (!open && !deletingIntent) setConfirmDeleteIntent(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete intent</AlertDialogTitle>
            <AlertDialogDescription>
              “{confirmDeleteIntent ? intentRowTitle(confirmDeleteIntent) : 'This intent'}” and all
              of its artifacts, questions, discussions and run history will be permanently removed.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingIntent}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteIntent();
              }}
              disabled={!!deletingIntent}
            >
              {deletingIntent ? 'Deleting…' : 'Delete intent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
