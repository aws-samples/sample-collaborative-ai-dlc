import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  MessageCircleQuestion,
  Wrench,
  GitBranch,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
} from 'lucide-react';
import { buildFocusSentence } from '@/lib/observability/buildFocusSentence';
import type { SprintProgress, VelocityMetrics } from '@/hooks/useObservability';
import type { Sprint } from '@/services/sprints';

interface Props {
  agentType?: string | null;
  agentStatus?: string | null;
  lastTool?: { name: string; timestamp: number };
  branch?: string | null;
  prUrl?: string | null;
  prNumber?: string | null;
  pendingQuestions?: number;
  progress?: SprintProgress | null;
  sprint?: Sprint | null;
  velocity?: VelocityMetrics | null;
}

const STATUS_CONFIG: Record<string, { icon: typeof Loader2; className: string; label: string }> = {
  running: {
    icon: Loader2,
    className: 'bg-agent-running/15 text-agent-running border-agent-running/30',
    label: 'Running',
  },
  waiting: {
    icon: MessageCircleQuestion,
    className: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
    label: 'Waiting',
  },
  completed: {
    icon: CheckCircle2,
    className: 'bg-agent-success/15 text-agent-success border-agent-success/30',
    label: 'Completed',
  },
  failed: {
    icon: XCircle,
    className: 'bg-agent-error/15 text-agent-error border-agent-error/30',
    label: 'Failed',
  },
  passed: {
    icon: CheckCircle2,
    className: 'bg-agent-success/15 text-agent-success border-agent-success/30',
    label: 'Passed',
  },
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function AgentFocusCard({
  agentType,
  agentStatus,
  lastTool,
  branch,
  prUrl,
  prNumber,
  pendingQuestions = 0,
  progress,
  sprint,
  velocity,
}: Props) {
  const cfg = agentStatus ? STATUS_CONFIG[agentStatus] : null;
  const focus =
    agentStatus === 'running' ? buildFocusSentence(agentType, sprint, progress, lastTool) : null;

  const TrendIcon =
    velocity?.trend === 'improving'
      ? TrendingUp
      : velocity?.trend === 'declining'
        ? TrendingDown
        : Minus;
  const trendColor =
    velocity?.trend === 'improving'
      ? 'text-green-600'
      : velocity?.trend === 'declining'
        ? 'text-red-500'
        : 'text-muted-foreground';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pendingQuestions > 0 && (
        <Badge
          variant="outline"
          className="gap-1 text-[10px] h-5 font-bold shrink-0 bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200 border-yellow-400 animate-pulse"
        >
          <AlertTriangle className="h-3 w-3" />
          {pendingQuestions} question{pendingQuestions > 1 ? 's' : ''} blocking
        </Badge>
      )}
      {branch && (
        <span className="text-[11px] text-muted-foreground/60 flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {branch}
        </span>
      )}
      {/* Single focus sentence — always shown when running */}
      {focus && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted rounded px-2 py-0.5">
          <Wrench className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate max-w-[220px]">{focus}</span>
        </span>
      )}
      {/* Last activity time — L2 signal */}
      {agentStatus === 'running' && lastTool && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          {timeAgo(lastTool.timestamp)}
        </span>
      )}
      {velocity ? (
        <span className={cn('flex items-center gap-1 text-[10px]', trendColor)}>
          <TrendIcon className="h-3 w-3" />
          {velocity.tasksPerHour} tasks/hr
          {velocity.trendPct !== 0 && (
            <span>
              ({velocity.trendPct > 0 ? '+' : ''}
              {velocity.trendPct}%)
            </span>
          )}
        </span>
      ) : agentStatus === 'running' && (progress?.taskCount ?? 0) > 0 ? (
        <span className="text-[10px] text-muted-foreground/40 italic">estimating velocity...</span>
      ) : null}
      {cfg && (
        <Badge
          variant="outline"
          className={cn('gap-1 text-[10px] h-5 font-medium shrink-0', cfg.className)}
        >
          <cfg.icon className={cn('h-3 w-3', agentStatus === 'running' && 'animate-spin')} />
          {agentType && <span className="capitalize">{agentType.replace(/[_-]/g, ' ')}</span>}
          {cfg.label}
        </Badge>
      )}
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          PR #{prNumber}
        </a>
      )}
    </div>
  );
}
