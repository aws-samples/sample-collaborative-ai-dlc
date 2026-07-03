import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Loader2, MessageCircleQuestion, CheckCircle2, XCircle } from 'lucide-react';
import { effectiveIntentStatus } from '@/lib/sprintStatus';
import type { ProjectWithSprint } from '@/hooks/useProjectsCache';
import type { EffectiveSprintStatus } from '@/lib/sprintStatus';

interface IntentStatusCardsProps {
  items: ProjectWithSprint[];
}

const STATUS_CONFIG: Record<
  string,
  {
    icon: typeof Loader2;
    borderClass: string;
    bgClass: string;
    label: string;
    color: string;
  }
> = {
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
  passed: {
    icon: CheckCircle2,
    borderClass: 'border-border',
    bgClass: 'bg-background/70',
    label: 'Succeeded',
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

function formatAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sortByIntentStatus(a: ProjectWithSprint, b: ProjectWithSprint): number {
  const order: Record<string, number> = { running: 0, waiting: 1, failed: 2, passed: 3 };
  const aStatus = effectiveIntentStatus(a.latestIntent);
  const bStatus = effectiveIntentStatus(b.latestIntent);
  return (order[aStatus] ?? 5) - (order[bStatus] ?? 5);
}

export function IntentStatusCards({ items }: IntentStatusCardsProps) {
  const visible = useMemo(
    () =>
      items
        .filter((p) => effectiveIntentStatus(p.latestIntent) !== 'idle')
        .toSorted(sortByIntentStatus),
    [items],
  );

  const navigate = useNavigate();

  if (visible.length === 0) return null;

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        V2 Intents
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map(({ project, latestIntent }) => {
          if (!latestIntent) return null;
          const status: EffectiveSprintStatus = effectiveIntentStatus(latestIntent);
          const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.passed;
          const StatusIcon = cfg.icon;
          const isActive = status === 'running' || status === 'waiting';

          return (
            <div
              key={project.id}
              onClick={() =>
                navigate(`/project/${project.id}/intent/${latestIntent.id}/observability`)
              }
              className={cn(
                'flex flex-col overflow-hidden rounded-xl border shadow-sm transition-shadow cursor-pointer hover:shadow-md',
                cfg.borderClass,
                cfg.bgClass,
              )}
            >
              <div className="border-b border-border/60 px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {isActive ? (
                        <span className="relative flex h-2.5 w-2.5 shrink-0">
                          <span
                            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70"
                            style={{
                              color: status === 'running' ? 'rgb(59,130,246)' : 'rgb(234,179,8)',
                            }}
                          />
                          <span
                            className={cn(
                              'relative inline-flex h-2.5 w-2.5 rounded-full',
                              status === 'running' ? 'bg-agent-running' : 'bg-agent-waiting',
                            )}
                          />
                        </span>
                      ) : (
                        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
                      )}
                      <span className="text-sm font-semibold truncate">{project.name}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {isActive
                        ? 'Live now'
                        : `${cfg.label} · ${formatAgo(latestIntent.completedAt ?? latestIntent.updatedAt)}`}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'gap-1 text-[10px] h-5 font-medium shrink-0',
                      cfg.color,
                      'border-current/30',
                    )}
                  >
                    <StatusIcon className={cn('h-3 w-3', status === 'running' && 'animate-spin')} />
                    {cfg.label}
                  </Badge>
                </div>
              </div>

              <div className="flex-1 px-3 py-3 space-y-2">
                {latestIntent.title && (
                  <p className="text-xs truncate text-muted-foreground">{latestIntent.title}</p>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  {latestIntent.scope && (
                    <Badge variant="outline" className="text-[10px] h-5 bg-muted/40">
                      {latestIntent.scope}
                    </Badge>
                  )}
                  {latestIntent.createdAt && (
                    <span className="text-[10px] text-muted-foreground/60">
                      created {formatAgo(latestIntent.createdAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
