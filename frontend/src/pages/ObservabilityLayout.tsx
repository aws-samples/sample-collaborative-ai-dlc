import { createContext, useContext, useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useObservability } from '@/hooks/useObservability';
import { IterationDetailView } from '@/components/observability/IterationDetailView';
import ObservabilityDashboard from './ObservabilityDashboard';
import { fetchSprintInfo } from '@/lib/observability/fetchProjectInfos';
import type {
  ProjectAgentInfo,
  ActivityEvent,
  LastToolMap,
  PendingQuestionsMap,
  VelocityMetrics,
  StuckDetection,
} from '@/hooks/useObservability';

export interface ObservabilityContextValue {
  projects: ProjectAgentInfo[];
  filtered: ProjectAgentInfo[];
  projectsLoading: boolean;
  projectsError: string | null;
  activityFeed: ActivityEvent[];
  lastToolMap: LastToolMap;
  pendingQuestions: PendingQuestionsMap;
  stuckDetections: StuckDetection[];
  velocityMap: Record<string, VelocityMetrics>;
  selectedProjectId: string | null;
  selectedSprintId: string | null;
  selectSprint: (projectId: string, sprintId: string) => void;
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
  const urlSprintId = searchParams.get('sprint');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(urlProjectId);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(urlSprintId);

  useEffect(() => {
    setSelectedProjectId(urlProjectId);
    setSelectedSprintId(urlSprintId);
  }, [urlProjectId, urlSprintId]);

  const selectSprint = useCallback(
    (projectId: string, sprintId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSprintId(sprintId);
      navigate(`/observability?project=${projectId}&sprint=${sprintId}`, { replace: true });
    },
    [navigate],
  );

  const goBack = useCallback(() => {
    setSelectedProjectId(null);
    setSelectedSprintId(null);
    navigate('/observability', { replace: true });
  }, [navigate]);

  const selectedInfo = useMemo(() => {
    if (!selectedProjectId || !selectedSprintId) return null;
    return (
      obs.projects.find(
        (p) => p.project.id === selectedProjectId && p.sprint?.id === selectedSprintId,
      ) ?? null
    );
  }, [obs.projects, selectedProjectId, selectedSprintId]);

  const knownProject = useMemo(
    () => obs.projects.find((p) => p.project.id === selectedProjectId)?.project ?? null,
    [obs.projects, selectedProjectId],
  );

  // Deep link to a NON-latest sprint: the projection only carries each project's
  // latest sprint, so fetch the requested sprint directly rather than redirecting.
  const [deepLinkInfo, setDeepLinkInfo] = useState<ProjectAgentInfo | null>(null);
  useEffect(() => {
    if (selectedInfo || !selectedProjectId || !selectedSprintId || !knownProject) {
      setDeepLinkInfo(null);
      return;
    }
    let cancelled = false;
    setDeepLinkInfo(null);
    void fetchSprintInfo(knownProject, selectedSprintId).then((info) => {
      if (!cancelled) setDeepLinkInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedInfo, selectedProjectId, selectedSprintId, knownProject]);

  const resolvedInfo = selectedInfo ?? deepLinkInfo;

  // Unknown ?project= id: drop params once projects have loaded.
  useEffect(() => {
    if (selectedProjectId && !knownProject && !obs.projectsLoading && obs.projects.length > 0) {
      navigate('/observability', { replace: true });
    }
  }, [selectedProjectId, knownProject, obs.projectsLoading, obs.projects.length, navigate]);

  const filtered = useMemo(() => {
    if (!selectedProjectId) return obs.projects;
    return obs.projects.filter((p) => p.project.id === selectedProjectId);
  }, [obs.projects, selectedProjectId]);

  const filteredActivity = useMemo(() => {
    if (!selectedProjectId) return obs.activityFeed;
    const projectSprintIds = new Set(
      obs.projects
        .filter((p) => p.project.id === selectedProjectId && p.sprint)
        .map((p) => p.sprint!.id),
    );
    return obs.activityFeed.filter((e) => !e.sprintId || projectSprintIds.has(e.sprintId));
  }, [obs.activityFeed, obs.projects, selectedProjectId]);

  const filteredStuck = useMemo(() => {
    if (!selectedProjectId) return obs.stuckDetections;
    const sprintIds = new Set(
      obs.projects
        .filter((p) => p.project.id === selectedProjectId && p.sprint)
        .map((p) => p.sprint!.id),
    );
    return obs.stuckDetections.filter((d) => sprintIds.has(d.sprintId));
  }, [obs.stuckDetections, obs.projects, selectedProjectId]);

  const ctx: ObservabilityContextValue = useMemo(
    () => ({
      projects: obs.projects,
      filtered,
      projectsLoading: obs.projectsLoading,
      projectsError: obs.projectsError,
      activityFeed: filteredActivity,
      lastToolMap: obs.lastToolMap,
      pendingQuestions: obs.pendingQuestions,
      stuckDetections: filteredStuck,
      velocityMap: obs.velocityMap,
      selectedProjectId,
      selectedSprintId,
      selectSprint,
      refresh: obs.refresh,
    }),
    [
      obs,
      filtered,
      filteredActivity,
      filteredStuck,
      selectedProjectId,
      selectedSprintId,
      selectSprint,
    ],
  );

  const handleNavigate = useCallback((path: string) => navigate(path), [navigate]);

  return (
    <ObservabilityContext.Provider value={ctx}>
      {selectedProjectId && selectedSprintId && resolvedInfo ? (
        <IterationDetailView
          info={resolvedInfo}
          pendingQuestions={
            resolvedInfo.sprint ? (obs.pendingQuestions[resolvedInfo.sprint.id] ?? 0) : 0
          }
          velocity={resolvedInfo.sprint ? obs.velocityMap[resolvedInfo.sprint.id] : undefined}
          onNavigate={handleNavigate}
          onBack={goBack}
        />
      ) : (
        <ObservabilityDashboard />
      )}
    </ObservabilityContext.Provider>
  );
}
