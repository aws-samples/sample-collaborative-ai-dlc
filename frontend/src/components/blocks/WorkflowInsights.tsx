import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, Trash2, AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Workflow, CompiledWorkflow, AutonomyLevel } from '@/services/workflows';
import type { Block } from '@/services/blocks';

interface Props {
  workflow: Workflow;
  scopeLib: Block[];
  compiled: CompiledWorkflow | null;
  readOnly: boolean;
  onAddScope: (scopeId: string) => void;
  onRemoveScope: (scopeId: string) => void;
  // Toggle a single (stage, scope) cell EXECUTE↔SKIP.
  onToggleCell: (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => void;
}

const AUTONOMY: Record<AutonomyLevel, { dot: string; label: string }> = {
  'self-halting': { dot: 'bg-emerald-500', label: 'self-halting' },
  mixed: { dot: 'bg-amber-500', label: 'mixed' },
  'human-gated': { dot: 'bg-rose-500', label: 'human-gated' },
};

export function WorkflowInsights({
  workflow,
  scopeLib,
  compiled,
  readOnly,
  onAddScope,
  onRemoveScope,
  onToggleCell,
}: Props) {
  const scopeIds = workflow.scopeRefs.map((s) => s.scopeId);
  const placedStageIds = workflow.placements.map((p) => p.stageId);
  const refScopeIds = new Set(scopeIds);
  const availableScopes = scopeLib.filter((s) => !refScopeIds.has(s.id));

  // Cell state from the compiled grid (server-derived, SKIP by default).
  const cell = (stageId: string, scopeId: string): 'EXECUTE' | 'SKIP' =>
    compiled?.scopeGrid?.[scopeId]?.[stageId] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';

  const rollup = compiled?.autonomy.rollup;
  const graph = compiled?.graph;
  const [showTerminal, setShowTerminal] = useState(false);

  // Split orphan-produces into deliberate end-of-flow outputs (registered
  // terminal artifacts — quiet) and genuine unwired producers (warn). A null
  // terminal flag (no registry) is treated as a warning, to be safe.
  const orphans = graph?.orphanProduces ?? [];
  const terminalOutputs = orphans.filter((o) => o.terminal === true);
  const unwiredProduces = orphans.filter((o) => o.terminal !== true);
  const unknownArtifacts = graph?.unknownArtifacts ?? [];

  // The workflow is "clean" when there are no hard errors (cycles, dangling
  // consumes, unknown/typo names) and no unwired producers. Terminal outputs
  // alone are by design and do not count against a clean bill of health.
  const isClean =
    graph != null &&
    graph.acyclic &&
    graph.danglingConsumes.length === 0 &&
    unknownArtifacts.length === 0 &&
    unwiredProduces.length === 0;

  return (
    <>
      {/* Autonomy profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Autonomy profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rollup && rollup.total > 0 ? (
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                {rollup.selfHalting} self-halting
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                {rollup.mixed} mixed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                {rollup.humanGated} human-gated
              </span>
              <span className="text-muted-foreground ml-auto">
                {rollup.selfHalting}/{rollup.total} can run without a human
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Place stages to see the autonomy profile.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Scope × stage matrix */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Scope × stage matrix</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Toggle EXECUTE/SKIP per stage per scope. Columns are the scopes available in this
            workflow.
          </p>
          {placedStageIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">Place stages to populate the matrix.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm border-collapse">
                <thead>
                  <tr>
                    <th className="text-left font-medium p-2 sticky left-0 bg-background">Stage</th>
                    <th className="p-2 text-center font-medium">
                      <span className="text-muted-foreground/60">⬤</span> autonomy
                    </th>
                    {scopeIds.map((s) => (
                      <th key={s} className="p-2 text-center font-medium whitespace-nowrap">
                        {s}
                        {!readOnly && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 ml-1 align-middle"
                            onClick={() => onRemoveScope(s)}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {placedStageIds.map((stageId) => {
                    const level = compiled?.autonomy.perStage[stageId];
                    return (
                      <tr key={stageId} className="border-t">
                        <td className="p-2 font-medium sticky left-0 bg-background">{stageId}</td>
                        <td className="p-2 text-center">
                          {level && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <span className={cn('h-2 w-2 rounded-full', AUTONOMY[level].dot)} />
                              {AUTONOMY[level].label}
                            </span>
                          )}
                        </td>
                        {scopeIds.map((scopeId) => {
                          const state = cell(stageId, scopeId);
                          return (
                            <td key={scopeId} className="p-2 text-center">
                              <button
                                type="button"
                                disabled={readOnly}
                                onClick={() =>
                                  onToggleCell(
                                    stageId,
                                    scopeId,
                                    state === 'EXECUTE' ? 'SKIP' : 'EXECUTE',
                                  )
                                }
                                className={cn(
                                  'h-6 w-12 rounded text-[10px] font-medium transition-colors',
                                  state === 'EXECUTE'
                                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                    : 'bg-muted text-muted-foreground',
                                  !readOnly && 'hover:opacity-80',
                                )}
                              >
                                {state === 'EXECUTE' ? 'EXEC' : 'SKIP'}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!readOnly && availableScopes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Add scope:</span>
              {availableScopes.map((s) => (
                <Button
                  key={s.id}
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => onAddScope(s.id)}
                >
                  <Plus className="h-3 w-3" />
                  {s.name}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Validation */}
      {graph && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Validation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {isClean && terminalOutputs.length === 0 ? (
              <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckIcon /> No cycles, no orphan artifacts.
              </p>
            ) : (
              <ul className="space-y-1">
                {/* Errors (rose): cycles, dangling consumes, unknown/typo names. */}
                {!graph.acyclic && (
                  <li className="flex items-center gap-2 text-rose-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Cycle: {graph.cycles.join(' → ')}
                  </li>
                )}
                {graph.danglingConsumes.map((d) => (
                  <li
                    key={`${d.stageId}-${d.artifact}`}
                    className="flex items-center gap-2 text-rose-600"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{d.stageId}</strong> consumes <strong>{d.artifact}</strong> — no
                    producer.
                  </li>
                ))}
                {unknownArtifacts.map((u) => (
                  <li
                    key={`${u.stageId}-${u.artifact}-${u.role}`}
                    className="flex items-center gap-2 text-rose-600"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{u.stageId}</strong> {u.role} <strong>{u.artifact}</strong> — not in the
                    artifact registry (typo?).
                  </li>
                ))}

                {/* Warnings (amber): genuine unwired producers only. */}
                {unwiredProduces.map((o) => (
                  <li key={o.artifact} className="flex items-center gap-2 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{o.artifact}</strong> produced but never consumed.
                  </li>
                ))}

                {/* A clean bill of health when only terminal outputs remain. */}
                {isClean && (
                  <li className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                    <CheckIcon /> No cycles, no dangling consumes, no unwired producers.
                  </li>
                )}
              </ul>
            )}

            {/* Terminal outputs: deliberate end-of-flow artifacts — collapsed. */}
            {terminalOutputs.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowTerminal((v) => !v)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    className={cn('h-3 w-3 transition-transform', showTerminal && 'rotate-90')}
                  />
                  {terminalOutputs.length} terminal output
                  {terminalOutputs.length === 1 ? '' : 's'} (end-of-flow artifacts, not consumed by
                  design)
                </button>
                {showTerminal && (
                  <ul className="mt-1 ml-4 flex flex-wrap gap-x-3 gap-y-0.5">
                    {terminalOutputs.map((o) => (
                      <li key={o.artifact} className="text-xs text-muted-foreground">
                        {o.artifact}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function CheckIcon() {
  return <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />;
}
