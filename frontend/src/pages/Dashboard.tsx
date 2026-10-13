import { isGitProvider } from '@/services/gitProvider';
import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { projectsService } from '@/services/projects';
import { useProjectsCache, projectLastActivityAt } from '@/hooks/useProjectsCache';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { GitRepoLink } from '@/components/GitRepoLink';
import type { GitProvider } from '@/services/gitProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
  RefreshCw,
  ArrowUpDown,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useProjectSort,
  projectComparator,
  PROJECT_SORT_LABELS,
  type ProjectSort,
} from '@/hooks/useProjectSort';
import {
  getNativeListing,
  nativeProjectDeleteReason,
  refreshNativeIntents,
  type NativeListing,
} from '@/hooks/useNativeIntents';
import { discoveryPath, nativeIntentTitle, nativeIntentStatusLabel } from '@/lib/intentDiscovery';

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// UX-002: a single per-project lifecycle badge. Shows green in-progress count
// only — Space-level attention (amber) indicators are removed per UX decision;
// attention signals are surfaced at the individual Intent level instead.
function ProjectSignals({ activity }: { activity: { inProgress: number; attention: number } }) {
  if (activity.inProgress === 0) return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
      )}
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{activity.inProgress} in progress</span>
    </span>
  );
}

function NativeDiscovery({ projectId, listing }: { projectId: string; listing?: NativeListing }) {
  const navigate = useNavigate();
  if (!listing) return null;
  const latest = listing.items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return (
    <div className="my-2 text-xs" onClick={(event) => event.stopPropagation()}>
      {latest && (
        <button
          className="text-left"
          aria-label={`Native ${nativeIntentTitle(latest)}: ${nativeIntentStatusLabel(latest)}`}
          onClick={() => navigate(discoveryPath(projectId, { backend: 'native', intent: latest }))}
        >
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[9px]">
              Native
            </Badge>
            {nativeIntentTitle(latest)}
          </span>
          <span className="block text-muted-foreground">{nativeIntentStatusLabel(latest)}</span>
        </button>
      )}
      {(listing.items.length > 1 || listing.nextCursor) && (
        <button
          className="block text-muted-foreground underline"
          onClick={() => navigate(`/space/${projectId}`)}
        >
          View native intents in space
        </button>
      )}
      {listing.loading && <p role="status">Loading native intents…</p>}
      {listing.error && (
        <div role="alert" className="text-destructive">
          {listing.error}
          <button
            className="block underline"
            disabled={listing.loading}
            onClick={() => void refreshNativeIntents(projectId, 'refresh', true)}
          >
            Retry native intents
          </button>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projects: projectsWithSprints, loading, error, refresh, invalidate } = useProjectsCache();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createInitialProvider, setCreateInitialProvider] = useState<GitProvider | ''>('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  // Shared with the sidebar project list (useProjectSort store) — changing the
  // sort here re-orders both views.
  const [sortBy, changeSort] = useProjectSort();

  // Enrich each project with its derived "last activity" (own updatedAt +
  // latest intent/sprint activity) so both display and sorting can use it.
  const projects = useMemo(
    () =>
      projectsWithSprints.map((p) => ({
        ...p.project,
        lastActivityAt: projectLastActivityAt(p),
        // pickIntent surfaces a RUNNING (else WAITING) intent first, so this
        // flags a project with live/parked work — the delete dialog warns that
        // deleting will cancel it (the backend force-retires it).
        hasActiveWork: p.latestIntent?.status === 'RUNNING' || p.latestIntent?.status === 'WAITING',
        // UX-002: per-project activity counts aggregated across all intents.
        activity: p.activity,
        nativeIntents: p.nativeIntents,
        deleteReason: p.project.kind === 'v2' ? nativeProjectDeleteReason(p.nativeIntents) : null,
      })),
    [projectsWithSprints],
  );

  useEffect(() => {
    if (searchParams.get('reopenCreateSpace') === '1') {
      const provider = searchParams.get('gitProvider');
      if (isGitProvider(provider)) {
        setCreateInitialProvider(provider);
      }
      setShowCreateModal(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    const project = projects.find((item) => item.id === confirmDelete);
    if (!project || project.deleteReason || project.userRole !== 'owner') return;
    setDeleting(confirmDelete);
    setDeleteError(null);
    try {
      if (project.kind === 'v2') {
        await refreshNativeIntents(confirmDelete, 'refresh', true);
        const reason = nativeProjectDeleteReason(getNativeListing(confirmDelete));
        if (reason) throw new Error(reason);
      }
      await projectsService.delete(confirmDelete);
      invalidate();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete space.');
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
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

  const roleColors: Record<string, string> = {
    owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    admin: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    member: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="h-full">
      <div>
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt="AI-DLC" className="h-14 w-14 shrink-0" />
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Spaces</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Shared workspaces where people and AI agents build together
              </p>
            </div>
          </div>
          <Button
            onClick={() => {
              setCreateInitialProvider('');
              setShowCreateModal(true);
            }}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            New Space
          </Button>
        </div>

        {/* Search & view controls */}
        <div className="flex items-center gap-3 mb-6 -mt-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search spaces..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={sortBy} onValueChange={(v) => changeSort(v as ProjectSort)}>
            <SelectTrigger className="h-9 w-[180px] gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="activity">{PROJECT_SORT_LABELS.activity}</SelectItem>
              <SelectItem value="created">{PROJECT_SORT_LABELS.created}</SelectItem>
              <SelectItem value="name">{PROJECT_SORT_LABELS.name}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center border rounded-md">
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              aria-label="Grid view"
              className="h-8 w-8 rounded-r-none"
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              aria-label="List view"
              className="h-8 w-8 rounded-l-none"
              onClick={() => setViewMode('list')}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Content */}
        {deleteError && (
          <p role="alert" className="text-sm text-destructive">
            {deleteError}
          </p>
        )}
        {loading ? (
          <div
            className={cn(
              viewMode === 'grid' ? 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' : 'space-y-2',
            )}
          >
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-5 w-2/3 mb-3" />
                  <Skeleton className="h-4 w-1/3 mb-4" />
                  <Skeleton className="h-3 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : error && projects.length === 0 ? (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <h3 className="text-lg font-semibold mb-1">Couldn't load spaces</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-sm">{error}</p>
              <Button variant="outline" onClick={() => refresh()} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : filteredProjects.length === 0 && projects.length === 0 ? (
          /* Empty state */
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <FolderGit2 className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-1">No spaces yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-sm">
                Create your first space to start building with AI-powered collaborative development.
              </p>
              <Button
                onClick={() => {
                  setCreateInitialProvider('');
                  setShowCreateModal(true);
                }}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Create Your First Space
              </Button>
            </CardContent>
          </Card>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No spaces match "{searchQuery}"</p>
          </div>
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
                    'group transition-all',
                    isDeleting
                      ? 'pointer-events-none opacity-50'
                      : 'cursor-pointer hover:shadow-md hover:border-foreground/20',
                  )}
                  onClick={(event) => {
                    if ((event.target as Element).closest('button')) return;
                    if (!isDeleting) navigate(`/space/${project.id}`);
                  }}
                >
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <FolderGit2 className="h-4.5 w-4.5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-sm truncate">{project.name}</h3>
                          <div className="flex items-center gap-1 mt-0.5">
                            {project.userRole && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  'h-4 px-1.5 text-[9px]',
                                  roleColors[project.userRole],
                                )}
                              >
                                {project.userRole}
                              </Badge>
                            )}
                            {project.kind !== 'v2' && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="outline"
                                    className="h-4 px-1.5 text-[9px] text-muted-foreground"
                                  >
                                    Legacy
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Created with v1 — this space is view-only. New work uses v2
                                  intents.
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      </div>
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
                      ) : (
                        project.userRole === 'owner' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                            aria-label={`Delete ${project.name}`}
                            disabled={!!project.deleteReason}
                            title={project.deleteReason ?? undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!project.deleteReason) setConfirmDelete(project.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        )
                      )}
                    </div>

                    {project.gitRepo && (
                      <div className="text-xs text-muted-foreground mb-2">
                        <GitRepoLink
                          gitRepo={project.gitRepo}
                          gitProvider={project.gitProvider}
                          noLink
                        />
                      </div>
                    )}

                    {project.activity.inProgress > 0 && (
                      <div className="mb-2.5">
                        <ProjectSignals activity={project.activity} />
                      </div>
                    )}
                    <NativeDiscovery projectId={project.id} listing={project.nativeIntents} />

                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/60">
                      <span>Created on {new Date(project.createdAt).toLocaleDateString()}</span>
                      <span>Last activity {formatRelativeTime(project.lastActivityAt)}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          /* List view */
          <div className="space-y-1">
            {filteredProjects.map((project) => {
              const isDeleting = deleting === project.id;
              return (
                <Card
                  key={project.id}
                  aria-busy={isDeleting}
                  className={cn(
                    'group transition-all',
                    isDeleting
                      ? 'pointer-events-none opacity-50'
                      : 'cursor-pointer hover:bg-accent/50',
                  )}
                  onClick={(event) => {
                    if ((event.target as Element).closest('button')) return;
                    if (!isDeleting) navigate(`/space/${project.id}`);
                  }}
                >
                  <CardContent className="flex items-center gap-4 p-3 px-4">
                    <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <FolderGit2 className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-sm">{project.name}</span>
                      <NativeDiscovery projectId={project.id} listing={project.nativeIntents} />
                    </div>
                    {project.activity.inProgress > 0 && (
                      <div className="hidden md:block shrink-0">
                        <ProjectSignals activity={project.activity} />
                      </div>
                    )}
                    {project.gitRepo && (
                      <GitRepoLink
                        gitRepo={project.gitRepo}
                        gitProvider={project.gitProvider}
                        className="text-xs text-muted-foreground"
                        noLink
                      />
                    )}
                    {project.userRole && (
                      <Badge
                        variant="outline"
                        className={cn('text-[10px]', roleColors[project.userRole])}
                      >
                        {project.userRole}
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground/60 shrink-0 hidden sm:inline">
                      Last activity {formatRelativeTime(project.lastActivityAt)}
                    </span>
                    <span className="text-[11px] text-muted-foreground/60 shrink-0">
                      Created on {new Date(project.createdAt).toLocaleDateString()}
                    </span>
                    {isDeleting ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
                    ) : (
                      project.userRole === 'owner' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                          aria-label={`Delete ${project.name}`}
                          disabled={!!project.deleteReason}
                          title={project.deleteReason ?? undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!project.deleteReason) setConfirmDelete(project.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreateModal && (
        <CreateProjectModal
          initialProvider={createInitialProvider}
          onClose={() => setShowCreateModal(false)}
          onCreated={refresh}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={() => (deleting ? null : setConfirmDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Space</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this space? This action cannot be undone. Every intent
              — with all of its artifacts, questions, discussions, run history and usage metrics —
              will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmDeleteHasActiveWork && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                This space has running or waiting work. Deleting it will cancel that work before
                removing everything.
              </span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={
                !!deleting ||
                !!projects.find((project) => project.id === confirmDelete)?.deleteReason
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Deleting…
                </span>
              ) : (
                'Delete Space'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
