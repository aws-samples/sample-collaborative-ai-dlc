import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Bot, CheckCircle2, XCircle, MessageCircleQuestion, Wrench } from 'lucide-react';
import { semanticTool } from '@/lib/observability/toolLabels';
import type { ActivityEvent } from '@/hooks/useObservability';

interface Props {
  events: ActivityEvent[];
  /** sprintId → project name, for multi-project context */
  projectNames?: Record<string, string>;
}

const EVENT_CONFIG: Record<string, { icon: typeof Bot; color: string }> = {
  'agent.started':   { icon: Bot,                  color: 'text-agent-running'    },
  'agent.completed': { icon: CheckCircle2,          color: 'text-agent-success'    },
  'agent.error':     { icon: XCircle,               color: 'text-agent-error'      },
  'agent.question':  { icon: MessageCircleQuestion, color: 'text-agent-waiting'    },
  'agent.tool':      { icon: Wrench,                color: 'text-muted-foreground' },
};

const SEMANTIC_LABELS: Record<string, string> = {
  'agent.started':   'Agent started',
  'agent.completed': 'Agent completed',
  'agent.error':     'Agent failed',
  'agent.question':  '⚠ Question asked — pipeline blocked',
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function ActivityFeed({ events, projectNames = {} }: Props) {
  const multiProject = Object.keys(projectNames).length > 1;

  // Collapse consecutive tool calls with same semantic label + same sprint
  const collapsed: (ActivityEvent & { count?: number })[] = [];
  for (const evt of events.slice(0, 80)) {
    if (evt.type === 'agent.tool') {
      const label = semanticTool(evt.detail ?? '');
      const last = collapsed[collapsed.length - 1];
      if (last?.type === 'agent.tool' && semanticTool(last.detail ?? '') === label && last.sprintId === evt.sprintId) {
        last.count = (last.count ?? 1) + 1;
        last.timestamp = evt.timestamp;
        continue;
      }
    }
    collapsed.push({ ...evt });
    if (collapsed.length >= 25) break;
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="divide-y divide-border max-h-52 overflow-y-auto">
          {collapsed.map(evt => {
            const cfg = EVENT_CONFIG[evt.type] ?? EVENT_CONFIG['agent.tool'];
            const Icon = cfg.icon;
            const isSignificant = evt.type !== 'agent.tool';
            const label = isSignificant
              ? (SEMANTIC_LABELS[evt.type] ?? evt.type)
              : semanticTool(evt.detail ?? 'Tool call');

            const projectName = evt.sprintId ? projectNames[evt.sprintId] : undefined;
            // Show project name when multi-project; show agent type for significant events
            const suffix = [
              multiProject && projectName ? projectName : null,
              isSignificant && evt.agentType ? evt.agentType.replace(/[_-]/g, ' ') : null,
            ].filter(Boolean).join(' · ');

            return (
              <div key={evt.id} className={cn('px-3 py-1.5 flex items-center gap-2', isSignificant && 'bg-muted/20')}>
                <Icon className={cn('h-3 w-3 shrink-0', cfg.color)} />
                <span className={cn('text-xs flex-1 truncate', isSignificant ? 'font-medium' : 'text-muted-foreground')}>
                  {label}
                  {suffix && (
                    <span className="text-muted-foreground/50 ml-1 capitalize">· {suffix}</span>
                  )}
                  {evt.count && evt.count > 1 && (
                    <span className="text-muted-foreground/60 ml-1">×{evt.count}</span>
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground/50 shrink-0">{timeAgo(evt.timestamp)}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
