import { cn } from '@/lib/utils'
import { Wifi, WifiOff, Bot, Loader2 } from 'lucide-react'
import { Separator } from '@/components/ui/separator'

export function StatusBar() {
  // These will be connected to real state via SprintContext later
  const connectionStatus = 'connected' as 'connected' | 'connecting' | 'disconnected'
  const agentInfo = null as { status: string; type: string } | null

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

      <Separator orientation="vertical" className="h-3" />

      {/* Agent status */}
      {agentInfo ? (
        <div className="flex items-center gap-1.5">
          <Bot className="h-3 w-3" />
          <span>{agentInfo.type}</span>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            agentInfo.status === 'running' ? 'bg-agent-running animate-pulse' :
            agentInfo.status === 'completed' ? 'bg-agent-success' : 'bg-agent-idle'
          )} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Bot className="h-3 w-3" />
          <span>No agent active</span>
        </div>
      )}

      {/* Right side: version/env */}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted-foreground/50">AI-DLC</span>
      </div>
    </footer>
  )
}
