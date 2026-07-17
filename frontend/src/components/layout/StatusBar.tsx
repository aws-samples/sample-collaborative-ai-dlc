import { useEffect, useState } from 'react';
import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import { realtimeService } from '@/services/realtime';
import type { ConnectionStatus } from '@/services/realtime';

export function StatusBar() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    realtimeService.getStatus(),
  );
  useEffect(() => realtimeService.onStatusChange(setConnectionStatus), []);

  return (
    <footer className="flex h-6 shrink-0 items-center border-t bg-background px-3 text-[11px] text-muted-foreground gap-3">
      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        {connectionStatus === 'connected' ? (
          <>
            <Wifi className="h-3 w-3 text-agent-success" />
            <span>Connected</span>
          </>
        ) : connectionStatus === 'connecting' ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-agent-waiting" />
            <span>Connecting...</span>
          </>
        ) : (
          <>
            <WifiOff className="h-3 w-3 text-agent-error" />
            <span>Disconnected</span>
          </>
        )}
      </div>

      {/* Right side: version/env */}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted-foreground/50">
          AI-DLC v{import.meta.env.VITE_APP_VERSION}
          {import.meta.env.VITE_ENVIRONMENT ? ` | ${import.meta.env.VITE_ENVIRONMENT}` : ''}
        </span>
      </div>
    </footer>
  );
}
