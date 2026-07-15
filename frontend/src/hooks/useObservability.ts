import { useState, useEffect, useCallback, useRef } from 'react';
import { L2Intelligence } from '../lib/observability/l2Intelligence';
import { fetchProjectInfos } from '../lib/observability/fetchProjectInfos';
import { useObservabilityEvents } from '../lib/observability/useObservabilityEvents';
import type { StuckDetection, VelocityMetrics } from '../lib/observability/l2Intelligence';
import type { Project } from '../services/projects';
import type { Sprint } from '../services/sprints';
import type { TaskAgentStatus } from '../services/agents';

export type {
  StuckDetection,
  VelocityMetrics,
  StuckReason,
} from '../lib/observability/l2Intelligence';

export interface SprintProgress {
  requirementCount: number;
  userStoryCount: number;
  taskCount: number;
  taskDoneCount: number;
  codeFileCount: number;
  totalNodes: number;
  hasGeneralInfo: boolean;
}

export interface ProjectAgentInfo {
  project: Project;
  sprint: Sprint | null;
  progress: SprintProgress | null;
  taskStatuses: TaskAgentStatus[];
}

export interface ActivityEvent {
  id: string;
  type: string;
  timestamp: number;
  projectId?: string;
  sprintId?: string;
  agentType?: string;
  detail?: string;
}

export type LastToolMap = Record<string, { name: string; timestamp: number }>;
export type PendingQuestionsMap = Record<string, number>;

export function useObservability() {
  const [projects, setProjects] = useState<ProjectAgentInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [activityFeed, setActivityFeed] = useState<ActivityEvent[]>([]);
  const [lastToolMap, setLastToolMap] = useState<LastToolMap>({});
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestionsMap>({});
  const [stuckDetections, setStuckDetections] = useState<StuckDetection[]>([]);
  const [velocityMap, setVelocityMap] = useState<Record<string, VelocityMetrics>>({});
  const [activeSprintId, setActiveSprintId] = useState<string | null>(null);

  const l2 = useRef(new L2Intelligence());
  const eventCounter = useRef(0);
  const projectsRef = useRef<ProjectAgentInfo[]>([]);

  const addEvent = useCallback((type: string, data: Record<string, unknown> = {}) => {
    const id = `evt-${++eventCounter.current}-${Date.now()}`;
    setActivityFeed((prev) =>
      [
        {
          id,
          type,
          timestamp: Date.now(),
          projectId: data.projectId as string | undefined,
          sprintId: data.sprintId as string | undefined,
          agentType: data.agentType as string | undefined,
          detail: data.detail as string | undefined,
        },
        ...prev,
      ].slice(0, 150),
    );
  }, []);

  const clearStuck = useCallback((sprintId: string) => {
    l2.current.clearSprint(sprintId);
    setStuckDetections((prev) => prev.filter((s) => s.sprintId !== sprintId));
  }, []);

  const markBlocked = useCallback((sprintId: string, projectName: string) => {
    setStuckDetections((prev) => {
      const filtered = prev.filter(
        (s) => !(s.sprintId === sprintId && s.reason === 'blocked_question'),
      );
      return [
        ...filtered,
        {
          sprintId,
          projectName,
          reason: 'blocked_question',
          message: 'Agent paused — waiting for human answer',
          durationMs: 0,
          severity: 'critical',
        },
      ];
    });
  }, []);

  const refreshProjects = useCallback(async (forceRefresh = false) => {
    try {
      const infos = await fetchProjectInfos(l2.current, { forceRefresh });
      setProjects(infos);
      setProjectsError(null);
      projectsRef.current = infos;

      const newVelocityMap: Record<string, VelocityMetrics> = {};
      for (const info of infos) {
        if (!info.sprint) continue;
        const v = l2.current.computeVelocity(info.sprint.id);
        if (v) newVelocityMap[info.sprint.id] = v;
      }
      setVelocityMap(newVelocityMap);

      // Track the most recently active sprint for WebSocket connection
      const active = infos.find(
        (p) =>
          p.sprint &&
          (p.sprint.currentAgentStatus === 'running' || p.sprint.currentAgentStatus === 'waiting'),
      );
      setActiveSprintId(active?.sprint?.id ?? null);

      setStuckDetections((prev) => {
        let next = [...prev];
        for (const info of infos) {
          const sprintId = info.sprint?.id;
          if (!sprintId || info.sprint?.currentAgentStatus !== 'running') {
            next = next.filter((s) => s.sprintId !== sprintId || s.reason !== 'idle');
            continue;
          }
          const result = l2.current.checkIdle(sprintId);
          if (result.idle) {
            if (!next.some((s) => s.sprintId === sprintId && s.reason === 'idle')) {
              next = [
                ...next.filter((s) => !(s.sprintId === sprintId && s.reason === 'idle')),
                {
                  sprintId,
                  projectName: info.project.name,
                  reason: 'idle',
                  message: `No activity for ${Math.round(result.durationMs / 60000)} min`,
                  durationMs: result.durationMs,
                  severity: 'medium',
                },
              ];
            }
          } else {
            next = next.filter((s) => !(s.sprintId === sprintId && s.reason === 'idle'));
          }
        }
        return next;
      });
    } catch (e) {
      console.error('[Observability] projects fetch failed:', e);
      setProjectsError(e instanceof Error ? e.message : 'Failed to load spaces');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const refresh = useCallback(() => refreshProjects(true), [refreshProjects]);

  useEffect(() => {
    refreshProjects();
    const timer = setInterval(() => refreshProjects(), 20000);
    return () => clearInterval(timer);
  }, [refreshProjects]);

  const refreshOnEvent = useCallback(() => {
    // Agent lifecycle events must FORCE a refresh: the non-forced path can return
    // cached data and leave the cards, active count, phase, and detail state stale
    // until the cache TTL expires.
    refreshProjects(true);
  }, [refreshProjects]);

  useObservabilityEvents({
    addEvent,
    clearStuck,
    markBlocked,
    setLastToolMap,
    setPendingQuestions,
    setStuckDetections,
    refreshProjects: refreshOnEvent,
    projectsRef,
    l2,
    activeSprintId,
  });

  return {
    projects,
    projectsLoading,
    projectsError,
    activityFeed,
    lastToolMap,
    pendingQuestions,
    stuckDetections,
    velocityMap,
    refresh,
  };
}
