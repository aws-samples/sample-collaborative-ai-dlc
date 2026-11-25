import { useEffect, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router';
import { CircleCheck, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { realtimeService } from '@/services/realtime';
import type { ConnectionStatus } from '@/services/realtime';
import { useIntentOptional } from '@/contexts/IntentContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { isTerminalIntentStatus } from '@/lib/statusModel';

const LIVE_HINT =
  'Status changes appear without refreshing. Collaborative editing shows its own status on the page.';
const ENDED_HINT = 'This run has ended. Nothing on this page changes on its own.';
const LEGACY_HINT = 'Legacy space, read-only. Nothing on this page changes on its own.';
const CONNECTING_HINT = 'Connecting to live updates.';
const PAUSED_HINT = 'Live updates paused. Reconnecting automatically.';
const COLLAB_HINT =
  'Live collaboration on this page is unavailable. The page says what is affected.';

// Pages with live collaboration (Yjs) report when it is unavailable, so the
// footer never says "Live updates" above a page that says the opposite.
const unavailableReporters = new Set<symbol>();
const collabListeners = new Set<() => void>();
const notifyCollab = () => collabListeners.forEach((listener) => listener());
const subscribeCollab = (listener: () => void) => {
  collabListeners.add(listener);
  return () => collabListeners.delete(listener);
};
const collabUnavailable = () => unavailableReporters.size > 0;

/** Call from any component that owns a live-collaboration connection. */
export function useReportCollaboration(connection: 'connecting' | 'synced' | 'unavailable') {
  const unavailable = connection === 'unavailable';
  useEffect(() => {
    if (!unavailable) return;
    const token = Symbol('collaboration');
    unavailableReporters.add(token);
    notifyCollab();
    return () => {
      unavailableReporters.delete(token);
      notifyCollab();
    };
  }, [unavailable]);
}

/**
 * Why the current page has nothing that can update live: an ended intent or a
 * read-only legacy (v1) space. `null` when the page has a live subject.
 */
function useNoLiveSubject(): 'ended' | 'legacy' | null {
  const { projectId, intentId, sprintId } = useParams<{
    projectId?: string;
    intentId?: string;
    sprintId?: string;
  }>();
  const detail = useIntentOptional()?.detail;
  const { project } = useProjectCache(projectId ?? null);
  if (intentId) {
    const current = detail?.intent?.id === intentId ? detail.intent : null;
    return current && isTerminalIntentStatus(current.status) ? 'ended' : null;
  }
  if (sprintId) return 'legacy';
  if (projectId && project && project.kind !== 'v2') return 'legacy';
  return null;
}

export function StatusBar() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    realtimeService.getStatus(),
  );
  useEffect(() => realtimeService.onStatusChange(setConnectionStatus), []);
  const pageCollabUnavailable = useSyncExternalStore(subscribeCollab, collabUnavailable);
  const noLiveSubject = useNoLiveSubject();
  const live = connectionStatus === 'connected' && !pageCollabUnavailable;
  // Experts quote the build in bug reports; the title keeps it apart from the
  // AI-DLC version an intent runs on.
  const build = [
    import.meta.env.VITE_APP_VERSION ? `v${import.meta.env.VITE_APP_VERSION}` : null,
    import.meta.env.VITE_ENVIRONMENT,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <footer className="flex h-6 shrink-0 items-center border-t bg-background px-3 text-2xs text-muted-foreground gap-3">
      {live && noLiveSubject && (
        <div
          className="flex items-center gap-1.5"
          title={noLiveSubject === 'ended' ? ENDED_HINT : LEGACY_HINT}
        >
          <CircleCheck className="h-3 w-3" aria-hidden="true" />
          <span>Up to date</span>
        </div>
      )}
      {live && !noLiveSubject && (
        <div className="flex items-center gap-1.5" title={LIVE_HINT}>
          <Wifi className="h-3 w-3 text-agent-success-fg" aria-hidden="true" />
          <span>Live updates</span>
        </div>
      )}
      {connectionStatus === 'connecting' && (
        <div className="flex items-center gap-1.5" role="status" title={CONNECTING_HINT}>
          <Loader2 className="h-3 w-3 animate-spin text-agent-waiting-fg" aria-hidden="true" />
          <span>Live updates paused</span>
        </div>
      )}
      {(connectionStatus === 'disconnected' ||
        connectionStatus === 'error' ||
        (connectionStatus === 'connected' && pageCollabUnavailable)) && (
        <div
          className="flex items-center gap-1.5"
          role="status"
          title={connectionStatus === 'connected' ? COLLAB_HINT : PAUSED_HINT}
        >
          <WifiOff className="h-3 w-3 text-agent-error-fg" aria-hidden="true" />
          <span>Live updates paused</span>
        </div>
      )}

      {build && (
        <span className="ml-auto" title="Application version and deployment environment">
          {build}
        </span>
      )}
    </footer>
  );
}
