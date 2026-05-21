import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useProjectCache, useProjectSprintsCache } from '@/hooks/useProjectsCache';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IssueListPanel } from '@/components/IssueListPanel';
import {
  FolderGit2,
  Bot,
  Loader2,
  CheckCircle2,
  XCircle,
  MessageCircleQuestion,
  ChevronRight,
  Clock,
  Plus,
  Settings,
} from 'lucide-react';
import { sprintsService, type Sprint } from '@/services/sprints';

const STATUS_ICON: Record<string, typeof Loader2> = {
  running: Loader2,
  waiting: MessageCircleQuestion,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
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

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const latestSprint = sprints[0] ?? null;
  const agentStatus = latestSprint?.currentAgentStatus;
  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting';

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
      await sprintsService.create(projectId, { name: newName.trim(), description: '' });
      refreshSprints();
      setShowCreate(false);
      setNewName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create iteration');
    } finally {
      setCreating(false);
    }
  };

  const activeSprints = sprints.filter(
    (s) => s.currentAgentStatus === 'running' || s.currentAgentStatus === 'waiting',
  );
  const pastSprints = sprints.filter(
    (s) => s.currentAgentStatus !== 'running' && s.currentAgentStatus !== 'waiting',
  );

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

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FolderGit2 className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold tracking-tight">{project.name}</h1>
          {latestSprint && (
            <Badge variant="outline" className="text-[10px]">
              {latestSprint.phase}
            </Badge>
          )}
          {isAgentActive && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
              Live
            </Badge>
          )}
        </div>
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

      <div className="grid md:grid-cols-2 gap-3">
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Bot className="h-3 w-3" />
              Agent
            </div>
            <div className="flex items-center gap-2">
              {agentStatus &&
                STATUS_ICON[agentStatus] &&
                (() => {
                  const Icon = STATUS_ICON[agentStatus];
                  return (
                    <Icon
                      className={cn(
                        'h-3.5 w-3.5',
                        agentStatus === 'running' && 'animate-spin text-agent-running',
                        agentStatus === 'waiting' && 'text-agent-waiting',
                        agentStatus === 'completed' && 'text-agent-success',
                        agentStatus === 'failed' && 'text-agent-error',
                      )}
                    />
                  );
                })()}
              <p className="text-sm font-medium">
                {agentStatus ? STATUS_LABEL[agentStatus] : 'Idle'}
              </p>
            </div>
            {latestSprint?.currentAgentType && (
              <p className="text-[11px] text-muted-foreground mt-1 capitalize">
                {latestSprint.currentAgentType.replace(/[_-]/g, ' ')}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Clock className="h-3 w-3" />
              Sprints
            </div>
            <p className="text-sm font-medium">
              {sprints.length} iteration{sprints.length !== 1 ? 's' : ''}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {activeSprints.length} active · Created{' '}
              {new Date(project.createdAt).toLocaleDateString()}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between h-7">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Issues
            </h3>
          </div>
          <IssueListPanel
            project={project}
            sprints={sprints}
            onSprintCreated={handleSprintCreated}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between h-7">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Iterations
            </h3>
            <Button
              size="sm"
              className="gap-1.5 h-7"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-3 w-3" />
              Start
            </Button>
          </div>

          {activeSprints.length > 0 && (
            <div className="space-y-2">
              {activeSprints.map((s) => (
                <SprintRow
                  key={s.id}
                  sprint={s}
                  projectId={projectId}
                  active
                  onNavigate={navigate}
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
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {sprints.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">No iterations yet</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open);
          if (!open) {
            setNewName('');
            setCreateError(null);
          }
        }}
      >
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>Start a new iteration</DialogTitle>
              <DialogDescription>
                Give this iteration a short, descriptive name. You can refine the goal in the
                inception phase.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <Label htmlFor="iteration-name">Name</Label>
              <Input
                id="iteration-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Add user profile page"
                autoFocus
                disabled={creating}
              />
              {createError && (
                <p className="text-xs text-destructive">{createError}</p>
              )}
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
                {creating ? 'Starting...' : 'Start iteration'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SprintRow({
  sprint,
  projectId,
  active,
  onNavigate,
}: {
  sprint: Sprint;
  projectId: string;
  active?: boolean;
  onNavigate: (path: string) => void;
}) {
  const status = sprint.currentAgentStatus;
  const phaseRoute =
    sprint.phase === 'CONSTRUCTION'
      ? '/construction'
      : sprint.phase === 'REVIEW'
        ? '/review'
        : '';

  return (
    <button
      onClick={() => onNavigate(`/project/${projectId}/sprint/${sprint.id}${phaseRoute}`)}
      className={cn(
        'flex items-center gap-3 rounded-lg border px-3 py-2.5 w-full text-left transition-colors hover:bg-accent/50',
        active && status === 'running' && 'border-agent-running/25 bg-agent-running/[0.03]',
        active && status === 'waiting' && 'border-agent-waiting/25 bg-agent-waiting/[0.03]',
      )}
    >
      <div className="min-w-0 flex-1">
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
      </div>
      {status &&
        STATUS_ICON[status] &&
        (() => {
          const Icon = STATUS_ICON[status];
          return (
            <Icon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                status === 'running' && 'animate-spin text-agent-running',
                status === 'waiting' && 'text-agent-waiting',
                status === 'completed' && 'text-agent-success',
                status === 'failed' && 'text-agent-error',
              )}
            />
          );
        })()}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
    </button>
  );
}
