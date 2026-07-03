import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StageState } from '@/services/intents';
import { Loader2, CheckCircle2, XCircle, MessageCircleQuestion, Circle } from 'lucide-react';

// Stage-state visual config, mirroring the agent-status color tokens. Shared by
// the stage list, the intent graph and the activity sidebar so every surface
// colors a stage state identically.
export const STAGE_STYLE: Record<StageState, { label: string; cls: string; Icon: typeof Circle }> =
  {
    PENDING: { label: 'Pending', cls: 'bg-muted text-muted-foreground', Icon: Circle },
    RUNNING: {
      label: 'Running',
      cls: 'bg-agent-running/15 text-agent-running border-agent-running/30',
      Icon: Loader2,
    },
    WAITING_FOR_HUMAN: {
      label: 'Waiting',
      cls: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
      Icon: MessageCircleQuestion,
    },
    SUCCEEDED: {
      label: 'Succeeded',
      cls: 'bg-agent-success/15 text-agent-success border-agent-success/30',
      Icon: CheckCircle2,
    },
    FAILED: {
      label: 'Failed',
      cls: 'bg-agent-error/15 text-agent-error border-agent-error/30',
      Icon: XCircle,
    },
    SKIPPED: {
      label: 'Skipped',
      cls: 'bg-muted/50 text-muted-foreground opacity-60',
      Icon: Circle,
    },
  };

export function StageBadge({ state }: { state: StageState }) {
  const { label, cls, Icon } = STAGE_STYLE[state] ?? STAGE_STYLE.PENDING;
  return (
    <Badge variant="outline" className={cn('gap-1 text-[10px]', cls)}>
      <Icon className={cn('h-3 w-3', state === 'RUNNING' && 'animate-spin')} />
      {label}
    </Badge>
  );
}

// "3m 42s" style duration between two ISO timestamps (end defaults to now, for
// live-ticking rows). Returns null when the start is missing/unparsable.
export function formatDuration(
  startedAt: string | null,
  completedAt?: string | null,
): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return formatSeconds(s);
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Total vs. agent-active duration for a stage. Total is the wall clock from
// first RUNNING to completion (including human waits — startedAt survives
// park/resume cycles). Active subtracts the accumulated waitMs plus the OPEN
// park window: while WAITING_FOR_HUMAN the wait hasn't been folded into
// waitMs yet, so it's derived live from parkedAt (capped at the end bound so
// a stage that parked and then failed doesn't go negative). Both null when
// the stage never started.
export function stageDurations(row: {
  startedAt: string | null;
  completedAt: string | null;
  waitMs?: number;
  parkedAt?: string | null;
}): { total: string; active: string; waiting: string | null; waitedMs: number } | null {
  if (!row.startedAt) return null;
  const start = new Date(row.startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = row.completedAt ? new Date(row.completedAt).getTime() : Date.now();
  const openParkStart = row.parkedAt ? new Date(row.parkedAt).getTime() : NaN;
  const openParkMs = Number.isFinite(openParkStart)
    ? Math.max(0, Math.min(end, Date.now()) - openParkStart)
    : 0;
  const waitedMs = Math.max(0, row.waitMs ?? 0) + openParkMs;
  const totalMs = Math.max(0, end - start);
  const activeMs = Math.max(0, totalMs - waitedMs);
  return {
    total: formatSeconds(Math.round(totalMs / 1000)),
    active: formatSeconds(Math.round(activeMs / 1000)),
    waiting: waitedMs >= 1000 ? formatSeconds(Math.round(waitedMs / 1000)) : null,
    waitedMs,
  };
}

// 1s re-render tick while `active` — drives live elapsed time on RUNNING rows
// without ticking the whole page.
export function useTick(active: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}
