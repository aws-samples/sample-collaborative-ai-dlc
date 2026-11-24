import { cn } from '@/lib/utils';
import { StatusPill } from '@/components/ui/status-pill';
import { getStatus, type StatusKeyMap } from '@/lib/statusModel';

type AgentStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'timed_out' | null;

interface AgentStatusBadgeProps {
  status: AgentStatus;
  agentType?: string;
  compact?: boolean;
  className?: string;
}

const STAGE_KEY: Record<NonNullable<AgentStatus>, StatusKeyMap['stage'] | 'TIMED_OUT'> = {
  idle: 'PENDING',
  running: 'RUNNING',
  waiting: 'WAITING_FOR_HUMAN',
  completed: 'SUCCEEDED',
  failed: 'FAILED',
  timed_out: 'TIMED_OUT',
};

const DOT_CLASS: Record<NonNullable<AgentStatus>, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-agent-running',
  waiting: 'bg-agent-waiting',
  completed: 'bg-agent-success',
  failed: 'bg-agent-error',
  timed_out: 'bg-agent-warning',
};

export function AgentStatusBadge({
  status,
  agentType,
  compact = false,
  className,
}: AgentStatusBadgeProps) {
  const key = status ?? 'idle';
  const stageKey = STAGE_KEY[key];
  const entry = getStatus('stage', stageKey);
  // Discussion assists are in-thread helpers, not pipeline phases.
  const typeLabel =
    agentType === 'discussion'
      ? 'Discussion assist'
      : agentType
        ? `${agentType.charAt(0).toUpperCase()}${agentType.slice(1).replace(/[_-]/g, ' ')} agent`
        : null;

  if (compact) {
    return (
      <span
        role="img"
        aria-label={entry.label}
        className={cn('relative flex h-2.5 w-2.5 shrink-0', className)}
      >
        {entry.live && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping',
              DOT_CLASS[key],
            )}
          />
        )}
        <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', DOT_CLASS[key])} />
      </span>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', className)}>
      {typeLabel && <span className="text-muted-foreground">{typeLabel}</span>}
      <StatusPill kind="stage" status={stageKey} size="md" />
    </span>
  );
}
