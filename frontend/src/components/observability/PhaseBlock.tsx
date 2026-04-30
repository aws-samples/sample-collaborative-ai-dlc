import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { StepNode } from './StepNode';
import { TaskStatusRow } from './TaskStatusRow';
import type { PhaseConfig } from './phaseConfig';
import type { SprintProgress } from '@/hooks/useObservability';
import type { Sprint } from '@/services/sprints';
import type { TaskAgentStatus } from '@/services/agents';

export type { PhaseConfig };

interface Props {
  config: PhaseConfig;
  stepsDone: Set<string>;
  stepsSkipped?: Set<string>;
  isCurrentPhase: boolean;
  isPastPhase: boolean;
  isFuturePhase: boolean;
  isUnlocked: boolean;
  agentStatus?: string | null;
  progress: SprintProgress | null;
  sprint: Sprint | null;
  taskStatuses?: TaskAgentStatus[];
  prUrl?: string | null;
}

export function PhaseBlock({ config, stepsDone, stepsSkipped = new Set(), isCurrentPhase, isPastPhase, isFuturePhase, isUnlocked, agentStatus, progress, taskStatuses = [], prUrl }: Props) {
  const runningTasks = taskStatuses.filter(t => t.executionStatus === 'RUNNING');

  return (
    <div className={cn(
      'rounded-lg border-2 overflow-hidden transition-all',
      config.blockBorder, config.blockBg,
      (isFuturePhase || !isUnlocked) && 'opacity-35',
      isCurrentPhase && 'ring-2 ring-offset-1 ring-offset-background',
      isCurrentPhase && config.key === 'INCEPTION' && 'ring-blue-400/60',
      isCurrentPhase && config.key === 'CONSTRUCTION' && 'ring-green-400/60',
      isCurrentPhase && config.key === 'REVIEW' && 'ring-purple-400/60',
    )}>
      <div className={cn('flex items-center gap-2 px-3 py-1.5', config.headerBg)}>
        <span className="text-sm">{config.icon}</span>
        <span className={cn('text-xs font-bold tracking-wider', config.headerText)}>{config.label}</span>
        {isCurrentPhase && agentStatus === 'running' && <Loader2 className="h-3 w-3 ml-1 animate-spin text-agent-running" />}
        {isPastPhase && <CheckCircle2 className="h-3 w-3 ml-1 text-agent-success" />}
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer"
            className="ml-1 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 border border-green-400 hover:underline"
            onClick={e => e.stopPropagation()}>
            ✓ PR Created
          </a>
        )}
        {(isCurrentPhase || isPastPhase) && config.steps.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className={cn('text-[10px] font-medium opacity-70', config.headerText)}>
              {(progress?.totalNodes ?? 0) > 0 ? `${stepsDone.size}/${config.steps.length}` : '—'}
            </span>
            {isCurrentPhase && (progress?.totalNodes ?? 0) > 0 ? (
              <div className="w-16 h-1.5 rounded-full bg-black/10 overflow-hidden">
                <div className="h-full rounded-full bg-current transition-all duration-500"
                  style={{ width: `${Math.round((stepsDone.size / config.steps.length) * 100)}%`, opacity: 0.6 }} />
              </div>
            ) : null}
          </div>
        )}
        {isCurrentPhase && progress && config.key === 'CONSTRUCTION' && progress.taskCount > 0 && (
          <span className={cn('text-[10px] ml-1', progress.taskDoneCount === progress.taskCount ? 'text-agent-success' : 'text-muted-foreground')}>
            {progress.taskDoneCount}/{progress.taskCount} tasks{progress.codeFileCount > 0 ? ` · ${progress.codeFileCount} files` : ''}
            {runningTasks.length > 0 && <span className="text-agent-running font-medium"> · {runningTasks.length} running</span>}
          </span>
        )}
      </div>

      {config.steps.length > 0 && (
        <div className="p-2.5 space-y-2">
          {/* Rangée principale — avec flèches entre les steps */}
          <div className="flex flex-wrap items-center gap-1">
            {config.mainSteps.map((step, idx) => {
              const isFirstIncompleteMandatory = isCurrentPhase && agentStatus === 'running' && step.mandatory && !stepsDone.has(step.key)
                && !config.mainSteps.some(s => s.mandatory && !stepsDone.has(s.key) && config.mainSteps.indexOf(s) < idx);
              return (
                <div key={step.key} className="flex items-center gap-1">
                  {idx > 0 && <span className="text-muted-foreground/40 text-xs">→</span>}
                  <StepNode step={step} isDone={stepsDone.has(step.key)}
                    isSkipped={stepsSkipped.has(step.key)}
                    isActive={isFirstIncompleteMandatory} isCurrentPhase={isCurrentPhase}
                    isPastPhase={isPastPhase} mandatoryBg={config.mandatoryBg} conditionalBg={config.conditionalBg} />
                </div>
              );
            })}
          </div>

          {/* Rangée secondaire — conditionnels sous la principale */}
          {config.subSteps.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pl-2 border-l-2 border-dashed border-muted-foreground/20">
              {config.subSteps.map((step) => (
                <StepNode key={step.key} step={step} isDone={stepsDone.has(step.key)}
                  isSkipped={stepsSkipped.has(step.key)}
                  isActive={false} isCurrentPhase={isCurrentPhase}
                  isPastPhase={isPastPhase} mandatoryBg={config.mandatoryBg} conditionalBg={config.conditionalBg} />
              ))}
            </div>
          )}

          {/* Next Unit loop pour Construction */}
          {config.key === 'CONSTRUCTION' && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 italic">
              <span className="border-t border-dashed border-muted-foreground/30 flex-1" />
              <span>↺ Next Unit</span>
              <span className="border-t border-dashed border-muted-foreground/30 flex-1" />
            </div>
          )}
        </div>
      )}

      {config.key === 'CONSTRUCTION' && <TaskStatusRow tasks={taskStatuses} />}

      {config.key === 'OPERATIONS' && (
        <div className="p-4 flex justify-center">
          <div className="px-6 py-2 rounded border-2 border-dashed border-muted-foreground/20 text-xs text-muted-foreground/40">
            Operations
          </div>
        </div>
      )}
    </div>
  );
}
