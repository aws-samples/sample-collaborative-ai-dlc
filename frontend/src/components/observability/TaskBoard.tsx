import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react';
import type { ProjectAgentInfo } from '@/hooks/useObservability';
import type { TaskAgentStatus } from '@/services/agents';

interface TaskBoardProps {
  projects: ProjectAgentInfo[];
}

interface ColumnConfig {
  key: string;
  label: string;
  icon: typeof Loader2;
  iconClass: string;
  pillBg: string;
  pillBorder: string;
  pillText: string;
  animate?: boolean;
  matchFn: (t: TaskAgentStatus) => boolean;
}

const COLUMNS: ColumnConfig[] = [
  {
    key: 'pending',
    label: 'Pending',
    icon: Circle,
    iconClass: 'text-muted-foreground',
    pillBg: 'bg-muted/40',
    pillBorder: 'border-border',
    pillText: 'text-muted-foreground',
    matchFn: (t) => !t.executionStatus,
  },
  {
    key: 'running',
    label: 'Running',
    icon: Loader2,
    iconClass: 'text-agent-running',
    pillBg: 'bg-agent-running/10',
    pillBorder: 'border-agent-running/30',
    pillText: 'text-agent-running',
    animate: true,
    matchFn: (t) => t.executionStatus === 'RUNNING',
  },
  {
    key: 'done',
    label: 'Done',
    icon: CheckCircle2,
    iconClass: 'text-agent-success',
    pillBg: 'bg-agent-success/10',
    pillBorder: 'border-agent-success/30',
    pillText: 'text-agent-success',
    matchFn: (t) => t.executionStatus === 'SUCCEEDED',
  },
  {
    key: 'failed',
    label: 'Failed',
    icon: XCircle,
    iconClass: 'text-agent-error',
    pillBg: 'bg-agent-error/10',
    pillBorder: 'border-agent-error/30',
    pillText: 'text-agent-error',
    matchFn: (t) => t.executionStatus === 'FAILED',
  },
];

interface TaggedTask extends TaskAgentStatus {
  projectName: string;
}

export function TaskBoard({ projects }: TaskBoardProps) {
  const allTasks = useMemo(() => {
    const tasks: TaggedTask[] = [];
    for (const p of projects) {
      if (!p.sprint) continue;
      for (const t of p.taskStatuses) {
        tasks.push({ ...t, projectName: p.project.name });
      }
    }
    return tasks;
  }, [projects]);

  const columnData = useMemo(() => {
    return COLUMNS.map(col => ({
      ...col,
      tasks: allTasks.filter(col.matchFn),
    }));
  }, [allTasks]);

  const hasTasks = allTasks.length > 0;

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Tasks
      </h3>
      {!hasTasks ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">No tasks in current sprints.</p>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columnData.map(col => {
            const ColIcon = col.icon;
            const isEmpty = col.tasks.length === 0;
            return (
              <div
                key={col.key}
                className={cn(
                  'flex flex-col shrink-0 transition-[width,min-width]',
                  isEmpty ? 'min-w-[48px] w-[48px]' : 'min-w-[220px] flex-1',
                )}
              >
                <div className={cn(
                  'flex items-center gap-2 px-2 py-2 mb-1',
                  isEmpty && 'justify-center',
                )}>
                  <ColIcon className={cn('h-3.5 w-3.5 shrink-0', col.iconClass, col.animate && col.tasks.length > 0 && 'animate-spin')} />
                  {!isEmpty && (
                    <>
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {col.label}
                      </span>
                      <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
                        {col.tasks.length}
                      </span>
                    </>
                  )}
                </div>

                <div className={cn(
                  'flex-1 min-h-[80px] rounded-md p-1.5 space-y-1',
                  isEmpty ? 'bg-transparent' : 'bg-muted/20',
                )}>
                  {col.tasks.map(task => {
                    const TaskIcon = col.icon;
                    return (
                      <div
                        key={task.taskId}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5',
                          col.pillBg, col.pillBorder, col.pillText,
                        )}
                      >
                        <TaskIcon className={cn('h-3 w-3 shrink-0', col.animate && 'animate-spin')} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate">{task.title}</p>
                          <p className="text-[10px] opacity-60 truncate">{task.projectName}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
