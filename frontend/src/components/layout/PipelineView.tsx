import { useNavigate, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Lightbulb,
  Hammer,
  Search,
  ArrowRight,
  Zap,
  MessageCircleQuestion,
  CheckCircle2,
  Loader2,
  Network,
  Bot,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Sprint } from '@/services/sprints';
import { useState, useEffect, useCallback } from 'react';
import { requirementsService } from '@/services/requirements';
import { userStoriesService } from '@/services/userStories';
import { tasksService } from '@/services/tasks';
import { codeFilesService } from '@/services/codeFiles';

interface PipelineViewProps {
  projectId: string;
  sprintId: string;
  currentPhase: string;
  sprint?: Sprint;
}

interface PhaseMetrics {
  requirements: number;
  userStories: number;
  tasks: { total: number; done: number; inProgress: number };
  codeFiles: number;
}

const PHASES = [
  {
    id: 'INCEPTION',
    label: 'Inception',
    icon: Lightbulb,
    description: 'Define scope & requirements',
    urlSuffix: '',
  },
  {
    id: 'CONSTRUCTION',
    label: 'Construction',
    icon: Hammer,
    description: 'Build & implement',
    urlSuffix: '/construction',
  },
  {
    id: 'REVIEW',
    label: 'Review',
    icon: Search,
    description: 'Validate & approve',
    urlSuffix: '/review',
  },
];

const PHASE_ORDER: Record<string, number> = {
  INCEPTION: 0,
  CONSTRUCTION: 1,
  REVIEW: 2,
  COMPLETED: 3,
};

