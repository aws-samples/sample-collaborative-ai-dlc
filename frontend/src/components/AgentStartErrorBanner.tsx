import { AlertTriangle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AgentStartError } from '@/lib/agentStartError';

interface AgentStartErrorBannerProps {
  error: AgentStartError;
  onDismiss?: () => void;
}

/**
 * Inline banner shown directly next to the "Start Agent" button when dispatch
 * fails. Replaces the silent `console.error` that previously swallowed these
 * errors.
 */
export function AgentStartErrorBanner({ error, onDismiss }: AgentStartErrorBannerProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-agent-error/30 bg-agent-error/10 px-3 py-2 text-sm text-agent-error">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">Couldn't start the agent</div>
        <div className="mt-0.5 break-words">{error.message}</div>
        {error.actionHref && error.actionLabel && (
          <Link
            to={error.actionHref}
            className="mt-1 inline-block text-xs font-medium underline underline-offset-2 hover:no-underline"
          >
            {error.actionLabel} →
          </Link>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
