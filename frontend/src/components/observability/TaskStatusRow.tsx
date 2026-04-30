import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { TaskAgentStatus } from '@/services/agents';

interface Props {
  tasks: TaskAgentStatus[];
}

export function TaskStatusRow({ tasks }: Props) {
  if (tasks.length === 0) return null;
  return (
    <div className="px-2.5 pb-2.5 flex flex-wrap gap-1.5">
      {tasks.map(t => {
        const s = t.executionStatus;
        return (
          <div key={t.taskId} className={cn(
            'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] border',
            s === 'RUNNING'   && 'bg-agent-running/10 border-agent-running/30 text-agent-running',
            s === 'SUCCEEDED' && 'bg-agent-success/10 border-agent-success/30 text-agent-success',
            s === 'FAILED'    && 'bg-agent-error/10 border-agent-error/30 text-agent-error',
            !s                && 'bg-muted/40 border-border text-muted-foreground',
          )}>
            {s === 'RUNNING'   && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {s === 'SUCCEEDED' && <CheckCircle2 className="h-2.5 w-2.5" />}
            {s === 'FAILED'    && <XCircle className="h-2.5 w-2.5" />}
            <span className="truncate max-w-[120px]">{t.title}</span>
          </div>
        );
      })}
    </div>
  );
}
