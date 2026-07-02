import { cn } from '@/lib/utils';
import { effectiveSprintStatus } from '@/lib/sprintStatus';
import { FolderGit2 } from 'lucide-react';
import { PhaseBlock } from './PhaseBlock';
import { AgentFocusCard } from './AgentFocusCard';
import { GitRepoLink } from '@/components/GitRepoLink';
import { PHASE_CONFIGS, PHASE_ORDER, type PhaseKey } from './phaseConfig';
import type { ProjectAgentInfo, SprintProgress, VelocityMetrics } from '@/hooks/useObservability';
import type { Sprint } from '@/services/sprints';
import type { TaskAgentStatus } from '@/services/agents';

function getStepsDone(
  phase: PhaseKey,
  progress: SprintProgress | null,
  sprint: Sprint | null,
  taskStatuses: TaskAgentStatus[],
): Set<string> {
  const done = new Set<string>();
  if (!sprint) return done;

  if (phase === 'INCEPTION') {
    if (progress?.hasGeneralInfo || progress?.requirementCount) done.add('workspace_detection');
    if (sprint.phase !== 'INCEPTION' || progress?.requirementCount) done.add('previous_context'); // auto
    if (progress?.requirementCount) done.add('requirements_analysis');
    if (progress?.userStoryCount) done.add('user_stories');
    if (progress?.taskCount) {
      done.add('workflow_planning');
      done.add('units_generation');
    }
  }

  if (phase === 'CONSTRUCTION') {
    const hasRunningOrDone = taskStatuses.some(
      (t) => t.executionStatus === 'RUNNING' || t.executionStatus === 'SUCCEEDED',
    );
    const allDone =
      taskStatuses.length > 0 && taskStatuses.every((t) => t.executionStatus === 'SUCCEEDED');
    if (hasRunningOrDone || progress?.codeFileCount) done.add('code_generation');
    if (allDone || sprint.prUrl) done.add('build_and_test');
  }

  if (phase === 'REVIEW') {
    if (sprint.prUrl) done.add('code_review');
    if (effectiveSprintStatus(sprint) === 'passed' || sprint.currentAgentStatus === 'completed')
      done.add('pr_approval');
  }

  return done;
}

// Steps conditionnels qui ne seront pas réalisés — phase passée sans eux
function getStepsSkipped(
  _phase: PhaseKey,
  stepsDone: Set<string>,
  isPastPhase: boolean,
  steps: { key: string; mandatory: boolean }[],
): Set<string> {
  if (!isPastPhase) return new Set();
  const skipped = new Set<string>();
  for (const step of steps) {
    if (!step.mandatory && !stepsDone.has(step.key)) skipped.add(step.key);
  }
  return skipped;
}

interface Props {
  info: ProjectAgentInfo;
  lastTool?: { name: string; timestamp: number };
  pendingQuestions?: number;
  velocity?: VelocityMetrics | null;
  onNavigate: (path: string) => void;
}

export function ProjectDiagram({
  info,
  lastTool,
  pendingQuestions = 0,
  velocity,
  onNavigate,
}: Props) {
  const { project, sprint, progress, taskStatuses } = info;
  const agentStatus = effectiveSprintStatus(sprint);
  const currentPhase = sprint?.phase as PhaseKey | undefined;
  const currentPhaseIdx = currentPhase ? PHASE_ORDER.indexOf(currentPhase) : -1;

  const handleClick = () => {
    if (!sprint) {
      onNavigate(`/project/${project.id}`);
      return;
    }
    const route =
      currentPhase === 'CONSTRUCTION'
        ? '/construction'
        : currentPhase === 'REVIEW'
          ? '/review'
          : '';
    onNavigate(`/project/${project.id}/sprint/${sprint.id}${route}`);
  };

  return (
    <div
      className={cn(
        'rounded-xl border-2 overflow-hidden cursor-pointer transition-all hover:shadow-lg',
        agentStatus === 'running' && 'border-agent-running/50 shadow-md shadow-agent-running/10',
        agentStatus === 'waiting' && 'border-agent-waiting/50',
        agentStatus !== 'running' &&
          agentStatus !== 'waiting' &&
          'border-border hover:border-foreground/20',
      )}
      onClick={handleClick}
    >
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">{project.name}</span>
          {project.gitRepo && (
            <GitRepoLink
              gitRepo={project.gitRepo}
              gitProvider={project.gitProvider}
              className="text-[11px] text-muted-foreground/60"
              noLink
            />
          )}
        </div>
        <AgentFocusCard
          agentType={sprint?.currentAgentType}
          agentStatus={agentStatus}
          lastTool={lastTool}
          branch={sprint?.branch}
          prUrl={sprint?.prUrl}
          prNumber={sprint?.prNumber}
          pendingQuestions={pendingQuestions}
          progress={progress}
          sprint={sprint}
          velocity={velocity}
        />
      </div>

      <div className="flex justify-center py-3 bg-background">
        <div className="px-4 py-1 rounded-full border-2 border-purple-400 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 text-xs font-medium">
          User Request
        </div>
      </div>

      <div className="px-4 pb-4 bg-background">
        {!sprint && (
          <div className="text-center py-4 text-xs text-muted-foreground/50 italic border border-dashed rounded-lg mb-2">
            No sprint started
          </div>
        )}
        {PHASE_CONFIGS.map((phase, phaseIdx) => {
          const isPastPhase = currentPhaseIdx > phaseIdx;
          const stepsDone = getStepsDone(
            phase.key,
            progress,
            sprint ?? null,
            phase.key === 'CONSTRUCTION' ? taskStatuses : [],
          );
          const stepsSkipped = getStepsSkipped(phase.key, stepsDone, isPastPhase, phase.steps);
          return (
            <div key={phase.key}>
              {phaseIdx > 0 && (
                <div className="flex justify-center py-1 text-muted-foreground/40 text-sm">↓</div>
              )}
              <PhaseBlock
                config={phase}
                stepsDone={stepsDone}
                stepsSkipped={stepsSkipped}
                isCurrentPhase={phase.key === currentPhase}
                isPastPhase={isPastPhase}
                isFuturePhase={
                  sprint !== null && currentPhaseIdx !== -1 && currentPhaseIdx < phaseIdx
                }
                isUnlocked={
                  sprint !== null && (currentPhaseIdx === -1 || currentPhaseIdx >= phaseIdx)
                }
                agentStatus={agentStatus}
                progress={progress}
                sprint={sprint ?? null}
                taskStatuses={phase.key === 'CONSTRUCTION' ? taskStatuses : []}
                prUrl={phase.key === 'REVIEW' ? (sprint?.prUrl ?? null) : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
