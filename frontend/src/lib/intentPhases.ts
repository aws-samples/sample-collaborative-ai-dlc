import type { IntentStageRow } from '@/contexts/IntentContext';

export interface PhaseGroup {
  phase: string;
  rows: IntentStageRow[];
  done: number;
  total: number;
}

export function groupByPhase(rows: IntentStageRow[]): PhaseGroup[] {
  const map = new Map<string, IntentStageRow[]>();
  for (const row of rows) {
    const key = row.phase ?? '(ungrouped)';
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  const groups: PhaseGroup[] = [];
  for (const [phase, phaseRows] of map) {
    const done = phaseRows.filter((r) => r.state === 'SUCCEEDED' || r.state === 'SKIPPED').length;
    groups.push({ phase, rows: phaseRows, done, total: phaseRows.length });
  }
  return groups;
}

export type PhaseState = 'done' | 'active' | 'pending';

export function derivePhaseState(group: PhaseGroup, currentPhase?: string | null): PhaseState {
  if (group.done === group.total && group.total > 0) return 'done';
  if (
    group.rows.some((r) => r.state === 'RUNNING' || r.state === 'WAITING_FOR_HUMAN') ||
    (currentPhase != null && group.phase === currentPhase)
  ) {
    return 'active';
  }
  return 'pending';
}
