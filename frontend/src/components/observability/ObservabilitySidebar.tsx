import { Activity, LayoutDashboard, Loader2, MessageCircleQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ProjectAgentInfo } from '@/hooks/useObservability';

interface ObservabilitySidebarProps {
  projects: ProjectAgentInfo[];
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-agent-running',
  waiting: 'bg-agent-waiting',
  completed: 'bg-agent-success',
  failed: 'bg-agent-error',
};

export function ObservabilitySidebar({ projects, selectedProjectId, onSelectProject }: ObservabilitySidebarProps) {
  const runningCount = projects.filter(p =>
    p.sprint?.currentAgentStatus === 'running' || p.sprint?.currentAgentStatus === 'waiting'
  ).length;

  return (
    <div className="flex h-full w-60 flex-col border-r bg-background">
      <div className="flex items-center gap-2 px-4 h-12 shrink-0 border-b">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-bold tracking-tight">Observability</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-3 py-2">
        <button
          onClick={() => onSelectProject(null)}
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
            selectedProjectId === null
              ? 'bg-accent text-foreground'
              : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Dashboard</span>
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
        <div className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60 px-3">
          Projects
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-0.5 px-3 pb-3">
          {projects.map(({ project, sprint }) => {
            const status = sprint?.currentAgentStatus;
            const isActive = status === 'running' || status === 'waiting';
            const dotColor = status ? STATUS_DOT[status] : undefined;

            return (
              <button
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                  selectedProjectId === project.id
                    ? 'bg-accent text-foreground'
                    : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <span className="relative shrink-0">
                  <span className="block h-3.5 w-3.5 rounded-sm bg-primary/30" />
                  {dotColor && (
                    <span className={cn(
                      'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]',
                      dotColor,
                      isActive && 'animate-pulse',
                    )} />
                  )}
                </span>
                <span className="flex-1 truncate">{project.name}</span>
                {status === 'running' && <Loader2 className="h-3 w-3 text-agent-running animate-spin shrink-0" />}
                {status === 'waiting' && <MessageCircleQuestion className="h-3 w-3 text-agent-waiting shrink-0" />}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
