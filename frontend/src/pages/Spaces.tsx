import { createElement, useState, useMemo } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { projectsService } from '@/services/projects';
import {
  useProjectsCache,
  projectLastActivityAt,
  type ProjectWithSprint,
} from '@/hooks/useProjectsCache';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { GitRepoLink } from '@/components/GitRepoLink';
import { Card, CardContent } from '@/components/ui/card';
import { RowActions } from '@/components/RowActions';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { RelativeTime } from '@/components/ui/relative-time';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  Plus,
  Trash2,
  FolderGit2,
  Search,
  LayoutGrid,
  List,
  ArrowUpDown,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePanelsInline } from '@/hooks/usePanelsInline';
import { PageHeader } from '@/components/ui/page-header';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TONE_CLASSES, type StatusTone } from '@/lib/statusModel';
import {
  deriveSpaceSignals,
  hasOpenWork,
  plural,
  type SpaceSignals,
} from '@/components/space/spaceSignals';
import {
  useProjectSort,
  projectComparator,
  projectAttentionRank,
  PROJECT_SORT_LABELS,
  type ProjectSort,
} from '@/hooks/useProjectSort';

// Filter values the Space page understands (`/space/:id?filter=…`);
// `needs-attention` covers questions, resumes, failures and stalled runs.
const SPACE_FILTER = {
  attention: 'needs-attention',
  failed: 'failed',
} as const;

// min-h-6: the pill is a link, so it keeps a 24 px target (R5-20).
const pillClass =
  'relative z-10 inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium';

