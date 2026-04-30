import { cn } from '@/lib/utils';

export interface StageStep {
  key: string;
  label: string;
  mandatory: boolean;
}

interface Props {
  step: StageStep;
  isDone: boolean;
  isSkipped?: boolean; // conditionnel non réalisé dans une phase passée
  isActive: boolean;
  isCurrentPhase: boolean;
  isPastPhase: boolean;
  mandatoryBg: string;
  conditionalBg: string;
}

export function StepNode({ step, isDone, isSkipped = false, isActive, isCurrentPhase, isPastPhase, mandatoryBg, conditionalBg }: Props) {
  return (
    <div className={cn(
      'relative flex flex-col items-center justify-center rounded-md border-2 px-3 py-2 min-w-[110px] text-center transition-all',
      step.mandatory ? mandatoryBg : conditionalBg,
      // Futur non atteint
      !isDone && !isSkipped && !isActive && !isCurrentPhase && !isPastPhase && 'opacity-40 grayscale',
      // Conditionnel skippé — grisé avec strikethrough
      isSkipped && 'opacity-30 grayscale border-dashed',
      // Done — vert
      isDone && 'bg-green-100 dark:bg-green-900/50 border-green-500 dark:border-green-500',
      // Actif — pulsing
      isActive && 'ring-2 ring-agent-running ring-offset-1 ring-offset-background',
    )}>
      <span className={cn(
        'text-[11px] font-semibold leading-tight',
        isDone ? 'text-green-800 dark:text-green-200' : isSkipped ? 'line-through text-muted-foreground' : 'text-foreground/80',
      )}>
        {step.label}
      </span>
      <span className={cn(
        'text-[9px] font-bold uppercase tracking-wider mt-0.5',
        isDone ? 'text-green-600 dark:text-green-400'
          : isSkipped ? 'text-muted-foreground/50'
          : step.mandatory ? 'text-green-700 dark:text-green-400'
          : 'text-yellow-600 dark:text-yellow-400',
      )}>
        {isDone ? '✓ Done' : isSkipped ? '— Skipped' : step.mandatory ? 'MANDATORY' : 'CONDITIONAL'}
      </span>
      {isActive && (
        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-agent-running animate-ping" />
      )}
    </div>
  );
}
