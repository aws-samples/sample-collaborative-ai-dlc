import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntent, stageRowKey, type IntentStageRow } from '@/contexts/IntentContext';
import type { StageState } from '@/services/intents';
import type { CompiledWorkflow } from '@/services/workflows';
import { aggregateMetrics, summarizeCost } from '@/lib/metricAggregation';
import { WorkflowScopeGraph, UnitLaneGraph, type UnitLanesInput } from '@/components/v2';
import { UsageMetrics } from '@/components/intent/UsageMetrics';
import { IntentPhaseDiagram } from '@/components/intent/IntentPhaseDiagram';
import { IntentStageList } from '@/components/intent/IntentStageList';
import { StageDetail } from '@/components/intent/StageDetail';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';

type ObsView = 'diagram' | 'graph' | 'list';
const VALID_VIEWS: ReadonlySet<ObsView> = new Set(['diagram', 'graph', 'list']);
const VIEW_STORAGE_KEY = 'aidlc-intent-obs-view';

function readStoredView(): ObsView {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return stored && VALID_VIEWS.has(stored as ObsView) ? (stored as ObsView) : 'diagram';
  } catch {
    return 'diagram';
  }
}

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
  initNodeIds: Set<string>,
): CompiledWorkflow {
  const ids = new Set(stageRows.map((r) => r.stageId));
  return {
    ...compiled,
    graph: {
      ...compiled.graph,
      nodes: compiled.graph.nodes.filter((n) => ids.has(n.stageId) && !initNodeIds.has(n.stageId)),
      edges: compiled.graph.edges.filter(
        (e) =>
          ids.has(e.from) && ids.has(e.to) && !initNodeIds.has(e.from) && !initNodeIds.has(e.to),
      ),
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
    workflowPhases,
    phaseNameOf,
    initializationPhasePaths,
    currentPhasePath,
    selectedStageId,
    setSelectedStageId,
  } = useIntent();
  const navigate = useNavigate();
  const { project } = useProjectCache(projectId);
  const [view, setView] = useState<ObsView>(readStoredView);

  const handleViewChange = useCallback(
    (v: string) => {
      if (v && VALID_VIEWS.has(v as ObsView)) {
        const next = v as ObsView;
        setView(next);
        setSelectedStageId(null);
        try {
          localStorage.setItem(VIEW_STORAGE_KEY, next);
        } catch {}
      }
    },
    [setSelectedStageId],
  );

  const handleGraphStageClick = useCallback(
    (stageId: string, rowKey?: string | null) => {
      // Per-unit lane nodes pass the exact stageRowKey; plain stage nodes don't,
      // so fall back to the first row matching the stageId.
      const key =
        rowKey ??
        (() => {
          const matchingRow = stageRows.find((r) => r.stageId === stageId);
          return matchingRow ? stageRowKey(matchingRow) : null;
        })();
      if (!key) return;
      setSelectedStageId((prev) => (prev === key ? null : key));
    },
    [stageRows, setSelectedStageId],
  );

  const selectedRow = useMemo(() => {
    if (!selectedStageId || view === 'list') return null;
    return stageRows.find((r) => stageRowKey(r) === selectedStageId) ?? null;
  }, [selectedStageId, stageRows, view]);

  const stageStatus = useMemo(() => aggregateStageStatus(stageRows), [stageRows]);

  const initNodeIds = useMemo<Set<string>>(() => {
    if (!compiled) return new Set();
    return new Set(
      compiled.graph.nodes
        .filter((n) => n.phasePath && initializationPhasePaths.has(n.phasePath))
        .map((n) => n.stageId),
    );
  }, [compiled, initializationPhasePaths]);

  const filteredStageStatus = useMemo(() => {
    if (!compiled) return stageStatus;
    const result: Record<string, StageState> = {};
    for (const [id, state] of Object.entries(stageStatus)) {
      if (!initNodeIds.has(id)) result[id] = state;
    }
    return result;
  }, [stageStatus, compiled, initNodeIds]);

  const scopeCompiled = useMemo(() => {
    if (!compiled) return null;
    return filterCompiledToScope(compiled, stageRows, initNodeIds);
  }, [compiled, stageRows, initNodeIds]);

  const graphPhases = useMemo(() => {
    if (!workflowPhases) return undefined;
    return workflowPhases
      .filter((p) => !initializationPhasePaths.has(p.path))
      .map((p) => ({ path: p.path, name: phaseNameOf(p.path) }));
  }, [workflowPhases, initializationPhasePaths, phaseNameOf]);

  // Build the per-unit lane grid for the graph from `scopeCompiled` (the scoped
  // graph the component renders) overlaid with live stageRows.
  const unitLanes = useMemo<UnitLanesInput | null>(() => {
    const plan = detail?.unitPlan;
    if (!scopeCompiled || !plan || plan.unitCount === 0) return null;

    // The whole fan-out block is one section, keyed by forEach + order (node.section
    // is unreliable — assigned in placement-array order upstream).
    const sectionNodes = scopeCompiled.graph.nodes
      .filter((n) => n.forEach === 'unit-of-work')
      .toSorted((a, b) => a.order - b.order);
    const sectionStageIds = sectionNodes.map((n) => n.stageId);
    if (sectionStageIds.length === 0) return null;
    const conditional = new Set(
      sectionNodes.filter((n) => n.execution === 'CONDITIONAL').map((n) => n.stageId),
    );

    const liveByKey = new Map<string, IntentStageRow>();
    for (const r of stageRows) {
      if (r.unitSlug && sectionStageIds.includes(r.stageId)) {
        liveByKey.set(`${r.stageId}::${r.unitSlug}`, r);
      }
    }

    const unitState = new Map((detail?.units ?? []).map((u) => [u.slug, u.state as string | null]));
    // Wave order from batches; fall back to plan.units when batches is absent.
    const fromBatches = (plan.batches ?? []).flat();
    const orderedSlugs =
      fromBatches.length > 0 ? fromBatches : (plan.units ?? []).map((u) => u.slug);
    const units = orderedSlugs.map((slug) => {
      const skips = new Set(plan.skipMatrix?.[slug] ?? []);
      const stages = sectionStageIds.map((stageId) => {
        const live = liveByKey.get(`${stageId}::${slug}`);
        if (live) {
          return {
            stageId,
            stageInstanceId: live.stageInstanceId,
            state: live.state,
            synthesized: false,
            rowKey: stageRowKey(live),
          };
        }
        const skipped = skips.has(stageId) && conditional.has(stageId);
        return {
          stageId,
          stageInstanceId: null,
          state: (skipped ? 'SKIPPED' : 'PENDING') as StageState,
          synthesized: true,
          rowKey: null,
        };
      });
      return { slug, state: unitState.get(slug) ?? null, stages };
    });

    return { units, sectionStageIds };
  }, [scopeCompiled, detail?.unitPlan, detail?.units, stageRows]);

  const { totals, cost } = useMemo(() => {
    if (!detail || detail.metrics.length === 0) return { totals: {}, cost: null };
    return { totals: aggregateMetrics(detail.metrics), cost: summarizeCost(detail.metrics) };
  }, [detail]);

  const runningCount = useMemo(
    () => stageRows.filter((r) => r.state === 'RUNNING').length,
    [stageRows],
  );

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
        {/* ── HEADER (v1 drill-down mirror) ──────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate('/observability')}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Back to observability"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h1 className="text-xl font-bold tracking-tight text-foreground truncate max-w-[480px]">
              {intent.title}
            </h1>
            <span className="text-xs text-muted-foreground">Space: {project?.name ?? 'Space'}</span>
            <Badge variant="outline" className="text-[10px] h-5 bg-muted/40">
              {currentPhasePath ? phaseNameOf(currentPhasePath) : intent.status}
            </Badge>
            {isActive && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
                Live
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-7"
            onClick={() => navigate(`/project/${projectId}/intent/${intentId}`)}
          >
            <ExternalLink className="h-3 w-3" />
            Open in workbench
          </Button>
        </div>

        {/* ── USAGE & COST + RUNNING AGENTS ──────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Usage &amp; activity</CardTitle>
              {runningCount > 0 ? (
                <Badge
                  variant="outline"
                  className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
                  {runningCount} active
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                  0 active
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {Object.keys(totals).length > 0 ? (
              <UsageMetrics metrics={totals} cost={cost} contextLabel="Peak context window" />
            ) : (
              <span className="text-xs text-muted-foreground">No usage yet</span>
            )}
          </CardContent>
        </Card>

        {/* ── EXECUTION PROGRESS (toggle: Diagram / Graph / List) ──── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Execution progress</CardTitle>
              <ToggleGroup
                type="single"
                aria-label="Execution view"
                value={view}
                onValueChange={handleViewChange}
                className="gap-0.5"
              >
                <ToggleGroupItem value="diagram" className="h-6 px-2 text-[11px]">
                  Diagram
                </ToggleGroupItem>
                <ToggleGroupItem value="graph" className="h-6 px-2 text-[11px]">
                  Graph
                </ToggleGroupItem>
                <ToggleGroupItem value="list" className="h-6 px-2 text-[11px]">
                  List
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </CardHeader>
          <CardContent>
            {view === 'diagram' && <IntentPhaseDiagram />}
            {view === 'graph' &&
              scopeCompiled &&
              scopeCompiled.graph.nodes.length > 0 &&
              // Lanes need the phase list (loaded separately) to place the fan-out band.
              (unitLanes && graphPhases ? (
                <UnitLaneGraph
                  compiled={scopeCompiled}
                  phases={graphPhases}
                  unitLanes={unitLanes}
                  stageStatus={filteredStageStatus}
                  onStageClick={handleGraphStageClick}
                />
              ) : (
                <WorkflowScopeGraph
                  compiled={scopeCompiled}
                  activeScope={intent.scope}
                  phases={graphPhases}
                  hideScopeSelector
                  readOnly
                  stageStatus={filteredStageStatus}
                  onStageClick={handleGraphStageClick}
                />
              ))}
            {view === 'graph' && (!scopeCompiled || scopeCompiled.graph.nodes.length === 0) && (
              <p className="text-sm text-muted-foreground">No graph data yet.</p>
            )}
            {view === 'list' && <IntentStageList />}
          </CardContent>
          {selectedRow && view !== 'list' && (
            <CardContent className="border-t pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {selectedRow.stageId}
                  {selectedRow.unitSlug && ` · ${selectedRow.unitSlug}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  aria-label="Close stage detail"
                  onClick={() => setSelectedStageId(null)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <StageDetail row={selectedRow} />
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
