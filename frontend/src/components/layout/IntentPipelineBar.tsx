import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIntent } from '@/contexts/IntentContext';
import { groupByPhase, derivePhaseState } from '@/lib/intentPhases';
import { setLastIntentSection, type IntentSection } from '@/lib/intentSectionPreference';

function detectSection(pathname: string): IntentSection {
  if (pathname.endsWith('/graph')) return 'graph';
  if (pathname.endsWith('/observability') || pathname.endsWith('/audit')) return 'overview';
  return 'work';
}

export function IntentPipelineBar() {
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

  const currentSection = detectSection(location.pathname);

  useEffect(() => {
    if (intentId) setLastIntentSection(intentId, currentSection);
  }, [intentId, currentSection]);

  if (!detail && loading) return null;
  if (!projectId || !intentId) return null;
  if (phases.length === 0) return null;

  return (
    <div className="h-11 border-b bg-background flex items-center px-3 gap-1 overflow-x-auto md:overflow-visible">
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
              <Tooltip>
                <TooltipTrigger asChild>
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
                </TooltipTrigger>
                <TooltipContent>
                  {phaseNameOf(group.phase)} — {group.done}/{group.total}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { detectSection };
