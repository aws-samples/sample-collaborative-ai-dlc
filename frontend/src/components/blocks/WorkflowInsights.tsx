import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
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
  // Toggle a single (skill, scope) cell EXECUTE↔SKIP.
  onToggleCell: (skillId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => void;
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
  const placedSkillIds = workflow.placements.map((p) => p.skillId);
  const refScopeIds = new Set(scopeIds);
  const availableScopes = scopeLib.filter((s) => !refScopeIds.has(s.id));

  // Cell state from the compiled grid (server-derived, SKIP by default).
  const cell = (skillId: string, scopeId: string): 'EXECUTE' | 'SKIP' =>
    compiled?.scopeGrid?.[scopeId]?.[skillId] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';

  const rollup = compiled?.autonomy.rollup;
  const graph = compiled?.graph;

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
              Place skills to see the autonomy profile.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Scope × skill matrix */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Scope × skill matrix</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Toggle EXECUTE/SKIP per skill per scope. Columns are the scopes available in this
            workflow.
          </p>
          {placedSkillIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">Place skills to populate the matrix.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm border-collapse">
                <thead>
                  <tr>
                    <th className="text-left font-medium p-2 sticky left-0 bg-background">Skill</th>
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
                  {placedSkillIds.map((skillId) => {
                    const level = compiled?.autonomy.perSkill[skillId];
                    return (
                      <tr key={skillId} className="border-t">
                        <td className="p-2 font-medium sticky left-0 bg-background">{skillId}</td>
                        <td className="p-2 text-center">
                          {level && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <span className={cn('h-2 w-2 rounded-full', AUTONOMY[level].dot)} />
                              {AUTONOMY[level].label}
                            </span>
                          )}
                        </td>
                        {scopeIds.map((scopeId) => {
                          const state = cell(skillId, scopeId);
                          return (
                            <td key={scopeId} className="p-2 text-center">
                              <button
                                type="button"
                                disabled={readOnly}
                                onClick={() =>
                                  onToggleCell(
                                    skillId,
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
            {graph.acyclic &&
            graph.danglingConsumes.length === 0 &&
            graph.orphanProduces.length === 0 ? (
              <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckIcon /> No cycles, no orphan artifacts.
              </p>
            ) : (
              <ul className="space-y-1">
                {!graph.acyclic && (
                  <li className="flex items-center gap-2 text-rose-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Cycle: {graph.cycles.join(' → ')}
                  </li>
                )}
                {graph.danglingConsumes.map((d) => (
                  <li
                    key={`${d.skillId}-${d.artifact}`}
                    className="flex items-center gap-2 text-rose-600"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{d.skillId}</strong> consumes <strong>{d.artifact}</strong> — no
                    producer.
                  </li>
                ))}
                {graph.orphanProduces.map((o) => (
                  <li key={o.artifact} className="flex items-center gap-2 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{o.artifact}</strong> produced but never consumed.
                  </li>
                ))}
              </ul>
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
