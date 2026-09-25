import type { MethodologyReleasePin } from '@/services/intents';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Header badge naming the AI-DLC release an intent is pinned to. Pinned intents
// never migrate; unpinned (legacy) intents render
// nothing so their UI stays byte-identical to pre-#482.
export function MethodologyReleaseBadge({ release }: { release: MethodologyReleasePin | null }) {
  if (!release) return null;
  const label = release.upstreamVersion || release.sourceSha.slice(0, 7);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="shrink-0 font-mono text-[10px]"
            data-testid="methodology-release-badge"
          >
            AI-DLC {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-0.5 text-xs">
            <div>Pinned to {release.releaseId}</div>
            <div className="text-muted-foreground">
              closure {release.closureDigest.slice(0, 12)}…
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
