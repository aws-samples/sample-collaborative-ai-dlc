import { cn } from '@/lib/utils';
import { AlertTriangle, MessageCircleQuestion, Clock } from 'lucide-react';
import type { StuckDetection } from '@/hooks/useObservability';

interface Props {
  detections: StuckDetection[];
}

const REASON_CONFIG = {
  blocked_question: {
    icon: MessageCircleQuestion,
    bg: 'bg-yellow-50 dark:bg-yellow-950/40 border-yellow-500',
    text: 'text-yellow-800 dark:text-yellow-200',
    label: 'BLOCKED — WAITING FOR ANSWER',
    borderWidth: 'border-2',
  },
  repeated_tool: {
    icon: AlertTriangle,
    bg: 'bg-red-50 dark:bg-red-950/40 border-red-400',
    text: 'text-red-800 dark:text-red-200',
    label: 'STUCK',
    borderWidth: 'border-2',
  },
  idle: {
    icon: Clock,
    bg: 'bg-orange-50 dark:bg-orange-950/40 border-orange-400',
    text: 'text-orange-800 dark:text-orange-200',
    label: 'IDLE',
    borderWidth: 'border',
  },
} as const;

export function StuckAlert({ detections }: Props) {
  if (detections.length === 0) return null;

  // Sort: critical first
  const sorted = [...detections].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className="space-y-2">
      {sorted.map((d, i) => {
        const cfg = REASON_CONFIG[d.reason];
        const Icon = cfg.icon;
        return (
          <div key={`${d.sprintId}-${d.reason}-${i}`}
            className={cn('flex items-start gap-3 rounded-lg px-4 py-3', cfg.bg, cfg.borderWidth,
              d.reason === 'blocked_question' && 'animate-pulse shadow-md shadow-yellow-200 dark:shadow-yellow-900/30'
            )}>
            <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', cfg.text)} />
            <div className="flex-1 min-w-0">
              <div className={cn('text-xs font-bold tracking-wider', cfg.text)}>
                {cfg.label} — {d.projectName}
              </div>
              <div className={cn('text-xs mt-0.5', cfg.text, 'opacity-80')}>
                {d.message}
              </div>
            </div>
            {d.durationMs > 0 && (
              <span className={cn('text-[10px] shrink-0 opacity-60', cfg.text)}>
                {Math.round(d.durationMs / 60000)}m
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
