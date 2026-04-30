import { cn } from '@/lib/utils'

interface PhaseProgressRingProps {
  /** Progress value from 0 to 100 */
  value: number
  /** Size in pixels */
  size?: number
  /** Stroke width in pixels */
  strokeWidth?: number
  /** Phase type for coloring */
  phase: 'inception' | 'construction' | 'review'
  /** Show percentage text in center */
  showValue?: boolean
  className?: string
}

const PHASE_COLORS: Record<string, { track: string; bar: string }> = {
  inception: { track: 'stroke-phase-inception/20', bar: 'stroke-phase-inception' },
  construction: { track: 'stroke-phase-construction/20', bar: 'stroke-phase-construction' },
  review: { track: 'stroke-phase-review/20', bar: 'stroke-phase-review' },
}

export function PhaseProgressRing({
  value,
  size = 40,
  strokeWidth = 3,
  phase,
  showValue = true,
  className,
}: PhaseProgressRingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (Math.min(100, Math.max(0, value)) / 100) * circumference
  const colors = PHASE_COLORS[phase]

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className={colors.track}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(colors.bar, 'transition-all duration-500 ease-out')}
        />
      </svg>
      {showValue && (
        <span className="absolute text-[9px] font-semibold text-foreground">
          {Math.round(value)}%
        </span>
      )}
    </div>
  )
}

interface SegmentedRingProps {
  segments: Array<{
    value: number
    color: string
    label?: string
  }>
  size?: number
  strokeWidth?: number
  className?: string
}

export function SegmentedRing({
  segments,
  size = 48,
  strokeWidth = 4,
  className,
}: SegmentedRingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const total = segments.reduce((sum, s) => sum + s.value, 0)

  let currentOffset = 0

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-muted"
        />
        {/* Segments */}
        {segments.map((segment, i) => {
          const segmentLength = total > 0 ? (segment.value / total) * circumference : 0
          const dash = `${segmentLength} ${circumference - segmentLength}`
          const offset = currentOffset
          currentOffset += segmentLength

          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              className={cn(segment.color, 'transition-all duration-500 ease-out')}
            />
          )
        })}
      </svg>
    </div>
  )
}
