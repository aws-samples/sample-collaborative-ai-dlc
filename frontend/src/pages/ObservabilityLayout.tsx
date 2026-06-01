import { createContext, useContext, useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useObservability } from '@/hooks/useObservability';
import { useProjectSprintsCache } from '@/hooks/useProjectsCache';
import { ProjectDetailView } from '@/components/observability/ProjectDetailView';
import ObservabilityDashboard from './ObservabilityDashboard';
import type { ProjectAgentInfo, ActivityEvent, LastToolMap, PendingQuestionsMap, VelocityMetrics, StuckDetection } from '@/hooks/useObservability';

export interface ObservabilityContextValue {
  projects: ProjectAgentInfo[];
  filtered: ProjectAgentInfo[];
  projectsLoading: boolean;
  activityFeed: ActivityEvent[];
  lastToolMap: LastToolMap;
  pendingQuestions: PendingQuestionsMap;
  stuckDetections: StuckDetection[];
  velocityMap: Record<string, VelocityMetrics>;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  refresh: () => void;
}

const ObservabilityContext = createContext<ObservabilityContextValue | null>(null);

export function useObservabilityContext() {
  const ctx = useContext(ObservabilityContext);
  if (!ctx) throw new Error('useObservabilityContext must be used within ObservabilityLayout');
  return ctx;
}

export default function ObservabilityLayout() {
  const obs = useObservability();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlProjectId = searchParams.get('project');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(urlProjectId);
  const { sprints: projectSprints } = useProjectSprintsCache(selectedProjectId);

  useEffect(() => {
    setSelectedProjectId(urlProjectId);
  }, [urlProjectId]);

  const selectProject = useCallback((id: string | null) => {
    setSelectedProjectId(id);
    if (id) {
      navigate(`/observability?project=${id}`, { replace: true });
    } else {
      navigate('/observability', { replace: true });
    }
  }, [navigate]);

  const selectedInfo = useMemo(() => {
    if (!selectedProjectId) return null;
    return obs.projects.find(p => p.project.id === selectedProjectId) ?? null;
  }, [obs.projects, selectedProjectId]);

  const filtered = useMemo(() => {
    if (!selectedProjectId) return obs.projects;
    return obs.projects.filter(p => p.project.id === selectedProjectId);
  }, [obs.projects, selectedProjectId]);

  const filteredActivity = useMemo(() => {
    if (!selectedProjectId) return obs.activityFeed;
    const projectSprintIds = new Set(
      obs.projects
        .filter(p => p.project.id === selectedProjectId && p.sprint)
        .map(p => p.sprint!.id)
    );
    return obs.activityFeed.filter(e =>
      !e.sprintId || projectSprintIds.has(e.sprintId)
    );
  }, [obs.activityFeed, obs.projects, selectedProjectId]);

  const filteredStuck = useMemo(() => {
    if (!selectedProjectId) return obs.stuckDetections;
    const sprintIds = new Set(
      obs.projects
        .filter(p => p.project.id === selectedProjectId && p.sprint)
        .map(p => p.sprint!.id)
    );
    return obs.stuckDetections.filter(d => sprintIds.has(d.sprintId));
  }, [obs.stuckDetections, obs.projects, selectedProjectId]);

  const ctx: ObservabilityContextValue = useMemo(() => ({
    projects: obs.projects,
    filtered,
    projectsLoading: obs.projectsLoading,
    activityFeed: filteredActivity,
    lastToolMap: obs.lastToolMap,
    pendingQuestions: obs.pendingQuestions,
    stuckDetections: filteredStuck,
    velocityMap: obs.velocityMap,
    selectedProjectId,
    setSelectedProjectId: selectProject,
    refresh: obs.refresh,
  }), [obs, filtered, filteredActivity, filteredStuck, selectedProjectId]);

  const handleNavigate = useCallback((path: string) => navigate(path), [navigate]);

  return (
    <ObservabilityContext.Provider value={ctx}>
      {selectedProjectId && selectedInfo ? (
        <ProjectDetailView
          info={selectedInfo}
          allSprints={projectSprints}
          lastTool={selectedInfo.sprint ? obs.lastToolMap[selectedInfo.sprint.id] : undefined}
          pendingQuestions={selectedInfo.sprint ? (obs.pendingQuestions[selectedInfo.sprint.id] ?? 0) : 0}
          velocity={selectedInfo.sprint ? obs.velocityMap[selectedInfo.sprint.id] : undefined}
          onNavigate={handleNavigate}
          onBack={() => selectProject(null)}
        />
      ) : (
        <ObservabilityDashboard />
      )}
    </ObservabilityContext.Provider>
  );
}
