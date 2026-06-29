import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Hammer,
  Lightbulb,
  Network,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectSprintsCache, refreshProjectSprints } from '@/hooks/useProjectsCache';
import { realtimeService } from '@/services/realtime';
import { requirementsService } from '@/services/requirements';
import { userStoriesService } from '@/services/userStories';
import { tasksService } from '@/services/tasks';
import { codeFilesService } from '@/services/codeFiles';
import type { Sprint } from '@/services/sprints';

interface PhaseMetrics {
  requirements: number;
  userStories: number;
  tasks: { total: number; done: number; inProgress: number };
  codeFiles: number;
}

const PHASES = [
  { id: 'INCEPTION', label: 'Inception', icon: Lightbulb, urlSuffix: '' },
  { id: 'CONSTRUCTION', label: 'Construction', icon: Hammer, urlSuffix: '/construction' },
  { id: 'REVIEW', label: 'Review', icon: Search, urlSuffix: '/review' },
] as const;

const PHASE_ORDER: Record<string, number> = {
  INCEPTION: 0,
  CONSTRUCTION: 1,
  REVIEW: 2,
  COMPLETED: 3,
};

const PHASE_URL_SUFFIX: Record<string, string> = {
  INCEPTION: '',
  CONSTRUCTION: '/construction',
  REVIEW: '/review',
};

function getPhaseMetricHint(phaseId: string, metrics: PhaseMetrics): string {
  switch (phaseId) {
    case 'INCEPTION': {
      const parts: string[] = [];
      if (metrics.requirements > 0) parts.push(`${metrics.requirements} reqs`);
      if (metrics.userStories > 0) parts.push(`${metrics.userStories} stories`);
      return parts.join(' · ');
    }
    case 'CONSTRUCTION': {
      const parts: string[] = [];
      if (metrics.tasks.total > 0) parts.push(`${metrics.tasks.total} tasks`);
      if (metrics.codeFiles > 0) parts.push(`${metrics.codeFiles} files`);
      return parts.join(' · ');
    }
    case 'REVIEW':
      return metrics.codeFiles > 0 ? `${metrics.codeFiles} files` : '';
    default:
      return '';
  }
}

function getPhaseProgress(phaseId: string, metrics: PhaseMetrics, isDone: boolean): number | null {
  if (isDone) return 100;
  switch (phaseId) {
    case 'INCEPTION': {
      // Inception produces three artifact types in sequence (requirements →
      // user stories → tasks). Progress reflects how many types have appeared,
      // not raw counts, so 50 requirements with no stories isn't shown as "done".
      const produced =
        (metrics.requirements > 0 ? 1 : 0) +
        (metrics.userStories > 0 ? 1 : 0) +
        (metrics.tasks.total > 0 ? 1 : 0);
      return Math.round((produced / 3) * 100);
    }
    case 'CONSTRUCTION': {
      if (metrics.tasks.total === 0) return 0;
      return Math.round((metrics.tasks.done / metrics.tasks.total) * 100);
    }
    default:
      return null;
  }
}

