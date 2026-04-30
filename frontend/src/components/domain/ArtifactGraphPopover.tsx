import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Network, ArrowRight, ArrowLeft, Loader2 } from 'lucide-react'
import type { ArtifactNeighbor } from '@/hooks/useSprintGraph'

const TYPE_COLORS: Record<string, string> = {
  Requirement: 'bg-orange-500/15 text-orange-600 border-orange-500/30',
  UserStory: 'bg-green-500/15 text-green-600 border-green-500/30',
  Task: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  CodeFile: 'bg-red-500/15 text-red-600 border-red-500/30',
  Review: 'bg-purple-500/15 text-purple-600 border-purple-500/30',
  Question: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  GeneralInfo: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
}

const EDGE_LABELS: Record<string, string> = {
  BREAKS_INTO: 'Breaks into',
  IMPLEMENTED_BY: 'Implemented by',
  DEPENDS_ON: 'Depends on',
  REVIEWS: 'Reviews',
  VALIDATES: 'Validates',
  INFLUENCES: 'Influences',
  RELATES_TO: 'Relates to',
  CARRIED_FROM: 'Carried from',
}

interface ArtifactGraphPopoverProps {
  neighbors: ArtifactNeighbor[]
  loading?: boolean
  className?: string
}

export function ArtifactGraphPopover({
  neighbors,
  loading,
  className,
}: ArtifactGraphPopoverProps) {
  if (loading) {
    return (
      <Button variant="ghost" size="icon" className={cn('h-6 w-6', className)} disabled>
        <Loader2 className="h-3 w-3 animate-spin" />
      </Button>
    )
  }

  if (neighbors.length === 0) return null

  // Group by edge label for cleaner display
  const grouped = new Map<string, ArtifactNeighbor[]>()
  neighbors.forEach(n => {
    const key = `${n.direction}:${n.edgeLabel}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(n)
  })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6 relative', className)}
        >
          <Network className="h-3 w-3" />
          <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-primary text-[8px] text-primary-foreground flex items-center justify-center">
            {neighbors.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="px-3 py-2 border-b">
          <div className="flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Graph Context</span>
            <Badge variant="secondary" className="h-4 px-1 text-[9px] ml-auto">
              {neighbors.length} connection{neighbors.length !== 1 ? 's' : ''}
            </Badge>
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-2 space-y-2">
          {Array.from(grouped.entries()).map(([key, items]) => {
            const direction = key.startsWith('outgoing') ? 'outgoing' : 'incoming'
            const edgeLabel = key.split(':')[1]
            const readableEdge = EDGE_LABELS[edgeLabel] || edgeLabel.replace(/_/g, ' ').toLowerCase()
            return (
              <div key={key}>
                <div className="flex items-center gap-1 mb-1">
                  {direction === 'outgoing' ? (
                    <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/60" />
                  ) : (
                    <ArrowLeft className="h-2.5 w-2.5 text-muted-foreground/60" />
                  )}
                  <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                    {readableEdge}
                  </span>
                </div>
                <div className="space-y-0.5 ml-4">
                  {items.map(neighbor => (
                    <div
                      key={neighbor.id}
                      className="flex items-center gap-1.5 py-0.5"
                    >
                      <Badge
                        variant="outline"
                        className={cn(
                          'h-4 px-1 text-[8px] shrink-0',
                          TYPE_COLORS[neighbor.type] || 'bg-muted text-muted-foreground',
                        )}
                      >
                        {neighbor.type.replace('UserStory', 'Story').replace('CodeFile', 'Code').replace('GeneralInfo', 'Info')}
                      </Badge>
                      <span className="text-[11px] text-foreground truncate" title={neighbor.label}>
                        {neighbor.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
