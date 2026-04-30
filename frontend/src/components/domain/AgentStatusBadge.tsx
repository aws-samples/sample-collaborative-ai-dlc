import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Loader2, CheckCircle2, XCircle, Clock, CirclePause } from 'lucide-react'

type AgentStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'timed_out' | null

interface AgentStatusBadgeProps {
  status: AgentStatus
  agentType?: string
  compact?: boolean
  className?: string
}

const STATUS_CONFIG: Record<string, {
  label: string
  icon: React.ComponentType<{ className?: string }>
  className: string
  pulse?: boolean
}> = {
  idle: {
    label: 'Idle',
    icon: Clock,
    className: 'bg-muted text-muted-foreground',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    className: 'bg-agent-running/15 text-agent-running border-agent-running/30',
    pulse: true,
  },
  waiting: {
    label: 'Waiting',
    icon: CirclePause,
    className: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
    pulse: true,
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'bg-agent-success/15 text-agent-success border-agent-success/30',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'bg-agent-error/15 text-agent-error border-agent-error/30',
  },
  timed_out: {
    label: 'Timed Out',
    icon: Clock,
    className: 'bg-agent-warning/15 text-agent-warning border-agent-warning/30',
  },
}

export function AgentStatusBadge({ status, agentType, compact = false, className }: AgentStatusBadgeProps) {
  const config = STATUS_CONFIG[status || 'idle'] || STATUS_CONFIG.idle
  const Icon = config.icon

  if (compact) {
    return (
      <span className={cn('relative flex h-2.5 w-2.5', className)}>
        {config.pulse && (
          <span className={cn(
            'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
            status === 'running' ? 'bg-agent-running' : 'bg-agent-waiting'
          )} />
        )}
        <span className={cn(
          'relative inline-flex rounded-full h-2.5 w-2.5',
          status === 'running' ? 'bg-agent-running'
            : status === 'waiting' ? 'bg-agent-waiting'
            : status === 'completed' ? 'bg-agent-success'
            : status === 'failed' ? 'bg-agent-error'
            : 'bg-muted-foreground'
        )} />
      </span>
    )
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 font-medium',
        config.className,
        className
      )}
    >
      <Icon className={cn(
        'h-3 w-3',
        status === 'running' && 'animate-spin'
      )} />
      {agentType && <span className="capitalize">{agentType.replace(/[_-]/g, ' ')}</span>}
      <span>{config.label}</span>
    </Badge>
  )
}
