import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent, type IntentStageRow } from '@/contexts/IntentContext';
import type { StageState } from '@/services/intents';
import type { CompiledWorkflow } from '@/services/workflows';
import { aggregateMetrics, summarizeCost } from '@/lib/metricAggregation';
import { groupByPhase, derivePhaseState } from '@/lib/intentPhases';
import { WorkflowScopeGraph } from '@/components/v2';
import { UsageMetrics } from '@/components/intent/UsageMetrics';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function aggregateStageStatus(rows: IntentStageRow[]): Record<string, StageState> {
  const byStage = new Map<string, StageState[]>();
  for (const row of rows) {
    const list = byStage.get(row.stageId) ?? [];
    list.push(row.state);
    byStage.set(row.stageId, list);
  }
  const result: Record<string, StageState> = {};
  for (const [stageId, states] of byStage) {
    if (states.includes('FAILED')) {
      result[stageId] = 'FAILED';
    } else if (states.includes('RUNNING')) {
      result[stageId] = 'RUNNING';
    } else if (states.includes('WAITING_FOR_HUMAN')) {
      result[stageId] = 'WAITING_FOR_HUMAN';
    } else if (states.every((s) => s === 'SUCCEEDED' || s === 'SKIPPED')) {
      result[stageId] = 'SUCCEEDED';
    } else {
      result[stageId] = 'PENDING';
    }
  }
  return result;
}

function filterCompiledToScope(
  compiled: CompiledWorkflow,
  stageRows: IntentStageRow[],
): CompiledWorkflow {
  const ids = new Set(stageRows.map((r) => r.stageId));
  return {
    ...compiled,
    graph: {
      ...compiled.graph,
      nodes: compiled.graph.nodes.filter((n) => ids.has(n.stageId)),
      edges: compiled.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    },
  };
}

export default function IntentObservabilityPage() {
  const {
    projectId,
    intentId,
    detail,
    compiled,
    stageRows,
    loading,
    error,
    phaseNameOf,
    initializationPhasePaths,
  } = useIntent();
  const navigate = useNavigate();

  const phases = useMemo(
    () => groupByPhase(stageRows).filter((g) => !initializationPhasePaths.has(g.phase)),
    [stageRows, initializationPhasePaths],
  );

  const stageStatus = useMemo(() => aggregateStageStatus(stageRows), [stageRows]);

  const scopeCompiled = useMemo(() => {
    if (!compiled) return null;
    return filterCompiledToScope(compiled, stageRows);
  }, [compiled, stageRows]);

  const { totals, cost } = useMemo(() => {
    if (!detail || detail.metrics.length === 0) return { totals: {}, cost: null };
    return { totals: aggregateMetrics(detail.metrics), cost: summarizeCost(detail.metrics) };
  }, [detail]);

  if (loading && !detail) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-[300px] rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 text-sm text-destructive">
        {error ?? 'Intent not found'}
      </div>
    );
  }

  const intent = detail.intent;
  const isActive = intent.status === 'RUNNING' || intent.status === 'WAITING';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => navigate(`/project/${projectId}/intent/${intentId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Workbench
          </Button>
          <div className="h-5 w-px bg-border shrink-0" />
          <h1 className="text-lg font-bold tracking-tight truncate">{intent.title || 'Intent'}</h1>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {intent.status}
          </Badge>
          {isActive && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse"
              aria-label="live"
            />
          )}
          {intent.scope && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {intent.scope}
            </Badge>
          )}
        </div>

        {/* Phase progress strip */}
        {phases.length > 0 && (
          <Card>
            <CardContent className="py-4 px-5">
              <div className="flex items-stretch gap-3 overflow-x-auto">
                {phases.map((group) => {
                  const icon = derivePhaseState(group);
                  const pct = group.total > 0 ? Math.round((group.done / group.total) * 100) : 0;
                  return (
                    <div
                      key={group.phase}
                      className={cn(
                        'flex flex-col gap-1.5 min-w-[120px] flex-1 rounded-md px-3 py-2',
                        icon === 'done' && 'bg-agent-success/10',
                        icon === 'active' && 'bg-agent-running/10',
                        icon === 'pending' && 'bg-muted/50',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        {icon === 'done' && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-agent-success shrink-0" />
                        )}
                        {icon === 'active' && (
                          <span className="h-2 w-2 rounded-full bg-agent-running animate-pulse shrink-0" />
                        )}
                        {icon === 'pending' && (
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                        )}
                        <span className="text-xs font-medium truncate">
                          {phaseNameOf(group.phase)}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {group.done}/{group.total} done
                      </span>
                      <Progress
                        value={pct}
                        className={cn(
                          'h-1',
                          icon === 'done' && '[&>div]:bg-agent-success',
                          icon === 'active' && '[&>div]:bg-agent-running',
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Scope graph */}
        {scopeCompiled && scopeCompiled.graph.nodes.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Execution graph</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkflowScopeGraph
                compiled={scopeCompiled}
                activeScope={intent.scope}
                hideScopeSelector
                readOnly
                stageStatus={stageStatus}
              />
            </CardContent>
          </Card>
        )}

        {/* Usage & cost */}
        {detail.metrics.length > 0 && Object.keys(totals).length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Usage &amp; cost</CardTitle>
            </CardHeader>
            <CardContent>
              <UsageMetrics metrics={totals} cost={cost} contextLabel="Peak context window" />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
