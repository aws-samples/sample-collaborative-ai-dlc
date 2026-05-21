import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Loader2, MessageCircleQuestion, CheckCircle2, XCircle, Clock, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { buildFocusSentence } from '@/lib/observability/buildFocusSentence';
import type { ProjectAgentInfo, LastToolMap, PendingQuestionsMap, VelocityMetrics } from '@/hooks/useObservability';

interface AgentStatusCardsProps {
  projects: ProjectAgentInfo[];
  lastToolMap: LastToolMap;
  pendingQuestions: PendingQuestionsMap;
  velocityMap: Record<string, VelocityMetrics>;
  onSelectProject?: (projectId: string) => void;
}

const STATUS_CONFIG: Record<string, {
  icon: typeof Loader2;
  borderClass: string;
  bgClass: string;
  label: string;
  color: string;
}> = {
  running: {
    icon: Loader2,
    borderClass: 'border-agent-running/25',
    bgClass: 'bg-agent-running/[0.04] shadow-[0_12px_32px_rgba(59,130,246,0.06)]',
    label: 'Running',
    color: 'text-agent-running',
  },
  waiting: {
    icon: MessageCircleQuestion,
    borderClass: 'border-agent-waiting/25',
    bgClass: 'bg-agent-waiting/[0.04]',
    label: 'Waiting',
    color: 'text-agent-waiting',
  },
  completed: {
    icon: CheckCircle2,
    borderClass: 'border-border',
    bgClass: 'bg-background/70',
    label: 'Completed',
    color: 'text-agent-success',
  },
  failed: {
    icon: XCircle,
    borderClass: 'border-border',
    bgClass: 'bg-background/70',
    label: 'Failed',
    color: 'text-agent-error',
  },
};

function formatDuration(startedAt: string | null): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function sortByStatus(a: ProjectAgentInfo, b: ProjectAgentInfo): number {
  const order: Record<string, number> = { running: 0, waiting: 1, failed: 2, completed: 3 };
  const aStatus = a.sprint?.currentAgentStatus ?? 'completed';
  const bStatus = b.sprint?.currentAgentStatus ?? 'completed';
  return (order[aStatus] ?? 4) - (order[bStatus] ?? 4);
}

export function AgentStatusCards({ projects, lastToolMap, pendingQuestions, velocityMap, onSelectProject }: AgentStatusCardsProps) {
  const withSprints = projects
    .filter(p => p.sprint?.currentAgentStatus)
    .sort(sortByStatus);

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agents
      </h3>
      {withSprints.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">No recent agent activity.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {withSprints.map(({ project, sprint, progress }) => {
            if (!sprint) return null;
            const status = sprint.currentAgentStatus ?? 'completed';
            const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.completed;
            const StatusIcon = cfg.icon;
            const isActive = status === 'running' || status === 'waiting';
            const lastTool = lastToolMap[sprint.id];
            const questions = pendingQuestions[sprint.id] ?? 0;
            const velocity = velocityMap[sprint.id];

            const focus = status === 'waiting'
              ? 'Waiting for answer'
              : buildFocusSentence(sprint.currentAgentType, sprint, progress, lastTool);

            const TrendIcon = velocity?.trend === 'improving' ? TrendingUp
              : velocity?.trend === 'declining' ? TrendingDown
              : Minus;
            const trendColor = velocity?.trend === 'improving' ? 'text-green-600'
              : velocity?.trend === 'declining' ? 'text-red-500'
              : 'text-muted-foreground';

            return (
              <div
                key={project.id}
                onClick={() => onSelectProject?.(project.id)}
                className={cn(
                  'flex flex-col overflow-hidden rounded-xl border shadow-sm transition-shadow',
                  cfg.borderClass,
                  cfg.bgClass,
                  onSelectProject && 'cursor-pointer hover:shadow-md',
                )}
              >
                <div className="border-b border-border/60 px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {isActive ? (
                          <span className="relative flex h-2.5 w-2.5 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" style={{ color: status === 'running' ? 'rgb(59,130,246)' : 'rgb(234,179,8)' }} />
                            <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', status === 'running' ? 'bg-agent-running' : 'bg-agent-waiting')} />
                          </span>
                        ) : (
                          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
                        )}
                        <span className="text-sm font-semibold truncate">{project.name}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {isActive ? 'Live now' : `${cfg.label} ${formatDuration(sprint.agentStartedAt)}`}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn('gap-1 text-[10px] h-5 font-medium shrink-0', cfg.color, `border-current/30`)}
                    >
                      <StatusIcon className={cn('h-3 w-3', status === 'running' && 'animate-spin')} />
                      {sprint.currentAgentType && (
                        <span className="capitalize">{sprint.currentAgentType.replace(/[_-]/g, ' ')}</span>
                      )}
                    </Badge>
                  </div>

                  {questions > 0 && (
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] font-bold text-agent-waiting animate-pulse">
                      <AlertTriangle className="h-3 w-3" />
                      {questions} question{questions > 1 ? 's' : ''} blocking
                    </div>
                  )}
                </div>

                <div className="flex-1 px-3 py-3 space-y-2">
                  {focus && (
                    <p className={cn(
                      'text-xs truncate',
                      status === 'waiting' ? 'text-agent-waiting font-medium' : 'text-muted-foreground',
                    )}>
                      {focus}
                    </p>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] h-5 bg-muted/40">
                      {sprint.phase}
                    </Badge>

                    {sprint.agentStartedAt && isActive && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                        <Clock className="h-2.5 w-2.5" />
                        {formatDuration(sprint.agentStartedAt)}
                      </span>
                    )}

                    {velocity && (
                      <span className={cn('flex items-center gap-1 text-[10px]', trendColor)}>
                        <TrendIcon className="h-3 w-3" />
                        {velocity.tasksPerHour} tasks/hr
                      </span>
                    )}
                  </div>

                  {progress && progress.taskCount > 0 && (
                    <div className="text-[10px] text-muted-foreground/60">
                      {progress.taskDoneCount}/{progress.taskCount} tasks
                      {progress.codeFileCount > 0 && ` · ${progress.codeFileCount} files`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