function SignalPill({
  tone,
  to,
  children,
  hint,
}: {
  tone: StatusTone;
  to?: string;
  children: React.ReactNode;
  hint: string;
}) {
  const className = cn(
    pillClass,
    TONE_CLASSES[tone].pill,
    to &&
      'hover:ring-1 hover:ring-current/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  );
  const dot = <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {to ? (
            <Link to={to} className={className}>
              {dot}
              {children}
            </Link>
          ) : (
            <span tabIndex={0} className={cn(className, 'cursor-default')}>
              {dot}
              {children}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SpaceSignalPills({ projectId, signals }: { projectId: string; signals: SpaceSignals }) {
  if (!hasOpenWork(signals)) {
    return (
      <span className="text-muted-foreground" aria-label="No open work">
        —
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {signals.questions > 0 && (
        <SignalPill
          tone="waiting"
          to={`/space/${projectId}?filter=${SPACE_FILTER.attention}`}
          hint="Questions, reviews or resumes waiting for someone. Open the space filtered to them."
        >
          {plural(signals.questions, 'question')}
        </SignalPill>
      )}
      {signals.failed > 0 && (
        <SignalPill
          tone="danger"
          to={`/space/${projectId}?filter=${SPACE_FILTER.failed}`}
          hint="Runs that stopped on an error. Open the space filtered to them."
        >
          {plural(signals.failed, 'failed', 'failed')}
        </SignalPill>
      )}
      {signals.stalled > 0 && (
        <SignalPill
          tone="warning"
          to={`/space/${projectId}?filter=${SPACE_FILTER.attention}`}
          hint="Runs marked as running but with no recorded progress for over 30 minutes. Open the space filtered to them."
        >
          {plural(signals.stalled, 'stalled', 'stalled')}
        </SignalPill>
      )}
      {signals.running > 0 && (
        <SignalPill tone="running" hint="Agents currently working.">
          {plural(signals.running, 'running', 'running')}
        </SignalPill>
      )}
    </span>
  );
}

function SpaceActions({
  project,
  onDelete,
}: {
  project: { id: string; name: string };
  onDelete: () => void;
}) {
  return (
    <RowActions label={`Actions for space ${project.name}`}>
      <DropdownMenuItem asChild>
        <Link to={`/space/${project.id}/settings`}>Space settings</Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
        <Trash2 className="h-4 w-4" />
        Delete space
      </DropdownMenuItem>
    </RowActions>
  );
}

function RoleBadge({ role }: { role: ProjectWithSprint['project']['userRole'] }) {
  if (!role || role === 'owner') return null;
  return (
    <Badge variant="outline" size="sm" className="font-medium text-muted-foreground">
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </Badge>
  );
}

function LegacyBadge() {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            size="sm"
            tabIndex={0}
            className="cursor-default font-medium text-muted-foreground"
          >
            Legacy
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          Created with v1 — this space is view-only. New work uses v2 intents.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SpacesSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading spaces"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <span className="sr-only">Loading spaces</span>
      <div className="h-9 border-b bg-muted/40" />
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b px-3 py-3 last:border-b-0">
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="ml-auto hidden h-4 w-28 sm:block" />
          <Skeleton className="hidden h-4 w-14 md:block" />
        </div>
      ))}
    </div>
  );
}

type DashboardProject = ProjectWithSprint['project'] & {
  lastActivityAt: string | null;
  attentionRank: number;
  hasActiveWork: boolean;
  signals: SpaceSignals;
};

const projectDate = (p: DashboardProject, sortBy: ProjectSort) =>
  sortBy === 'created' ? p.createdAt : p.lastActivityAt;

function spaceColumns(sortBy: ProjectSort, now: number): DataTableColumn<DashboardProject>[] {
  return [
    {
      id: 'name',
      header: 'Space',
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <FolderGit2
            aria-hidden="true"
            className="hidden h-4 w-4 shrink-0 text-muted-foreground @[34rem]:block"
          />
          <span className="min-w-0">
            <span className="block break-words">{p.name}</span>
            {p.kind !== 'v2' && (
              <span className="block text-xs font-normal text-muted-foreground">
                Legacy · read-only
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Work status',
      width: '30%',
      cell: (p) => <SpaceSignalPills projectId={p.id} signals={p.signals} />,
    },
    {
      id: 'repo',
      header: 'Repository',
      width: '28%',
      hideBelow: 'md',
      cell: (p) =>
        p.gitRepo ? (
          <GitRepoLink
            gitRepo={p.gitRepo}
            gitProvider={p.gitProvider}
            className="text-xs text-muted-foreground"
            noLink
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'date',
      header: sortBy === 'created' ? 'Created' : 'Last activity',
      width: '7.5rem',
      hideBelow: 'sm',
      cell: (p) => (
        <RelativeTime
          value={projectDate(p, sortBy)}
          className="text-xs text-muted-foreground"
          now={now}
        />
      ),
    },
  ];
}

function SpaceRowActions({
  project,
  deleting,
  onDelete,
}: {
  project: DashboardProject;
  deleting: boolean;
  onDelete: (projectId: string) => void;
}) {
  if (deleting) {
    return <Loader2 aria-label="Deleting space" className="mx-auto h-4 w-4 animate-spin" />;
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <RoleBadge role={project.userRole} />
      {project.userRole === 'owner' && (
        <SpaceActions project={project} onDelete={() => onDelete(project.id)} />
      )}
    </span>
  );
}

// The list of spaces is a page only where the sidebar does not list them
// (narrow screens, drawer). On large screens the route sends the reader to My
// work, keeping the query so a `?reopenCreateSpace=1` link still opens the
// shell's Create space dialog there.
export default function SpacesRoute() {
  const panelsInline = usePanelsInline();
  const { search } = useLocation();
  if (panelsInline) return <Navigate to={{ pathname: '/dashboard', search }} replace />;
  return <Spaces />;
}

function Spaces() {
  const { projects: portfolio, loading, error, refresh, invalidate } = useProjectsCache();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('aidlc-spaces-view') === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  function changeView(mode: 'grid' | 'list') {
    setViewMode(mode);
    try {
      localStorage.setItem('aidlc-spaces-view', mode);
    } catch {
      // The current visit still honors the choice when storage is unavailable.
    }
  }
  // Shared with the sidebar project list (useProjectSort store) — changing the
  // sort here re-orders both views.
  const [sortBy, changeSort] = useProjectSort();

  // The portfolio re-renders on every 30 s poll, so one clock per render is
  // enough for ages and the stall rule.
  const now = Date.now();

  const projects = useMemo<DashboardProject[]>(
    () =>
      portfolio.map((p) => {
        const signals = deriveSpaceSignals(p.intents, now);
        return {
          ...p.project,
          lastActivityAt: projectLastActivityAt(p),
          attentionRank: projectAttentionRank(p.intents),
          // The delete dialog warns when live or parked work will be cancelled.
          hasActiveWork: hasOpenWork({ ...signals, failed: 0 }),
          signals,
        };
      }),
    [portfolio, now],
  );

  const openCreate = () => setShowCreateModal(true);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleteError(null);
    setDeleting(confirmDelete);
    try {
      await projectsService.delete(confirmDelete);
      invalidate();
      setConfirmDelete(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'The space could not be deleted. Try again.',
      );
    } finally {
      setDeleting(null);
    }
  };

  const filteredProjects = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.gitRepo?.toLowerCase().includes(q),
    );
    return filtered.toSorted(projectComparator(sortBy));
  }, [projects, searchQuery, sortBy]);

  // Whether the project pending delete confirmation has live/parked work, so the
  // dialog can warn that deleting will cancel it.
  const confirmDeleteHasActiveWork = useMemo(
    () => !!confirmDelete && !!projects.find((p) => p.id === confirmDelete)?.hasActiveWork,
    [confirmDelete, projects],
  );

  const requestDelete = (projectId: string) => {
    setDeleteError(null);
    setConfirmDelete(projectId);
  };

  const dateColumn = sortBy === 'created' ? 'Created' : 'Last activity';
  const columns = useMemo(() => spaceColumns(sortBy, now), [sortBy, now]);
  const renderRowActions = (p: DashboardProject) =>
    createElement(SpaceRowActions, {
      project: p,
      deleting: deleting === p.id,
      onDelete: requestDelete,
    });

  return (
    <div className="h-full">
      <div>
        <PageHeader
          title="Spaces"
          className="mb-6"
          primaryAction={
            projects.length > 0 || loading || error ? (
              <Button onClick={openCreate} className="shrink-0 gap-2">
                <Plus className="h-4 w-4" />
                New space
              </Button>
            ) : undefined
          }
        />

        {projects.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-36 max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search spaces"
                placeholder="Search spaces..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
            <Select value={sortBy} onValueChange={(v) => changeSort(v as ProjectSort)}>
              <SelectTrigger aria-label="Sort spaces" className="h-9 w-auto gap-1.5 sm:w-60">
                <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PROJECT_SORT_LABELS) as ProjectSort[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {PROJECT_SORT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="hidden items-center rounded-md border sm:flex">
              <Button
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8 rounded-r-none"
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                onClick={() => changeView('list')}
              >
                <List className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8 rounded-l-none"
                aria-label="Grid view"
                aria-pressed={viewMode === 'grid'}
                onClick={() => changeView('grid')}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <SpacesSkeleton />
        ) : error && projects.length === 0 ? (
          <ErrorState
            headingLevel={2}
            title="Couldn't load spaces"
            description={error}
            onRetry={() => refresh()}
          />
        ) : projects.length === 0 ? (
          <EmptyState
            headingLevel={2}
            icon={FolderGit2}
            title="No spaces yet"
            description="A space connects a repository to a workflow so your team can run intents on it."
            action={
              <Button onClick={openCreate} className="gap-2">
                <Plus className="h-4 w-4" />
                Create your first space
              </Button>
            }
          />
        ) : filteredProjects.length === 0 ? (
          <EmptyState
            headingLevel={2}
            size="section"
            title={`No spaces match "${searchQuery}"`}
            action={
              <Button variant="outline" size="sm" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            }
          />
        ) : viewMode === 'grid' ? (
          /* Grid view */
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => {
              const isDeleting = deleting === project.id;
              return (
                <Card
                  key={project.id}
                  aria-busy={isDeleting}
                  className={cn(
                    'group relative transition-all',
                    isDeleting
                      ? 'pointer-events-none opacity-50'
                      : 'hover:border-foreground/20 hover:shadow-md',
                  )}
                >
                  <CardContent className="p-5">
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <FolderGit2 className="h-4.5 w-4.5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold">
                            {isDeleting ? (
                              project.name
                            ) : (
                              <Link
                                to={`/space/${project.id}`}
                                className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                              >
                                {project.name}
                              </Link>
                            )}
                          </h3>
                          {(project.kind !== 'v2' || (project.userRole ?? 'owner') !== 'owner') && (
                            <div className="relative z-10 mt-1 flex items-center gap-1">
                              <RoleBadge role={project.userRole} />
                              {project.kind !== 'v2' && <LegacyBadge />}
                            </div>
                          )}
                        </div>
                      </div>
                      {isDeleting ? (
                        <Loader2
                          aria-label="Deleting space"
                          className="h-4 w-4 shrink-0 animate-spin text-destructive"
                        />
                      ) : (
                        project.userRole === 'owner' && (
                          <SpaceActions
                            project={project}
                            onDelete={() => requestDelete(project.id)}
                          />
                        )
                      )}
                    </div>

                    {project.gitRepo && (
                      <div className="mb-2 text-xs text-muted-foreground">
                        <GitRepoLink
                          gitRepo={project.gitRepo}
                          gitProvider={project.gitProvider}
                          noLink
                        />
                      </div>
                    )}

                    {hasOpenWork(project.signals) && (
                      <div className="mb-2.5">
                        <SpaceSignalPills projectId={project.id} signals={project.signals} />
                      </div>
                    )}

                    <div className="text-xs text-muted-foreground">
                      <RelativeTime
                        value={projectDate(project, sortBy)}
                        prefix={dateColumn}
                        now={now}
                        className="relative z-10"
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <DataTable
            aria-label="Spaces"
            columns={columns}
            rows={filteredProjects}
            getRowId={(p) => p.id}
            rowHref={(p) => `/space/${p.id}`}
            rowLabel={(p) => p.name}
            rowClassName={(p) => (deleting === p.id ? 'opacity-50' : undefined)}
            rowActions={renderRowActions}
          />
        )}
      </div>

      {/* Create modal */}
      {showCreateModal && (
        <CreateProjectModal onClose={() => setShowCreateModal(false)} onCreated={refresh} />
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={() => (deleting ? null : setConfirmDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete space</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this space? This action cannot be undone. Every intent
              — with all of its artifacts, questions, discussions, run history and usage metrics —
              will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmDeleteHasActiveWork && (
            <Alert tone="warning">
              This space has running or waiting work. Deleting it will cancel that work before
              removing everything.
            </Alert>
          )}
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={!!deleting}
            >
              {deleting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Deleting…
                </span>
              ) : (
                'Delete space'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
