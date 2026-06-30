import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { projectsService } from '@/services/projects';
import { useProjectsCache } from '@/hooks/useProjectsCache';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import type { GitProvider } from '@/services/gitProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
  GitBranch,
  Trash2,
  FolderGit2,
  Search,
  LayoutGrid,
  List,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projects: projectsWithSprints, loading, error, refresh, invalidate } = useProjectsCache();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createInitialProvider, setCreateInitialProvider] = useState<GitProvider | ''>('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const projects = useMemo(() => projectsWithSprints.map((p) => p.project), [projectsWithSprints]);

  useEffect(() => {
    if (searchParams.get('reopenCreateProject') === '1') {
      const provider = searchParams.get('gitProvider');
      if (provider === 'gitlab' || provider === 'github') {
        setCreateInitialProvider(provider);
      }
      setShowCreateModal(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    setDeleting(confirmDelete);
    try {
      await projectsService.delete(confirmDelete);
      invalidate();
    } catch (error) {
      console.error('Failed to delete project:', error);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  };

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.gitRepo?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const roleColors: Record<string, string> = {
    owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    admin: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    member: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="h-full">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt="AI-DLC" className="h-14 w-14 shrink-0" />
            <div>
              <h1 className="text-3xl font-bold tracking-tight">AI-DLC</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Collaborative AI Development Lifecycle
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
            New Project
          </Button>
        </div>

        {/* Projects sub-header */}
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Projects
          </h2>
          <span className="text-xs text-muted-foreground/60">
            — {projects.length} project{projects.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Search & view controls */}
        <div className="flex items-center gap-3 mb-6 -mt-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <div className="flex items-center border rounded-md">
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-r-none"
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-l-none"
              onClick={() => setViewMode('list')}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Content */}
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
              <h3 className="text-lg font-semibold mb-1">Couldn't load projects</h3>
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
              <h3 className="text-lg font-semibold mb-1">No projects yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-sm">
                Create your first project to start building with AI-powered collaborative
                development.
              </p>
              <Button
                onClick={() => {
                  setCreateInitialProvider('');
                  setShowCreateModal(true);
                }}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Create Your First Project
              </Button>
            </CardContent>
          </Card>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No projects match "{searchQuery}"</p>
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid view */
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => (
              <Card
                key={project.id}
                className="group cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
                onClick={() => navigate(`/project/${project.id}`)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <FolderGit2 className="h-4.5 w-4.5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-sm truncate">{project.name}</h3>
                        {project.userRole && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'h-4 px-1.5 text-[9px] mt-0.5',
                              roleColors[project.userRole],
                            )}
                          >
                            {project.userRole}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {project.userRole === 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(project.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>

                  {project.gitRepo && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                      <GitBranch className="h-3 w-3" />
                      <span className="truncate">{project.gitRepo}</span>
                    </div>
                  )}

                  <div className="text-[11px] text-muted-foreground/60">
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          /* List view */
          <div className="space-y-1">
            {filteredProjects.map((project) => (
              <Card
                key={project.id}
                className="group cursor-pointer transition-all hover:bg-accent/50"
                onClick={() => navigate(`/project/${project.id}`)}
              >
                <CardContent className="flex items-center gap-4 p-3 px-4">
                  <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    <FolderGit2 className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{project.name}</span>
                  </div>
                  {project.gitRepo && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {project.gitRepo}
                    </span>
                  )}
                  {project.userRole && (
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', roleColors[project.userRole])}
                    >
                      {project.userRole}
                    </Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground/60 shrink-0">
                    {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                  {project.userRole === 'owner' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(project.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
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
      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this project? This action cannot be undone. All
              sprints and artifacts will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={!!deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete Project'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
