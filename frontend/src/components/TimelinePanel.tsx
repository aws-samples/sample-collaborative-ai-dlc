import { useState } from 'react';
import type { TimelineEvent } from '../services/timelineEvents';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
}

const typeConfig: Record<string, { color: string; icon: string }> = {
  agent_started: { color: 'bg-blue-500', icon: '>' },
  agent_completed: { color: 'bg-blue-500', icon: '#' },
  agent_failed: { color: 'bg-red-500', icon: '!' },
  question_asked: { color: 'bg-yellow-500', icon: '?' },
  question_answered: { color: 'bg-yellow-500', icon: '*' },
  artifact_created: { color: 'bg-green-500', icon: '+' },
  artifact_updated: { color: 'bg-green-500', icon: '~' },
  artifact_deleted: { color: 'bg-green-500', icon: '-' },
  phase_changed: { color: 'bg-gray-400', icon: '>' },
  started_over: { color: 'bg-gray-400', icon: '<' },
  agent_invoked: { color: 'bg-purple-500', icon: '~' },
};

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TimelinePanel({ events, loading }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return <div className="text-center text-muted-foreground text-sm py-4">Loading...</div>;
  }

  if (events.length === 0) {
    return <p className="text-center py-4 text-muted-foreground text-sm">No events yet</p>;
  }

  return (
    <div className="max-h-96 overflow-y-auto">
      {events.map((event, idx) => {
        const config = typeConfig[event.type] || { color: 'bg-gray-400', icon: '?' };
        const isLast = idx === events.length - 1;
        const isExpanded = expandedId === event.id;

        return (
          <div key={event.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`w-3 h-3 rounded-full ${config.color} flex-shrink-0 mt-1`} />
              {!isLast && <div className="w-px flex-1 bg-border min-h-[24px]" />}
            </div>
            <div className="pb-4 min-w-0 flex-1">
              <p className="text-sm leading-tight">{event.title}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground">{relativeTime(event.timestamp)}</span>
                {event.userName && (
                  <span className="text-xs text-muted-foreground">by {event.userName}</span>
                )}
              </div>
              {event.detail && (
                <button
                  onClick={() => setExpandedId(isExpanded ? null : event.id)}
                  className="text-xs text-primary mt-1 hover:underline"
                >
                  {isExpanded ? 'Hide details' : 'Show details'}
                </button>
              )}
              {isExpanded && event.detail && (
                <pre className="mt-1 text-xs text-muted-foreground bg-muted rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {event.detail}
                </pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
