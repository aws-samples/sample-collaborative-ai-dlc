import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AUTONOMY_STYLES } from '@/lib/autonomy';
import type { Workflow, CompiledWorkflow } from '@/services/workflows';

interface Props {
  workflow: Workflow;
  compiled: CompiledWorkflow | null;
  readOnly: boolean;
}

export function WorkflowInsights({ compiled }: Props) {
  const rollup = compiled?.autonomy.rollup;
  const graph = compiled?.graph;
  const [showTerminal, setShowTerminal] = useState(false);

  const orphans = graph?.orphanProduces ?? [];
  const terminalOutputs = orphans.filter((o) => o.terminal === true);
  const unwiredProduces = orphans.filter((o) => o.terminal !== true);
  const unknownArtifacts = graph?.unknownArtifacts ?? [];

  const isClean =
    graph != null &&
    graph.acyclic &&
    graph.danglingConsumes.length === 0 &&
    unknownArtifacts.length === 0 &&
    unwiredProduces.length === 0;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Autonomy profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rollup && rollup.total > 0 ? (
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1.5">
                <span
                  className={cn('h-2.5 w-2.5 rounded-full', AUTONOMY_STYLES['self-halting'].dot)}
                />
                {rollup.selfHalting} self-halting
              </span>
              <span className="flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rounded-full', AUTONOMY_STYLES['mixed'].dot)} />
                {rollup.mixed} mixed
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn('h-2.5 w-2.5 rounded-full', AUTONOMY_STYLES['human-gated'].dot)}
                />
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

                {unwiredProduces.map((o) => (
                  <li key={o.artifact} className="flex items-center gap-2 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <strong>{o.artifact}</strong> produced but never consumed.
                  </li>
                ))}

                {isClean && (
                  <li className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                    <CheckIcon /> No cycles, no dangling consumes, no unwired producers.
                  </li>
                )}
              </ul>
            )}

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
