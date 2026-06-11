import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { Activity, LayoutDashboard, Loader2, MessageCircleQuestion, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProjectsCache } from '@/hooks/useProjectsCache';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-agent-running',
  waiting: 'bg-agent-waiting',
  completed: 'bg-agent-success',
  failed: 'bg-agent-error',
};

export function AppSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ projectId?: string }>();
  const { projects } = useProjectsCache();

  const runningCount = projects.filter((p) => {
    const s = p.latestSprint?.currentAgentStatus;
    return s === 'running' || s === 'waiting';
  }).length;

  const isOnDashboard = location.pathname === '/dashboard';
  const isOnObservability = location.pathname === '/observability';
  const isOnAdmin = location.pathname === '/admin';
  const activeProjectId = params.projectId ?? null;

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <nav className="flex flex-col gap-0.5 px-3 py-3">
        <button
          onClick={() => navigate('/dashboard')}
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
            isOnDashboard
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
        >
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Projects</span>
        </button>

        <button
          onClick={() => navigate('/observability')}
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
            isOnObservability
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
        >
          <Activity className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Observability</span>
          {runningCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-agent-running" />
              </span>
              <span className="text-[11px] font-medium text-agent-running">{runningCount}</span>
            </span>
          )}
        </button>
      </nav>

      <div className="px-3 py-1.5">
        <div className="text-[10px] font-medium uppercase tracking-widest font-mono text-sidebar-foreground/40 px-3">
          Projects
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-0.5 px-3 pb-3">
          {projects.map(({ project, latestSprint }) => {
            const status = latestSprint?.currentAgentStatus;
            const isActive = status === 'running' || status === 'waiting';
            const dotColor = status ? STATUS_DOT[status] : undefined;
            const isSelected = activeProjectId === project.id;

            return (
              <button
                key={project.id}
                onClick={() => navigate(`/project/${project.id}`)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors rounded-md text-left w-full min-w-0',
                  isSelected
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <span className="relative shrink-0">
                  <span className="block h-3.5 w-3.5 rounded-sm bg-sidebar-primary/30" />
                  {dotColor && (
                    <span
                      className={cn(
                        'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_hsl(var(--sidebar-background))]',
                        dotColor,
                        isActive && 'animate-pulse',
                      )}
                    />
                  )}
                </span>
                <span className="flex-1 truncate">{project.name}</span>
                {status === 'running' && (
                  <Loader2 className="h-3 w-3 text-agent-running animate-spin shrink-0" />
                )}
                {status === 'waiting' && (
                  <MessageCircleQuestion className="h-3 w-3 text-agent-waiting shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2">
        <button
          onClick={() => navigate('/admin')}
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
            isOnAdmin
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          Admin & Settings
        </button>
      </div>
    </div>
  );
}
