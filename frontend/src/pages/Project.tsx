import { useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  useProjectCache,
  useProjectSprintsCache,
  useProjectsCache,
} from '@/hooks/useProjectsCache';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { projectsService, type Project as ProjectType } from '@/services/projects';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { sprintsService, type Sprint } from '@/services/sprints';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
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
  Loader2,
  CheckCircle2,
  XCircle,
  MessageCircleQuestion,
  ChevronRight,
  Clock,
  Plus,
  Trash2,
  Settings,
} from 'lucide-react';
import { TrackerIssueListPanel } from '@/components/TrackerIssueListPanel';
import { MigrateTrackerCard } from '@/components/MigrateTrackerCard';
import { effectiveSprintStatus, isActiveStatus } from '@/lib/sprintStatus';

const STATUS_ICON: Record<string, typeof Loader2> = {
  running: Loader2,
  waiting: MessageCircleQuestion,
  completed: CheckCircle2,
  failed: XCircle,
  passed: CheckCircle2,
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
  passed: 'Passed',
};

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);
  const { sprints, refresh: refreshSprints } = useProjectSprintsCache(projectId ?? null);
  const { invalidate: invalidateProjects } = useProjectsCache();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [activeTrackerTab, setActiveTrackerTab] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{
    sprintsApplied: number;
    projectsApplied: number;
  } | null>(null);

  const latestSprint = sprints[0] ?? null;
  const agentStatus = effectiveSprintStatus(latestSprint);
  const isAgentActive = isActiveStatus(agentStatus);

  useSprintEvents(
    latestSprint?.id ?? '',
    useCallback(() => {
      refreshSprints();
    }, [refreshSprints]),
  );

  const handleSprintCreated = useCallback(() => {
    refreshSprints();
  }, [refreshSprints]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await sprintsService.create(projectId, { name: newName, description: '' });
      refreshSprints();
      setShowCreate(false);
      setNewName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create sprint');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!projectId || !confirmDelete) return;
    try {
      await sprintsService.delete(projectId, confirmDelete);
      refreshSprints();
    } catch (error) {
      console.error('Failed to delete sprint:', error);
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleMigrateTracker = async () => {
    if (!projectId) return;
    setMigrating(true);
    try {
      const result = await projectsService.migrateTracker(projectId);
      setMigrationResult({
        sprintsApplied: result.sprints.applied,
        projectsApplied: result.projects.applied,
      });
      // Refresh so project.trackers reflects the new binding and the
      // MigrateTrackerCard self-dismisses on next render.
      invalidateProjects();
      refreshSprints();
    } catch (error) {
      console.error('Failed to migrate tracker:', error);
    } finally {
      setMigrating(false);
    }
  };

  const activeSprints = sprints.filter((s) => isActiveStatus(effectiveSprintStatus(s)));
  const pastSprints = sprints.filter((s) => !isActiveStatus(effectiveSprintStatus(s)));

  if (!projectId) return <div className="p-6">Project not found</div>;

  if (!project && projectLoading) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="grid md:grid-cols-2 gap-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!project) return <div className="p-6">Project not found</div>;

  const hasTrackers = project.trackers.length > 0;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <FolderGit2 className="h-5 w-5 text-primary shrink-0" />
          <h1 className="text-lg font-bold tracking-tight truncate">{project.name}</h1>
          {isAgentActive && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30 shrink-0"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
              Live
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-7"
            onClick={() => navigate(`/project/${projectId}/settings`)}
          >
            <Settings className="h-3 w-3" />
            Settings
          </Button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <FolderGit2 className="h-3 w-3" />
              Repository
            </div>
            {project.gitRepo ? (
              <>
                <p className="text-sm font-medium truncate">{project.gitRepo}</p>
                {latestSprint?.branch && (
                  <p className="text-[11px] text-muted-foreground mt-1 truncate">
                    Branch: {latestSprint.branch}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Not configured</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="h-3 w-3" />
              Iterations
            </div>
            <p className="text-sm font-medium">
              {sprints.length} iteration{sprints.length !== 1 ? 's' : ''}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {activeSprints.length} active · Created{' '}
              {new Date(project.createdAt).toLocaleDateString()}
              {(() => {
                const lastActive = sprints
                  .map((s) => s.agentCompletedAt ?? s.agentStartedAt)
                  .filter(Boolean)
                  .sort()
                  .pop();
                return lastActive ? ` · Last activity ${formatRelativeTime(lastActive)}` : '';
              })()}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tracker-abstraction migration banner — only renders for legacy
          projects that still use issueIntegrationEnabled and have no
          HAS_TRACKER edge yet. Lives here so users discover the
          migration on the project page where their issue list used to
          be (the same banner also appears in Project Settings). */}
      <MigrateTrackerCard
        project={project}
        canEditProject={project.userRole === 'owner' || project.userRole === 'admin'}
        migrating={migrating}
        migrationResult={migrationResult}
        onMigrate={handleMigrateTracker}
      />

      <div className={cn('grid gap-6', hasTrackers && 'md:grid-cols-2')}>
        {hasTrackers && (
          <div>
            {project.trackers.length === 1 && (
              <TrackerIssueListPanel
                project={project}
                binding={project.trackers[0]}
                sprints={sprints}
                onSprintCreated={handleSprintCreated}
              />
            )}
            {project.trackers.length > 1 && (
              <TrackerTabs
                project={project}
                sprints={sprints}
                activeTabId={activeTrackerTab}
                onTabChange={setActiveTrackerTab}
                onSprintCreated={handleSprintCreated}
              />
            )}
          </div>
        )}

        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 min-h-7">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">Iterations</CardTitle>
                {sprints.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] h-5">
                    {sprints.length}
                  </Badge>
                )}
              </div>
              <Button onClick={() => setShowCreate(true)} size="sm" className="gap-1.5 h-7">
                <Plus className="h-3.5 w-3.5" />
                New Sprint
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 space-y-4 pt-0">
            {activeSprints.length > 0 && (
              <div className="space-y-2">
                {activeSprints.map((s) => (
                  <SprintRow
                    key={s.id}
                    sprint={s}
                    projectId={projectId}
                    active
                    onNavigate={navigate}
                    onDelete={setConfirmDelete}
                  />
                ))}
              </div>
            )}

            {pastSprints.length > 0 && (
              <Collapsible defaultOpen={pastSprints.length <= 5}>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group w-full">
                  <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                  <span>Past iterations ({pastSprints.length})</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-1 mt-2">
                    {pastSprints.map((s) => (
                      <SprintRow
                        key={s.id}
                        sprint={s}
                        projectId={projectId}
                        onNavigate={navigate}
                        onDelete={setConfirmDelete}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {sprints.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center">
                <p className="text-sm text-muted-foreground">No iterations yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Start one to kick off the AI-DLC lifecycle.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create Sprint Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open);
          if (!open) setCreateError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>Create Sprint</DialogTitle>
              <DialogDescription>
                Create a new sprint to start a development iteration. You'll define the inception
                prompt after creation.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="sprint-name">Sprint Name</Label>
              <Input
                id="sprint-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Sprint 1 - User Authentication"
                className="mt-1.5"
                required
                autoFocus
              />
              {createError && <p className="mt-2 text-xs text-destructive">{createError}</p>}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating ? 'Creating...' : 'Create Sprint'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Sprint</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure? This will permanently delete the sprint and all its artifacts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface TrackerTabsProps {
  project: ProjectType;
  sprints: Sprint[];
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  onSprintCreated: (sprint: Sprint) => void;
}

function TrackerTabs({
  project,
  sprints,
  activeTabId,
  onTabChange,
  onSprintCreated,
}: TrackerTabsProps) {
  const trackers = project.trackers;
  const activeBinding = useMemo(() => {
    return trackers.find((t) => t.id === activeTabId) ?? trackers[0];
  }, [trackers, activeTabId]);

  return (
    <div>
      <div className="flex items-center gap-1 border-b">
        {trackers.map((binding) => {
          const isActive = binding.id === activeBinding.id;
          const tabLabel = getTrackerProvider(binding.provider).tabLabel;
          const label = binding.displayName || binding.externalProjectKey || tabLabel;
          return (
            <button
              key={binding.id}
              type="button"
              onClick={() => onTabChange(binding.id)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="text-muted-foreground mr-1.5">{tabLabel}</span>
              {label}
            </button>
          );
        })}
      </div>
      <TrackerIssueListPanel
        key={activeBinding.id}
        project={project}
        binding={activeBinding}
        sprints={sprints}
        onSprintCreated={onSprintCreated}
      />
    </div>
  );
}

function SprintRow({
  sprint,
  projectId,
  active,
  onNavigate,
  onDelete,
}: {
  sprint: Sprint;
  projectId: string;
  active?: boolean;
  onNavigate: (path: string) => void;
  onDelete: (sprintId: string) => void;
}) {
  const status = effectiveSprintStatus(sprint);
  const phaseRoute =
    sprint.phase === 'CONSTRUCTION' ? '/construction' : sprint.phase === 'REVIEW' ? '/review' : '';

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg border px-3 py-2.5 w-full transition-colors hover:bg-accent/50',
        active && status === 'running' && 'border-agent-running/25 bg-agent-running/[0.03]',
        active && status === 'waiting' && 'border-agent-waiting/25 bg-agent-waiting/[0.03]',
      )}
    >
      <button
        onClick={() => onNavigate(`/project/${projectId}/sprint/${sprint.id}${phaseRoute}`)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{sprint.name}</p>
          <Badge variant="outline" className="text-[9px] h-4 shrink-0">
            {sprint.phase}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {formatRelativeTime(sprint.createdAt)}
          {sprint.prUrl && ' · PR open'}
        </p>
      </button>
      {status !== 'idle' &&
        STATUS_ICON[status] &&
        (() => {
          const Icon = STATUS_ICON[status];
          return (
            <Icon
              aria-label={STATUS_LABEL[status]}
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                status === 'running' && 'animate-spin text-agent-running',
                status === 'waiting' && 'text-agent-waiting',
                status === 'completed' && 'text-agent-success',
                status === 'passed' && 'text-agent-success',
                status === 'failed' && 'text-agent-error',
              )}
            />
          );
        })()}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(sprint.id);
        }}
      >
        <Trash2 className="h-3 w-3 text-destructive" />
      </Button>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
    </div>
  );
}