export function SprintPipelineBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId, sprintId } = useParams<{ projectId: string; sprintId: string }>();

  const { sprints } = useProjectSprintsCache(projectId ?? null);
  const sprint: Sprint | null = sprints.find((s) => s.id === sprintId) ?? null;

  const [metrics, setMetrics] = useState<PhaseMetrics>({
    requirements: 0,
    userStories: 0,
    tasks: { total: 0, done: 0, inProgress: 0 },
    codeFiles: 0,
  });

  const loadMetrics = useCallback(async () => {
    if (!sprintId) return;
    try {
      const [reqs, stories, tasksList, files] = await Promise.all([
        requirementsService.list(sprintId).catch(() => []),
        userStoriesService.list(sprintId).catch(() => []),
        tasksService.list(sprintId).catch(() => []),
        codeFilesService.list(sprintId).catch(() => []),
      ]);
      setMetrics({
        requirements: reqs.length,
        userStories: stories.length,
        tasks: {
          total: tasksList.length,
          done: tasksList.filter((t: { status: string }) => t.status === 'done').length,
          inProgress: tasksList.filter((t: { status: string }) => t.status === 'in_progress')
            .length,
        },
        codeFiles: files.length,
      });
    } catch {
      void 0;
    }
  }, [sprintId]);

  useEffect(() => {
    loadMetrics();
    const interval = setInterval(loadMetrics, 15000);
    return () => clearInterval(interval);
  }, [loadMetrics]);

  // Realtime: refetch sprint state on agent events + auto-navigate on phase change.
  useEffect(() => {
    if (!projectId || !sprintId) return;
    const refetch = () => refreshProjectSprints(projectId);
    const unsubs = [
      realtimeService.on('agent.started', refetch),
      realtimeService.on('agent.completed', refetch),
      realtimeService.on('agent.error', refetch),
      realtimeService.on('sprint.phaseChanged', (data: { phase?: string }) => {
        refetch();
        if (data.phase && PHASE_URL_SUFFIX[data.phase] !== undefined) {
          navigate(`/project/${projectId}/sprint/${sprintId}${PHASE_URL_SUFFIX[data.phase]}`);
        }
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [projectId, sprintId, navigate]);

  const sprintPhaseIndex = PHASE_ORDER[sprint?.phase || 'INCEPTION'] ?? 0;

  const currentPhase = location.pathname.includes('/construction')
    ? 'CONSTRUCTION'
    : location.pathname.includes('/review')
      ? 'REVIEW'
      : location.pathname.includes('/graph')
        ? 'GRAPH'
        : location.pathname.includes('/agent')
          ? 'AGENT'
          : 'INCEPTION';

  if (!projectId || !sprintId) return null;

  return (
    <div className="h-11 border-b bg-background flex items-center px-2 gap-1 overflow-x-auto md:overflow-visible">
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 h-7 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => navigate(`/project/${projectId}`)}
      >
        <ArrowLeft className="h-3 w-3" />
        <span className="hidden sm:inline">Back</span>
      </Button>

      <div className="h-5 w-px bg-border shrink-0 mx-1" />

      <div className="flex items-center gap-0.5 shrink-0">
        {PHASES.map((phase, index) => {
          const phaseIndex = PHASE_ORDER[phase.id];
          const isDone = phaseIndex < sprintPhaseIndex;
          const isCurrent = currentPhase === phase.id;
          const isFuture = phaseIndex > sprintPhaseIndex;
          const PhaseIcon = phase.icon;
          const hint = getPhaseMetricHint(phase.id, metrics);
          const progress = isFuture ? null : getPhaseProgress(phase.id, metrics, isDone);

          return (
            <div key={phase.id} className="flex items-center">
              {index > 0 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground/50 mx-0.5 shrink-0" />
              )}
              <button
                disabled={isFuture}
                aria-label={isFuture ? `${phase.label} (not started yet)` : `Go to ${phase.label}`}
                onClick={() =>
                  navigate(`/project/${projectId}/sprint/${sprintId}${phase.urlSuffix}`)
                }
                className={cn(
                  'flex flex-col gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
                  isCurrent && 'bg-sidebar-accent text-foreground',
                  isDone && !isCurrent && 'text-muted-foreground hover:bg-accent/50',
                  !isDone && !isCurrent && !isFuture && 'text-foreground/80 hover:bg-accent/50',
                  isFuture && 'text-muted-foreground/40 opacity-60 cursor-not-allowed',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {isDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-agent-success shrink-0" />
                  ) : (
                    <PhaseIcon className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{phase.label}</span>
                  {hint && (
                    <span className="hidden xl:inline text-[10px] text-muted-foreground font-normal">
                      {hint}
                    </span>
                  )}
                </span>
                {progress !== null && (
                  <Progress
                    value={progress}
                    className={cn(
                      'h-0.5 w-full',
                      phase.id === 'INCEPTION'
                        ? '[&>div]:bg-phase-inception'
                        : '[&>div]:bg-phase-construction',
                    )}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-w-2" />

      <div className="flex items-center gap-0.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Observability"
              onClick={() => navigate(`/observability?project=${projectId}&sprint=${sprintId}`)}
            >
              <Activity className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Observability</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={currentPhase === 'GRAPH' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Graph View"
              onClick={() => navigate(`/project/${projectId}/sprint/${sprintId}/graph`)}
            >
              <Network className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Graph View</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={currentPhase === 'AGENT' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="Invoke Agent"
              onClick={() => navigate(`/project/${projectId}/sprint/${sprintId}/agent`)}
            >
              <Bot className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Invoke Agent</TooltipContent>
        </Tooltip>

        {sprint?.prUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="Open review"
                onClick={() => navigate(`/project/${projectId}/sprint/${sprintId}/review`)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open review</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
