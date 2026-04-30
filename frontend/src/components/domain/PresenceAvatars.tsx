import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Colors for presence avatars (deterministic based on user ID)
const PRESENCE_COLORS = [
  'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-pink-500',
  'bg-amber-500', 'bg-cyan-500', 'bg-rose-500', 'bg-indigo-500',
]

interface PresenceUser {
  userId: string
  displayName: string
  activity?: string
}

interface PresenceAvatarsProps {
  users?: PresenceUser[]
  maxVisible?: number
}

export function PresenceAvatars({ users = [], maxVisible = 4 }: PresenceAvatarsProps) {
  if (users.length === 0) return null

  const visible = users.slice(0, maxVisible)
  const overflow = users.length - maxVisible

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((user) => {
        const colorIndex = hashCode(user.userId) % PRESENCE_COLORS.length
        const initials = user.displayName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)

        return (
          <Tooltip key={user.userId}>
            <TooltipTrigger>
              <Avatar className="h-6 w-6 border-2 border-background">
                <AvatarFallback
                  className={cn(
                    'text-[9px] text-white font-medium',
                    PRESENCE_COLORS[colorIndex]
                  )}
                >
                  {initials}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{user.displayName}</p>
              {user.activity && (
                <p className="text-xs text-muted-foreground">{user.activity}</p>
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger>
            <Avatar className="h-6 w-6 border-2 border-background">
              <AvatarFallback className="text-[9px] bg-muted text-muted-foreground">
                +{overflow}
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>
            {users.slice(maxVisible).map(u => u.displayName).join(', ')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash)
}
