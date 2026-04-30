/**
 * AgentTeamSummary — compact "team view" row showing all active agents across projects.
 * Implements the AgentTower "team view" concept: one row per active agent, current focus.
 * Uses the shared buildFocusSentence utility for consistency with AgentFocusCard.
 */
import { cn } from '@/lib/utils';
import { Loader2, MessageCircleQuestion, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { buildFocusSentence } from '@/lib/observability/buildFocusSentence';
import type { ProjectAgentInfo, LastToolMap } from '@/hooks/useObservability';

interface Props {
  projects: ProjectAgentInfo[];
  lastToolMap: LastToolMap;
}

const STATUS_ICON: Record<string, typeof Loader2> = {
  running: Loader2,
  waiting: MessageCircleQuestion,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_COLOR: Record<string, string> = {
  running: 'text-agent-running',
  waiting: 'text-agent-waiting',
  completed: 'text-agent-success',
  failed: 'text-agent-error',
};

export function AgentTeamSummary({ projects, lastToolMap }: Props) {
  const active = projects.filter(p =>
    p.sprint?.currentAgentStatus === 'running' || p.sprint?.currentAgentStatus === 'waiting'
  );
  if (active.length === 0) return null;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="px-4 py-2">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Active Agents
          </span>
          <span className="text-[10px] text-muted-foreground/50">· {active.length} running</span>
        </div>
        <div className="space-y-1">
          {active.map(({ project, sprint, progress }) => {
            if (!sprint) return null;
            const status = sprint.currentAgentStatus ?? 'running';
            const Icon = STATUS_ICON[status] ?? Loader2;
            const color = STATUS_COLOR[status] ?? 'text-agent-running';
            const lastTool = lastToolMap[sprint.id];
            // For 'waiting', override with a clear message; otherwise use shared logic
            const focus = status === 'waiting'
              ? 'Waiting for answer'
              : buildFocusSentence(sprint.currentAgentType, sprint, progress, lastTool);

            return (
              <div key={project.id} className="flex items-center gap-2 text-xs">
                <Icon className={cn('h-3 w-3 shrink-0', color, status === 'running' && 'animate-spin')} />
                <span className="font-medium truncate max-w-[120px]">{project.name}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className={cn('text-muted-foreground truncate', status === 'waiting' && 'text-agent-waiting font-medium')}>
                  {focus}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