export function PipelineView({ projectId, sprintId, currentPhase, sprint }: PipelineViewProps) {
  const navigate = useNavigate();
  const params = useParams();
  const [metrics, setMetrics] = useState<PhaseMetrics>({
    requirements: 0,
    userStories: 0,
    tasks: { total: 0, done: 0, inProgress: 0 },
    codeFiles: 0,
  });

  const loadMetrics = useCallback(async () => {
    try {
      const [reqs, stories, tasks, files] = await Promise.all([
        requirementsService.list(sprintId).catch(() => []),
        userStoriesService.list(sprintId).catch(() => []),
        tasksService.list(sprintId).catch(() => []),
        codeFilesService.list(sprintId).catch(() => []),
      ]);
      setMetrics({
        requirements: reqs.length,
        userStories: stories.length,
        tasks: {
          total: tasks.length,
          done: tasks.filter((t: { status: string }) => t.status === 'done').length,
          inProgress: tasks.filter((t: { status: string }) => t.status === 'in_progress').length,
        },
        codeFiles: files.length,
      });
    } catch {
      // silently fail
    }
  }, [sprintId]);

  useEffect(() => {
    loadMetrics();
    const interval = setInterval(loadMetrics, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, [loadMetrics]);

  const sprintPhaseIndex = PHASE_ORDER[sprint?.phase || 'INCEPTION'] ?? 0;
  const agentStatus = sprint?.currentAgentStatus;
  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting';
  const isAgentFailed = agentStatus === 'failed' && !!sprint?.currentExecutionArn;

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-sidebar-foreground/60 uppercase tracking-wider">
        Sprint Pipeline
      </span>

      <div className="relative mt-2 space-y-0">
        {PHASES.map((phase, index) => {
          const phaseIndex = PHASE_ORDER[phase.id];
          const isActive = currentPhase === phase.id;
          const isCurrentSprintPhase = sprint?.phase === phase.id;
          const isCompleted = phaseIndex < sprintPhaseIndex;
          const isFuture = phaseIndex > sprintPhaseIndex;
          const hasAgentRunning = isCurrentSprintPhase && isAgentActive;
          const hasAgentFailed = isCurrentSprintPhase && isAgentFailed;
          const PhaseIcon = phase.icon;

          // Compute phase-specific metrics
          const phaseMetrics = getPhaseMetrics(phase.id, metrics);
          const progress = getPhaseProgress(phase.id, metrics, isCompleted);

          return (
            <div key={phase.id}>
              {/* Connector line between phases */}
              {index > 0 && (
                <div className="relative h-3 ml-[15px]">
                  <div
                    className={cn(
                      'absolute left-0 top-0 w-0.5 h-full transition-colors',
                      isCompleted || phaseIndex <= sprintPhaseIndex
                        ? 'bg-phase-inception'
                        : 'bg-sidebar-border',
                    )}
                  />
                </div>
              )}

              {/* Phase station card */}
              <button
                className={cn(
                  'w-full rounded-lg p-2.5 text-left transition-all border group',
                  isActive
                    ? 'bg-sidebar-accent border-sidebar-primary/30 shadow-sm'
                    : 'border-transparent hover:bg-sidebar-accent/50',
                  isFuture && 'opacity-50',
                )}
                onClick={() => {
                  navigate(
                    `/project/${params.projectId || projectId}/sprint/${sprintId}${phase.urlSuffix}`,
                  );
                }}
              >
                <div className="flex items-start gap-2.5">
                  {/* Status icon */}
                  <div
                    className={cn(
                      'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors',
                      isActive
                        ? phase.id === 'INCEPTION'
                          ? 'bg-phase-inception/15 text-phase-inception'
                          : phase.id === 'CONSTRUCTION'
                            ? 'bg-phase-construction/15 text-phase-construction'
                            : 'bg-phase-review/15 text-phase-review'
                        : isCompleted
                          ? 'bg-agent-success/15 text-agent-success'
                          : 'bg-sidebar-accent text-sidebar-foreground/40',
                    )}
                  >
                    {isCompleted ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : hasAgentRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PhaseIcon className="h-4 w-4" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'text-xs font-semibold',
                          isActive ? 'text-sidebar-foreground' : 'text-sidebar-foreground/70',
                        )}
                      >
                        {phase.label}
                      </span>
                      {isCurrentSprintPhase && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[9px] border-sidebar-primary/30"
                        >
                          Current
                        </Badge>
                      )}
                      {hasAgentRunning && (
                        <Tooltip>
                          <TooltipTrigger>
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-agent-running" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            Agent is {agentStatus === 'waiting' ? 'waiting for input' : 'running'}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {hasAgentFailed && (
                        <Tooltip>
                          <TooltipTrigger>
                            <span className="relative flex h-2 w-2">
                              <span className="inline-flex rounded-full h-2 w-2 bg-red-500" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Agent failed</TooltipContent>
                        </Tooltip>
                      )}
                    </div>

                    {/* Phase metrics */}
                    {phaseMetrics.length > 0 && (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
                        {phaseMetrics.map((metric) => (
                          <span
                            key={metric.label}
                            className="text-[10px] text-sidebar-foreground/50"
                          >
                            {metric.value} {metric.label}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Progress bar */}
                    {progress !== null && !isFuture && (
                      <div className="mt-1.5">
                        <Progress
                          value={progress}
                          className={cn(
                            'h-1',
                            phase.id === 'INCEPTION'
                              ? '[&>div]:bg-phase-inception'
                              : phase.id === 'CONSTRUCTION'
                                ? '[&>div]:bg-phase-construction'
                                : '[&>div]:bg-phase-review',
                          )}
                        />
                      </div>
                    )}

                    {/* Pending question banner */}
                    {hasAgentRunning && agentStatus === 'waiting' && (
                      <div className="flex items-center gap-1 mt-1.5 text-agent-waiting">
                        <MessageCircleQuestion className="h-3 w-3" />
                        <span className="text-[10px] font-medium">Question pending</span>
                      </div>
                    )}
                  </div>

                  {/* Navigate arrow */}
                  <ArrowRight
                    className={cn(
                      'h-3 w-3 shrink-0 mt-1 transition-opacity',
                      isActive
                        ? 'text-sidebar-foreground/30 opacity-0 group-hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-100 text-sidebar-foreground/20',
                    )}
                  />
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {/* Graph View link */}
      <div className="mt-3 pt-3 border-t border-sidebar-border">
        <button
          className={cn(
            'w-full rounded-lg p-2.5 text-left transition-all border group flex items-center gap-2.5',
            currentPhase === 'GRAPH'
              ? 'bg-sidebar-accent border-sidebar-primary/30 shadow-sm'
              : 'border-transparent hover:bg-sidebar-accent/50',
          )}
          onClick={() => {
            navigate(`/project/${params.projectId || projectId}/sprint/${sprintId}/graph`);
          }}
        >
          <div
            className={cn(
              'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors',
              currentPhase === 'GRAPH'
                ? 'bg-primary/15 text-primary'
                : 'bg-sidebar-accent text-sidebar-foreground/40',
            )}
          >
            <Network className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <span
              className={cn(
                'text-xs font-semibold',
                currentPhase === 'GRAPH' ? 'text-sidebar-foreground' : 'text-sidebar-foreground/70',
              )}
            >
              Graph View
            </span>
            <span className="text-[10px] text-sidebar-foreground/50 block">Knowledge graph</span>
          </div>
          <ArrowRight
            className={cn(
              'h-3 w-3 shrink-0 transition-opacity',
              currentPhase === 'GRAPH'
                ? 'text-sidebar-foreground/30 opacity-0 group-hover:opacity-100'
                : 'opacity-0 group-hover:opacity-100 text-sidebar-foreground/20',
            )}
          />
        </button>

        {/* Invoke Agent link */}
        <button
          className={cn(
            'w-full rounded-lg p-2.5 text-left transition-all border group flex items-center gap-2.5 mt-1',
            currentPhase === 'AGENT'
              ? 'bg-sidebar-accent border-sidebar-primary/30 shadow-sm'
              : 'border-transparent hover:bg-sidebar-accent/50',
          )}
          onClick={() => {
            navigate(`/project/${params.projectId || projectId}/sprint/${sprintId}/agent`);
          }}
        >
          <div
            className={cn(
              'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors',
              currentPhase === 'AGENT'
                ? 'bg-purple-500/15 text-purple-500'
                : 'bg-sidebar-accent text-sidebar-foreground/40',
            )}
          >
            <Bot className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <span
              className={cn(
                'text-xs font-semibold',
                currentPhase === 'AGENT' ? 'text-sidebar-foreground' : 'text-sidebar-foreground/70',
              )}
            >
              Invoke Agent
            </span>
            <span className="text-[10px] text-sidebar-foreground/50 block">
              Bug fixes & ad-hoc tasks
            </span>
          </div>
          <ArrowRight
            className={cn(
              'h-3 w-3 shrink-0 transition-opacity',
              currentPhase === 'AGENT'
                ? 'text-sidebar-foreground/30 opacity-0 group-hover:opacity-100'
                : 'opacity-0 group-hover:opacity-100 text-sidebar-foreground/20',
            )}
          />
        </button>
      </div>

      {/* Quick action */}
      {sprint && (
        <div className="pt-2">
          <QuickAction sprint={sprint} projectId={projectId} sprintId={sprintId} />
        </div>
      )}
    </div>
  );
}

function getPhaseMetrics(
  phaseId: string,
  metrics: PhaseMetrics,
): Array<{ label: string; value: number }> {
  switch (phaseId) {
    case 'INCEPTION':
      return [
        ...(metrics.requirements > 0 ? [{ label: 'reqs', value: metrics.requirements }] : []),
        ...(metrics.userStories > 0 ? [{ label: 'stories', value: metrics.userStories }] : []),
        ...(metrics.tasks.total > 0 ? [{ label: 'tasks', value: metrics.tasks.total }] : []),
      ];
    case 'CONSTRUCTION':
      return [
        ...(metrics.tasks.total > 0 ? [{ label: 'tasks', value: metrics.tasks.total }] : []),
        ...(metrics.tasks.done > 0 ? [{ label: 'done', value: metrics.tasks.done }] : []),
        ...(metrics.codeFiles > 0 ? [{ label: 'files', value: metrics.codeFiles }] : []),
      ];
    case 'REVIEW':
      return metrics.codeFiles > 0 ? [{ label: 'files', value: metrics.codeFiles }] : [];
    default:
      return [];
  }
}

function getPhaseProgress(
  phaseId: string,
  metrics: PhaseMetrics,
  isCompleted: boolean,
): number | null {
  if (isCompleted) return 100;
  switch (phaseId) {
    case 'INCEPTION': {
      const total = metrics.requirements + metrics.userStories + metrics.tasks.total;
      return total > 0 ? Math.min(100, Math.round((total / 3) * 33)) : 0;
    }
    case 'CONSTRUCTION': {
      if (metrics.tasks.total === 0) return 0;
      return Math.round((metrics.tasks.done / metrics.tasks.total) * 100);
    }
    case 'REVIEW':
      return null; // shown differently
    default:
      return null;
  }
}

function QuickAction({
  sprint,
  projectId,
  sprintId,
}: {
  sprint: Sprint;
  projectId: string;
  sprintId: string;
}) {
  const navigate = useNavigate();
  const isAgentActive =
    sprint.currentAgentStatus === 'running' || sprint.currentAgentStatus === 'waiting';

  if (isAgentActive) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full h-7 text-xs gap-1.5"
        onClick={() => {
          const suffix =
            sprint.phase === 'CONSTRUCTION'
              ? '/construction'
              : sprint.phase === 'REVIEW'
                ? '/review'
                : '';
          navigate(`/project/${projectId}/sprint/${sprintId}${suffix}`);
        }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        View Agent Activity
      </Button>
    );
  }

  if (sprint.prUrl) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full h-7 text-xs gap-1.5"
        onClick={() => window.open(sprint.prUrl!, '_blank')}
      >
        <Zap className="h-3 w-3" />
        View Pull Request
      </Button>
    );
  }

  return null;
}
