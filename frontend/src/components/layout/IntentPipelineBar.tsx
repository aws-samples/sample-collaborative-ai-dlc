import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Activity, ArrowLeft, CheckCircle2, ChevronRight, Network } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIntent } from '@/contexts/IntentContext';
import { groupByPhase, derivePhaseState } from '@/lib/intentPhases';

export function IntentPipelineBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    projectId,
    intentId,
    detail,
    compiled,
    stageRows,
    loading,
    phaseNameOf,
    initializationPhasePaths,
    workflowPhases,
    currentPhasePath,
  } = useIntent();

  // The plan (compiled) and the phase names (workflow) land after the intent
  // DTO — rendering chips before both arrive flashes a partial phase list
  // (only the phases with live rows, unfiltered init).
  const planReady = !!compiled && !!workflowPhases;

  const phases = useMemo(
    () =>
      planReady
        ? groupByPhase(stageRows).filter((g) => !initializationPhasePaths.has(g.phase))
        : [],
    [planReady, stageRows, initializationPhasePaths],
  );

  const activeIndex = useMemo(() => {
    const idx = phases.findIndex((g) => derivePhaseState(g, currentPhasePath) === 'active');
    return idx >= 0 ? idx : phases.length - 1;
  }, [phases, currentPhasePath]);

  const currentRoute: 'graph' | 'observability' | 'workbench' = location.pathname.endsWith('/graph')
    ? 'graph'
    : location.pathname.endsWith('/observability')
      ? 'observability'
      : 'workbench';

  if (!detail && loading) return null;
  if (!projectId || !intentId) return null;

  return (
    <div className="h-11 border-b bg-background flex items-center px-2 gap-1 overflow-x-auto md:overflow-visible">
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 h-7 text-xs text-muted-foreground hover:text-foreground"
        aria-label="Back to project"
        onClick={() => navigate(`/project/${projectId}`)}
      >
        <ArrowLeft className="h-3 w-3" />
        <span className="hidden sm:inline">Back</span>
      </Button>

      <div className="h-5 w-px bg-border shrink-0 mx-1" />

      <div className="flex items-center gap-0.5 shrink-0">
        {phases.map((group, index) => {
          const state = derivePhaseState(group, currentPhasePath);
          const progress = group.total > 0 ? Math.round((group.done / group.total) * 100) : null;
          const distance = Math.abs(index - activeIndex);
          const isNear = distance <= 1;

          return (
            <div key={group.phase} className="flex items-center">
              {index > 0 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground/50 mx-0.5 shrink-0" />
              )}
              <div
                className={cn(
                  'flex flex-col gap-1 rounded-md font-medium whitespace-nowrap transition-all',
                  isNear ? 'px-3 py-1.5 text-xs' : 'px-1.5 py-1 text-[10px] opacity-60',
                  state === 'active' && 'bg-sidebar-accent text-foreground',
                  state === 'done' && 'text-muted-foreground',
                  state === 'pending' && 'text-muted-foreground/40',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {state === 'done' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-agent-success shrink-0" />
                  ) : state === 'active' ? (
                    <span className="h-2 w-2 rounded-full bg-agent-running animate-pulse shrink-0" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                  )}
                  <span>{phaseNameOf(group.phase)}</span>
                  {isNear && (
                    <span className="hidden xl:inline text-[10px] text-muted-foreground font-normal">
                      {group.done}/{group.total}
                    </span>
                  )}
                </span>
                {isNear && progress !== null && (
                  <Progress
                    value={progress}
                    className={cn(
                      'h-1 w-full',
                      state === 'done' && '[&>div]:bg-agent-success',
                      state === 'active' && '[&>div]:bg-agent-running',
                    )}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-w-2" />

      <div className="flex items-center gap-0.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={currentRoute === 'graph' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              aria-label="Knowledge graph"
              onClick={() => navigate(`/project/${projectId}/intent/${intentId}/graph`)}
            >
              <Network className="h-3.5 w-3.5" />
              Graph
            </Button>
          </TooltipTrigger>
          <TooltipContent>Knowledge graph</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={currentRoute === 'observability' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              aria-label="Observability"
              onClick={() => navigate(`/project/${projectId}/intent/${intentId}/observability`)}
            >
              <Activity className="h-3.5 w-3.5" />
              Observability
            </Button>
          </TooltipTrigger>
          <TooltipContent>Observability</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
