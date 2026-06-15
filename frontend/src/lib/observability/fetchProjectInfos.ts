/**
 * Data fetching helpers for useObservability — keeps the hook lean.
 */
import { agentsService, type TaskAgentStatus } from '../../services/agents';
import { sprintGraphService } from '../../services/sprintGraph';
import {
  getProjectsWithSprints,
  refreshProjects as refreshProjectsCache,
} from '@/hooks/useProjectsCache';
import type { SprintProgress, ProjectAgentInfo } from '@/hooks/useObservability';
import type { L2Intelligence } from './l2Intelligence';

export async function fetchProjectInfos(
  l2: L2Intelligence,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<ProjectAgentInfo[]> {
  if (forceRefresh) await refreshProjectsCache();
  const withSprints = await getProjectsWithSprints();
  return Promise.all(
    withSprints.map(async ({ project, latestSprint: latest }) => {
      try {
        let progress: SprintProgress | null = null;
        let taskStatuses: TaskAgentStatus[] = [];

        if (latest) {
          try {
            const graph = await sprintGraphService.get(latest.id);
            const nodes = graph.nodes;
            const byType = (t: string) => nodes.filter((n) => n.type === t).length;
            const tasks = nodes.filter((n) => n.type === 'Task');
            progress = {
              requirementCount: byType('Requirement'),
              userStoryCount: byType('UserStory'),
              taskCount: tasks.length,
              taskDoneCount: tasks.filter((n) => (n as Record<string, unknown>).status === 'done')
                .length,
              codeFileCount: byType('CodeFile'),
              totalNodes: nodes.length,
              hasGeneralInfo: byType('GeneralInfo') > 0,
            };
            tasks
              .filter((n) => (n as Record<string, unknown>).status === 'done')
              .forEach((t) => l2.recordTaskCompletion(latest.id, t.id));
          } catch {
            /* graph not available yet */
          }

          if (latest.phase === 'CONSTRUCTION') {
            try {
              const { tasks } = await agentsService.getTaskAgentStatuses(project.id, latest.id);
              taskStatuses = tasks;
              tasks
                .filter((t) => t.executionStatus === 'SUCCEEDED')
                .forEach((t) => l2.recordTaskCompletion(latest.id, t.taskId));
            } catch {
              /* not available */
            }
          }

          if (latest.currentAgentStatus === 'running' || latest.currentAgentStatus === 'waiting') {
            l2.seedLastChange(latest.id);
          }
        }

        return { project, sprint: latest, progress, taskStatuses };
      } catch {
        return { project, sprint: latest ?? null, progress: null, taskStatuses: [] };
      }
    }),
  );
}
