// Stage grid editor — the per-intent EXECUTE/SKIP grid, phase-grouped. Every
// toggle flows through the SHARED draft selection (collaborative LWW state);
// the caller re-validates the resulting grid server-side (validate-grid) and
// renders the authoritative summary/errors. Initialization stages are locked
// EXECUTE — the resolver hard-rejects grids without them, so the UI never
// offers the footgun.

import { Label } from '@/components/ui/label';
import { Lock } from 'lucide-react';

export interface GridStage {
  stageId: string;
  /** Dotted-numeric phase path ('01', '02', …) — grouping + sort key. */
  phasePath: string | null;
  order: number;
}

interface Props {
  stages: GridStage[];
  /** phasePath → display name (from the workflow's phase tree). */
  phaseNames: Record<string, string>;
  /** The effective grid (composed grid, or the selected scope's projection). */
  grid: Record<string, 'EXECUTE' | 'SKIP'>;
  /** Stage ids locked to EXECUTE (initialization). */
  lockedStageIds: Set<string>;
  disabled?: boolean;
  onToggle: (stageId: string) => void;
}

export function StageGridEditor({
  stages,
  phaseNames,
  grid,
  lockedStageIds,
  disabled,
  onToggle,
}: Props) {
  const byPhase = new Map<string, GridStage[]>();
  for (const s of stages.toSorted(
    (a, b) =>
      (a.phasePath ?? '').localeCompare(b.phasePath ?? '') ||
      a.order - b.order ||
      a.stageId.localeCompare(b.stageId),
  )) {
    const key = s.phasePath ?? '';
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)!.push(s);
  }

  return (
    <div className="space-y-3" data-testid="stage-grid-editor">
      {[...byPhase.entries()].map(([phasePath, phaseStages]) => (
        <div key={phasePath || 'unphased'}>
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {phaseNames[phasePath] ?? phasePath ?? 'Stages'}
          </Label>
          <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
            {phaseStages.map((s) => {
              const locked = lockedStageIds.has(s.stageId);
              const executed = locked || grid[s.stageId] === 'EXECUTE';
              return (
                <label
                  key={s.stageId}
                  className={`flex items-center gap-2 text-sm rounded-md border px-2.5 py-1.5 ${
                    locked || disabled ? 'opacity-70' : 'cursor-pointer hover:bg-muted/50'
                  }`}
                  data-testid={`grid-stage-${s.stageId}`}
                >
                  <input
                    type="checkbox"
                    checked={executed}
                    disabled={locked || disabled}
                    onChange={() => onToggle(s.stageId)}
                    className="h-3.5 w-3.5"
                  />
                  <span className={executed ? '' : 'line-through text-muted-foreground'}>
                    {s.stageId}
                  </span>
                  {locked && (
                    <span title="Initialization stages always run">
                      <Lock className="ml-auto h-3 w-3 text-muted-foreground" />
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
