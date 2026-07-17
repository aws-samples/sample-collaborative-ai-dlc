/**
 * Shared utility: build a single semantic focus sentence for an agent.
 * Used by AgentFocusCard and AgentStatusCards.
 */
import { semanticTool } from './toolLabels';
import type { SprintProgress } from '@/hooks/useObservability';
import type { Sprint } from '@/services/sprints';

export function buildFocusSentence(
  agentType: string | null | undefined,
  sprint: Sprint | null | undefined,
  progress: SprintProgress | null | undefined,
  lastTool: { name: string } | undefined,
): string {
  const role = agentType ? agentType.replace(/[_-]/g, ' ') : 'Agent';
  const phase = sprint?.phase;

  if (lastTool) {
    const semantic = semanticTool(lastTool.name);
    if (phase === 'INCEPTION') {
      if (progress?.taskCount) return `${role} — planning (${progress.taskCount} tasks)`;
      if (progress?.requirementCount)
        return `${role} — ${semantic} (${progress.requirementCount} req)`;
      return `${role} — ${semantic}`;
    }
    if (phase === 'CONSTRUCTION') {
      const done = progress?.taskDoneCount ?? 0;
      const total = progress?.taskCount ?? 0;
      if (total > 0) return `${role} — ${semantic} (${done}/${total} tasks)`;
      return `${role} — ${semantic}`;
    }
    return `${role} — ${semantic}`;
  }

  // No live tool — infer from graph state
  if (phase === 'INCEPTION') {
    if (!progress?.requirementCount) return `${role} — analyzing workspace`;
    if (!progress?.userStoryCount)
      return `${role} — analyzing ${progress.requirementCount} requirements`;
    if (!progress?.taskCount) return `${role} — writing user stories`;
    return `${role} — planning ${progress.taskCount} tasks`;
  }
  if (phase === 'CONSTRUCTION') {
    const done = progress?.taskDoneCount ?? 0;
    const total = progress?.taskCount ?? 0;
    if (total > 0) return `${role} — building ${done}/${total} tasks`;
    return `${role} — setting up construction`;
  }
  if (phase === 'REVIEW') return `${role} — reviewing code`;
  return `${role} — working`;
}
