import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectsService, type Project as ProjectType } from '@/services/projects';
import { sprintsService, type Sprint } from '@/services/sprints';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Plus, GitBranch, Trash2, Zap, Calendar, Settings } from 'lucide-react';
import { IssueListPanel } from '@/components/IssueListPanel';
const PHASE_VARIANT: Record<string, 'inception' | 'construction' | 'review'> = {
  INCEPTION: 'inception',
  CONSTRUCTION: 'construction',
  REVIEW: 'review',
};

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectType | null>(null);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      const [proj, sprintList] = await Promise.all([
        projectsService.get(projectId),
        sprintsService.list(projectId),
      ]);
      setProject(proj);
      setSprints(sprintList);
    } catch (error) {
      console.error('Failed to load project:', error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newName.trim()) return;
    setCreating(true);
    try {
      const sprint = await sprintsService.create(projectId, { name: newName, description: '' });
      setSprints((prev) => [...prev, sprint]);
      setShowCreate(false);
      setNewName('');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!projectId || !confirmDelete) return;
    try {
      await sprintsService.delete(projectId, confirmDelete);
      setSprints((prev) => prev.filter((s) => s.id !== confirmDelete));
    } catch (error) {
      console.error('Failed to delete sprint:', error);
    } finally {
      setConfirmDelete(null);
    }
  };

  const getSprintUrl = (sprint: Sprint) => {
    const base = `/project/${projectId}/sprint/${sprint.id}`;
    if (sprint.phase === 'CONSTRUCTION') return `${base}/construction`;
    if (sprint.phase === 'REVIEW') return `${base}/review`;
    return base;
  };

  if (!projectId) return <div className="p-6">Project not found</div>;

  return (
    <div className="h-full">
      <div className="max-w-5xl mx-auto p-6">
        {/* Project header */}
        <div className="mb-8">
          {loading ? (
            <>
              <Skeleton className="h-8 w-48 mb-2" />
              <Skeleton className="h-4 w-64" />
            </>
          ) : project ? (
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
                <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <GitBranch className="h-3.5 w-3.5" />
                    {project.gitRepo}
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={() => navigate(`/project/${projectId}/settings`)}
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </Button>
            </div>
          ) : null}
        </div>

        {/* Sprints header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Sprints</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {sprints.length} sprint{sprints.length !== 1 ? 's' : ''}
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New Sprint
          </Button>
        </div>

        {/* Sprint list */}
        {loading ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-2/3 mb-2" />
                  <Skeleton className="h-4 w-1/3 mb-3" />
                  <Skeleton className="h-3 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : sprints.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <Zap className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-semibold mb-1">No sprints yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create a sprint to start your development lifecycle
              </p>
              <Button onClick={() => setShowCreate(true)} size="sm" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create First Sprint
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {sprints.map((sprint) => (
              <Card
                key={sprint.id}
                className="group cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
                onClick={() => navigate(getSprintUrl(sprint))}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-sm group-hover:text-primary transition-colors">
                      {sprint.name}
                    </h3>
                    <Badge
                      variant={PHASE_VARIANT[sprint.phase] || 'secondary'}
                      className="text-[10px] shrink-0"
                    >
                      {sprint.phase}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
                    {sprint.description || 'No description'}
                  </p>
                  <div className="flex items-center justify-between mt-3 pt-2 border-t">
                    <span className="text-[11px] text-muted-foreground/60">
                      {new Date(sprint.createdAt).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-1">
                      {sprint.prUrl && (
                        <Badge variant="outline" className="text-[9px] h-4">
                          PR
                        </Badge>
                      )}
                      {sprint.currentAgentStatus === 'running' && (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-agent-running" />
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(sprint.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* GitHub issues panel — below sprints so sprints stay discoverable */}
        {project && project.gitProvider === 'github' && project.issueIntegrationEnabled && (
          <IssueListPanel
            project={project}
            sprints={sprints}
            onSprintCreated={(sprint) => setSprints(prev => [...prev, sprint])}
          />
        )}
      </div>

      {/* Create Sprint Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
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
